import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { initTheme } from '@earendil-works/pi-coding-agent';
import { getKeybindings } from '@earendil-works/pi-tui';
import { PinoteUI } from '../extension/ui.ts';
import type { NativeView } from '../extension/protocol.ts';

test('only acknowledged task acceptance renames the originating Kitty tab, best effort', async () => {
  initTheme('dark', false);
  const original = { ...process.env };
  const agent = mkdtempSync(join(tmpdir(), 'pinote-kitty-title-')); // Default settings: rename only.
  Object.assign(process.env, { KITTY_WINDOW_ID: '42', KITTY_LISTEN_ON: 'unix:/tmp/isolated-kitty-test', PI_CODING_AGENT_DIR: agent });
  delete process.env.SSH_CONNECTION;
  delete process.env.SSH_TTY;
  const signal = new AbortController().signal;
  const calls: any[][] = [], notices: string[] = [];
  let failAction = false, failExec = false;
  const unselected: NativeView = { version: 1, title: 'Pinote', revision: '1', state: { selectedId: null }, controls: [] };
  const selected: NativeView = { ...unselected, state: { selectedId: 7 }, footer: [
    { action: 'preview', text: '[pinote] Fix 日本語 \x1b]2;injected\x07title\nextra\u202e' },
  ] };
  let next = unselected;
  const session: any = { view: unselected, signal, current: () => () => true,
    action: async () => { if (failAction) throw new Error('Uncertain write'); session.view = next; return {}; },
    refresh: async () => {},
  };
  const ui = new PinoteUI({ exec: async (...args: any[]) => {
    calls.push(args);
    if (failExec) throw new Error('Private transport error');
    return { code: 0, stdout: '', stderr: '' };
  } } as any, session, () => 'keep-open');
  const ctx: any = { mode: 'tui', isIdle: () => true, ui: { notify: (text: string) => notices.push(text),
    select: async (_title: string, choices: string[]) => { assert.deepEqual(choices, ['Cancel', 'Complete task']); return 'Complete task'; },
    custom: async (factory: any) => {
      let component: any;
      try { return await new Promise((resolve) => {
        component = factory({ terminal: { rows: 36, columns: 100 }, requestRender() {} },
          { fg: (_color: string, text: string) => text }, getKeybindings(), resolve);
        component.render(100);
      }); } finally { component?.dispose(); }
    },
  } };
  const dispatch = (id: string) => ui.dispatch(ctx, session.view, { id, kind: 'action', label: id });
  try {
    await dispatch('proposal:dismiss');
    assert.equal(calls.length, 0);
    next = selected;
    failAction = true;
    assert.equal(await dispatch('proposal:accept'), false);
    assert.equal(calls.length, 0, 'Uncertain acceptance must not rename');
    notices.length = 0;
    failAction = false;
    assert.equal(await dispatch('proposal:accept'), true);
    assert.deepEqual(calls[0], ['kitty', ['@', '--to', process.env.KITTY_LISTEN_ON, 'set-tab-title', '--match=window_id:42', '--', '[pinote] Fix 日本語 title extra'], { signal, timeout: 1500 }]);
    await dispatch('preview');
    next = unselected;
    await dispatch('clear');
    await dispatch('done');
    assert.equal(calls.length, 1, 'Preview, deselection and completion must leave the title alone');
    next = selected;
    failExec = true;
    assert.equal(await dispatch('select:7'), true, 'Kitty failures must not fail task acceptance');
    assert.equal(session.view.state.selectedId, 7);
    assert.deepEqual(notices, ['Pinote task selected, but the Kitty tab could not be renamed.']);
    failExec = false;
    for (const overrides of [{ KITTY_WINDOW_ID: '' }, { KITTY_WINDOW_ID: 'all' }, { KITTY_LISTEN_ON: '' }, { SSH_CONNECTION: 'remote' }]) {
      Object.assign(process.env, { KITTY_WINDOW_ID: '42', KITTY_LISTEN_ON: 'unix:/tmp/isolated-kitty-test', SSH_CONNECTION: '' }, overrides);
      session.view = unselected;
      assert.equal(await dispatch('add'), true);
    }
    assert.equal(calls.length, 2, 'Non-Kitty, invalid targets and SSH must not control tabs');
  } finally {
    rmSync(agent, { recursive: true, force: true });
    for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key];
    Object.assign(process.env, original);
  }
});

test('one task per Kitty tab moves a pane beside a tab showing another task, then names it', async () => {
  initTheme('dark', false);
  const original = { ...process.env };
  const agent = mkdtempSync(join(tmpdir(), 'pinote-kitty-tabs-'));
  Object.assign(process.env, { KITTY_WINDOW_ID: '42', KITTY_LISTEN_ON: 'unix:/tmp/isolated-kitty-test', PI_CODING_AGENT_DIR: agent });
  delete process.env.SSH_CONNECTION;
  delete process.env.SSH_TTY;
  const settings = (value: boolean) => writeFileSync(join(agent, 'pi-note.json'), JSON.stringify({ kittyOneTaskPerTab: value }));
  const signal = new AbortController().signal;
  const calls: string[][] = [], notices: string[] = [];
  // Another pane in this tab holds `other`; `active` is whether this pane is Kitty's active window. A later tab follows.
  let other: string | undefined = '3', active = true, failList = false, lostLaunch = false, timeouts = 0, marker: string | undefined, gate: Promise<void> | undefined;
  const unselected: NativeView = { version: 1, title: 'Pinote', revision: '1', state: { selectedId: null }, controls: [] };
  const selected = (id: number, text = `Task ${id}`): NativeView => ({ ...unselected, state: { selectedId: id }, footer: [{ action: 'preview', text }] });
  let next = unselected;
  const session: any = { view: unselected, signal, current: () => () => true,
    action: async () => { session.view = next; session.onChange(); return {}; }, refresh: async () => {} };
  const ui = new PinoteUI({ exec: async (_command: string, args: string[]) => {
    const command = args.slice(3).map((arg) => arg.replace(/pinote_placeholder=[0-9a-f-]{36}$/, 'pinote_placeholder=ID'));
    calls.push(command);
    if (command[0] === 'set-user-vars') {
      await gate;
      // Pi reports a timed-out command as killed, possibly with exit code 0.
      if (timeouts && timeouts--) return { code: 0, killed: true, stdout: '', stderr: '' };
      marker = command[2].split('=')[1];
    }
    if (command[0] === 'launch' && lostLaunch) return { code: 143, killed: true, stdout: '', stderr: '' };
    if (command[0] !== 'ls') return { code: 0, stdout: '', stderr: '' };
    if (failList) return { code: 1, stdout: '', stderr: 'denied' };
    return { code: 0, stderr: '', stdout: JSON.stringify([{ is_active: true, tabs: [
      { is_active: true, windows: [{ id: 42, is_active: active, user_vars: {} }, { id: 43, is_active: !active, user_vars: other === undefined ? {} : { pinote_task: other } }] },
      { is_active: false, windows: [{ id: 44, is_active: true, user_vars: { pinote_task: '5' } }] }] }]) };
  } } as any, session);
  const ctx: any = { mode: 'tui', isIdle: () => true, ui: { notify: (text: string) => notices.push(text), setWidget() {}, setStatus() {},
    theme: { fg: (_color: string, text: string) => text, italic: (text: string) => text, strikethrough: (text: string) => text },
    custom: async (factory: any) => {
      let component: any;
      try { return await new Promise((resolve) => {
        component = factory({ terminal: { rows: 36, columns: 100 }, requestRender() {} },
          { fg: (_color: string, text: string) => text }, getKeybindings(), resolve);
        component.render(100);
      }); } finally { component?.dispose(); }
    } } };
  ui.attach(ctx);
  const select = async (id: number, from = unselected, to = selected(id)) => {
    session.view = from; next = to; calls.length = 0; notices.length = 0;
    assert.equal(await ui.dispatch(ctx, session.view, { id: `select:${id}`, kind: 'action', label: 'Select' }), true);
    await ui.release(); // Settle queued marks before asserting.
    return calls.filter((call) => call[0] !== 'set-user-vars');
  };
  const marks = () => calls.filter((call) => call[0] === 'set-user-vars').map((call) => call.slice(2));
  const title = (id: number, name = `Task ${id}`) => ['set-tab-title', '--match=window_id:42', '--', name];
  // A tagged placeholder tab opens beside this one; this pane moves into it by ID, then the placeholder closes.
  const launch = (name: string) => ['launch', '--type=tab', '--location=after', '--match=window_id:42', '--var=pinote_placeholder=ID', `--tab-title=${name}`, 'sleep', '60'];
  const close = ['close-window', '--match=var:pinote_placeholder=ID'];
  const move = (name: string) => [launch(name), ['detach-window', '--match=id:42', '--target-tab=var:pinote_placeholder=ID'], close];
  try {
    settings(true);
    assert.deepEqual(await select(7), [['ls'], ...move('Task 7'), title(7)]);
    assert.deepEqual(marks(), [['pinote_task=7', 'pinote_pr'], ['pinote_task', 'pinote_pr']], 'The pane records its task, and release clears it');
    await select(16, unselected, { ...selected(16), prStatus: 'failing' });
    assert.deepEqual(marks(), [['pinote_task=16', 'pinote_pr=failing'], ['pinote_task', 'pinote_pr']], 'The pane records its PR status for the tab bar');
    const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
    session.view = { ...selected(16), prStatus: 'passing' }; calls.length = 0; session.onChange(); await settle();
    session.view = undefined; session.onChange(); await settle(); await ui.release();
    assert.deepEqual(marks(), [['pinote_task=16', 'pinote_pr=passing'], ['pinote_task=16', 'pinote_pr'], ['pinote_task', 'pinote_pr']], 'A lost view clears the PR status but keeps the task');
    assert.deepEqual(await select(7, selected(7)), [['ls'], ...move('Task 7'), title(7)], 'Reselecting the current task checks again');
    assert.deepEqual(await select(13, unselected, selected(13, '')), [['ls'], ...move('Task #13'), title(13, 'Task #13')], 'An empty title still moves');
    other = '8';
    assert.deepEqual(await select(8), [['ls'], title(8)], 'Panes on the same task share a tab');
    other = undefined;
    assert.deepEqual(await select(9), [['ls'], title(9)], 'Panes without a task do not count');
    other = '3'; active = false;
    assert.deepEqual(await select(10), [['ls']], 'An unfocused pane is neither moved nor allowed to rename the shared tab');
    assert.deepEqual(notices, ['Pinote task selected, but this pane was not focused, so it stays in its shared Kitty tab.']);
    active = true; lostLaunch = true;
    assert.deepEqual(await select(15), [['ls'], launch('Task 15'), close], 'A lost launch reply still closes any placeholder');
    assert.deepEqual(notices, ['Pinote task selected, but this pane could not be moved to its own Kitty tab.']);
    lostLaunch = false; failList = true;
    assert.deepEqual(await select(11), [['ls']]);
    assert.deepEqual(notices, ['Pinote task selected, but this pane could not be moved to its own Kitty tab.']);
    settings(false);
    assert.deepEqual(await select(12), [title(12)], 'Off keeps renaming the shared tab');
    // A timed-out marker update is retried on later changes, at most three times per value; release still clears.
    const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
    timeouts = 3; calls.length = 0;
    for (let i = 0; i < 5; i++) { session.onChange(); await tick(); }
    await ui.release();
    assert.deepEqual(marks(), Array.from({ length: 3 }, () => ['pinote_task=12', 'pinote_pr']).concat([['pinote_task', 'pinote_pr']]));
    assert.equal(marker, undefined);
    // Release during an in-flight update still clears it afterwards.
    let open = () => {};
    gate = new Promise<void>((resolve) => { open = resolve; });
    session.view = selected(14); session.onChange(); await tick();
    const released = ui.release(); open(); await released;
    assert.equal(marker, undefined, 'No stale marker after exit');
  } finally {
    ui.detach();
    rmSync(agent, { recursive: true, force: true });
    for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key];
    Object.assign(process.env, original);
  }
});

test('closing the pane runs Kitty once, after Pi exits, and only for a local Kitty pane running Pi', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pinote-kitty-close-')), log = join(dir, 'log');
  try {
    // `ls` reports this pane's foreground process: Pi itself (the caller), or another program such as tmux.
    writeFileSync(join(dir, 'kitty'), `#!/bin/sh
if [ "$4" = ls ]; then pid=$PPID; [ -n "$TEST_FOREIGN" ] && pid=1; printf '[{"tabs":[{"windows":[{"id":42,"foreground_processes":[{"pid":%s}]}]}]}]' "$pid"; exit; fi
printf '%s\\n' "$@" >> '${log}'\n`, { mode: 0o755 });
    const script = `const { execFile } = await import('node:child_process');
      const exec = (command, args, options) => new Promise((resolve) => execFile(command, args, options, (error, stdout) => resolve({ code: error ? 1 : 0, stdout, killed: false })));
      const { paneCloser } = await import(${JSON.stringify(new URL('../extension/kitty.ts', import.meta.url).href)});
      (await paneCloser(exec))?.(); (await paneCloser(exec))?.(); await new Promise((resolve) => setTimeout(resolve, 100));
      if ((await import('node:fs')).existsSync(${JSON.stringify(log)})) process.exitCode = 3;`;
    const run = (env: Record<string, string>) => execFileSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', script], {
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, KITTY_WINDOW_ID: '42', KITTY_LISTEN_ON: 'unix:/tmp/isolated-kitty-test', SSH_CONNECTION: '', SSH_TTY: '', TEST_FOREIGN: '', ...env } });
    run({}); // Exit code 3 would mean the pane closed before Pi finished.
    for (let i = 0; i < 100 && !existsSync(log); i++) await new Promise((resolve) => setTimeout(resolve, 20));
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(readFileSync(log, 'utf8').trim().split('\n'), ['@', '--to', 'unix:/tmp/isolated-kitty-test', 'close-window', '--match=id:42']);
    rmSync(log);
    run({ TEST_FOREIGN: '1' }); run({ SSH_CONNECTION: 'remote' }); run({ KITTY_LISTEN_ON: '' });
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(existsSync(log), false, 'Inherited Kitty variables, SSH and non-Kitty sessions never close a pane');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
