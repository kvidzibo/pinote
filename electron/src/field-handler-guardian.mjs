import { spawn } from 'node:child_process';
import { dirname } from 'node:path';

// The desktop launches this process as the leader of a new group. Keep the
// watcher in that group but never give it the parent's IPC file descriptor.
// It can close any of its own streams without disabling parent-death cleanup.
const [parent, deadline, handler] = process.argv.slice(2);
if (process.connected && handler) {
  const killGroup = () => process.kill(-process.pid, 'SIGKILL');
  process.on('disconnect', killGroup);
  const remaining = Number(deadline) - Date.now();
  if (process.ppid !== Number(parent) || !(remaining > 0)) killGroup();

  setTimeout(killGroup, remaining);
  const finish = status => {
    // Send the result separately from stdout/stderr, then kill any remaining
    // group members even if the watcher itself already exited successfully.
    if (!process.connected) return killGroup();
    process.send(status, killGroup);
  };
  let started = false;
  process.on('message', message => {
    if (message === 'cancel' || process.ppid !== Number(parent) || Date.now() >= Number(deadline)) return killGroup();
    if (started) return;
    started = true;
    try {
      // Preserve the watcher's environment without letting its Node/Electron
      // runtime options affect the guardian itself.
      const child = spawn(handler, [], { cwd: dirname(handler), stdio: 'inherit', env: message.env });
      child.once('error', error => finish(error.code ?? 'unknown'));
      child.once('exit', code => finish(code ?? 1));
    } catch {
      finish('unknown');
    }
  });
} else {
  process.exitCode = 1;
}
