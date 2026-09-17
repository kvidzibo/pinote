#!/usr/bin/env bash
# Restart this checkout's running GUI, not other installations or desktop sessions.
set -euo pipefail
umask 077

if [[ ${1:-} == --help || ${1:-} == -h ]]; then
    printf 'Usage: %s\nRestart a running checkout pinote-gui on i3/X11; leave it stopped otherwise.\n' "$0"
    exit 0
fi
if (($#)); then
    printf 'Unexpected arguments. Use --help.\n' >&2
    exit 2
fi
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
if [[ ! -x "$root/.venv-gui/bin/python" || ! -f "$root/.venv-gui/bin/pinote-gui" ]]; then
    printf 'Missing .venv-gui; follow the GUI installation steps in README.md.\n' >&2
    exit 1
fi
exec "$root/.venv-gui/bin/python" - "$root" <<'PY'
import fcntl
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(sys.argv[1])
PYTHON = str(ROOT / '.venv-gui/bin/python')
LAUNCHERS = ([PYTHON, str(ROOT / '.venv-gui/bin/pinote-gui')],
             [PYTHON, '-m', 'pinote.gui'])


def run(*args):
    result = subprocess.run(args, capture_output=True, text=True, encoding='utf-8',
                            errors='replace', timeout=5)
    if result.returncode:
        raise RuntimeError(f'{args[0]} failed: {result.stderr.strip() or result.stdout.strip()}')
    return result.stdout


def wm(instruction):
    replies = json.loads(run('i3-msg', instruction))
    if not replies or not all(reply.get('success') for reply in replies):
        raise RuntimeError(f'i3 refused: {replies}')


def windows(node, workspace=None):
    if node.get('type') == 'workspace':
        workspace = node['name']
    if node.get('window_properties', {}).get('window_role') == 'pinote-reminders':
        yield node['window'], workspace
    for child in node.get('nodes', []) + node.get('floating_nodes', []):
        yield from windows(child, workspace)


def command_line(pid):
    arguments = Path(f'/proc/{pid}/cmdline').read_bytes().split(b'\0')
    return [os.fsdecode(arg) for arg in arguments if arg]


def identity(pid):
    try:
        fields = Path(f'/proc/{pid}/stat').read_text().rsplit(') ', 1)[1].split()
        return None if fields[0] == 'Z' else fields[19]  # Start time guards PID reuse.
    except FileNotFoundError:
        return None


def checkout_windows():
    matches = []
    # i3 includes hidden workspaces; never use xdotool's --onlyvisible here.
    for window_id, workspace in windows(json.loads(run('i3-msg', '-t', 'get_tree'))):
        pid = int(run('xdotool', 'getwindowpid', str(window_id)))
        try:
            if Path(f'/proc/{pid}').stat().st_uid == os.getuid() and command_line(pid) in LAUNCHERS:
                matches.append((pid, window_id, workspace))
        except FileNotFoundError:
            continue  # The window's process exited while enumerating it.
    return matches


def wait_for(check, message):
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        result = check()
        if result:
            return result
        time.sleep(0.1)
    raise RuntimeError(message)


def restart():
    if not os.environ.get('DISPLAY'):
        raise RuntimeError('Run this script in the i3/X11 desktop session.')
    for tool in ('i3-msg', 'xdotool'):
        if shutil.which(tool) is None:
            raise RuntimeError(f'Missing required command: {tool}')
    matches = checkout_windows()
    if not matches:
        print('No running checkout pinote-gui on this desktop; left stopped.')
        return
    if len(matches) != 1:
        raise RuntimeError('Multiple checkout GUIs are running; refusing an ambiguous restart.')
    pid, window_id, workspace = matches[0]
    if workspace is None or workspace == '__i3_scratch':
        raise RuntimeError('Move pinote out of the scratchpad before restarting.')
    original = identity(pid)
    argv = command_line(pid)
    env = dict(os.fsdecode(item).split('=', 1) for item in
               Path(f'/proc/{pid}/environ').read_bytes().split(b'\0') if b'=' in item)
    # Check interpreter/imports before closing the working GUI. No window or DB is opened.
    run(PYTHON, '-c', 'import pinote.gui.app')
    if original is None or identity(pid) != original or argv not in LAUNCHERS:
        raise RuntimeError('GUI changed before restart; nothing was closed.')
    wm(f'[id="{window_id}"] kill')  # Normal WM close drains already-submitted saves.
    wait_for(lambda: identity(pid) != original,
             'GUI did not close within 10 seconds; no forced termination attempted.')
    fd, log_path = tempfile.mkstemp(prefix='pinote-gui-restart-', suffix='.log')
    with os.fdopen(fd, 'w') as output:
        process = subprocess.Popen(argv, cwd=ROOT, env=env, stdout=output,
                                   stderr=subprocess.STDOUT, start_new_session=True)

    def reopened():
        if process.poll() is not None:
            raise RuntimeError(f'GUI exited with status {process.returncode}; see {log_path}')
        return next((match for match in checkout_windows() if match[0] == process.pid), None)

    _, new_window, new_workspace = wait_for(reopened, f'GUI did not reopen; see {log_path}')
    if new_workspace != workspace:
        destination = json.dumps(workspace, ensure_ascii=False)
        wm(f'[id="{new_window}"] move container to workspace {destination}')
    wait_for(lambda: (match := reopened()) and match[2] == workspace,
             f'GUI workspace was not restored; see {log_path}')
    time.sleep(1)
    final = reopened()  # Also catch an immediate startup failure after mapping.
    if final is None or final[2] != workspace:
        raise RuntimeError(f'GUI disappeared or changed workspace after opening; see {log_path}')
    print(f'Restarted pinote-gui: PID {pid} -> {process.pid}; workspace {workspace}.')
    print(f'Startup log: {log_path}')


try:
    # Serialize simultaneous agent/user restarts; this descriptor is not inherited by the GUI.
    with (ROOT / '.venv-gui/restart-pinote.lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError('A pinote restart is already in progress.') from None
        restart()
except (OSError, RuntimeError, ValueError, subprocess.TimeoutExpired) as exc:
    print(f'restart-pinote: {exc}', file=sys.stderr)
    raise SystemExit(1) from None
PY
