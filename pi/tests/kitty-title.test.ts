import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
  process.env.KITTY_WINDOW_ID = '42';
  process.env.KITTY_LISTEN_ON = 'unix:/tmp/isolated-kitty-test';
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
  } } as any, session);
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
  // Another pane in this tab holds `other`; `active` is whether this pane is Kitty's active window.
  let other: string | undefined = '3', active = true, failList = false;
  const unselected: NativeView = { version: 1, title: 'Pinote', revision: '1', state: { selectedId: null }, controls: [] };
  const selected = (id: number): NativeView => ({ ...unselected, state: { selectedId: id }, footer: [{ action: 'preview', text: `Task ${id}` }] });
  let next = unselected;
  const session: any = { view: unselected, signal, current: () => () => true,
    action: async () => { session.view = next; session.onChange(); return {}; }, refresh: async () => {} };
  const ui = new PinoteUI({ exec: async (_command: string, args: string[]) => {
    const command = args.slice(3);
    calls.push(command);
    if (command[0] !== 'ls') return { code: 0, stdout: '', stderr: '' };
    if (failList) return { code: 1, stdout: '', stderr: 'denied' };
    return { code: 0, stderr: '', stdout: JSON.stringify([{ is_active: true, tabs: [{ is_active: true, windows: [
      { id: 42, is_active: active, user_vars: {} }, { id: 43, is_active: !active, user_vars: other === undefined ? {} : { pinote_task: other } }] }] }]) };
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
  const select = async (id: number) => {
    session.view = unselected; next = selected(id); calls.length = 0; notices.length = 0;
    assert.equal(await ui.dispatch(ctx, session.view, { id: `select:${id}`, kind: 'action', label: 'Select' }), true);
    await ui.release().catch(() => {}); // Settle queued marks before asserting.
    return calls.filter((call) => call[0] !== 'set-user-vars');
  };
  const ls = ['ls', '--match-tab=window_id:42'], title = (id: number) => ['set-tab-title', '--match=window_id:42', '--', `Task ${id}`];
  try {
    settings(true);
    assert.deepEqual(await select(7), [ls, ['action', '--match=id:42', 'detach_window', 'new-tab-right'], title(7)]);
    assert.deepEqual(calls.filter((call) => call[0] === 'set-user-vars'), [['set-user-vars', '--match=id:42', 'pinote_task=7'], ['set-user-vars', '--match=id:42', 'pinote_task']],
      'The pane records its task, and release clears it');
    other = '8';
    assert.deepEqual(await select(8), [ls, title(8)], 'Panes on the same task share a tab');
    other = undefined;
    assert.deepEqual(await select(9), [ls, title(9)], 'Panes without a task do not count');
    other = '3'; active = false;
    assert.deepEqual(await select(10), [ls], 'An unfocused pane is neither moved nor allowed to rename the shared tab');
    assert.deepEqual(notices, ['Pinote task selected, but this pane was not focused, so it stays in its shared Kitty tab.']);
    active = true; failList = true;
    assert.deepEqual(await select(11), [ls]);
    assert.deepEqual(notices, ['Pinote task selected, but this pane could not be moved to its own Kitty tab.']);
    settings(false);
    assert.deepEqual(await select(12), [title(12)], 'Off keeps renaming the shared tab');
  } finally {
    ui.detach();
    rmSync(agent, { recursive: true, force: true });
    for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key];
    Object.assign(process.env, original);
  }
});
