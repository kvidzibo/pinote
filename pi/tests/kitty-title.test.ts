import assert from 'node:assert/strict';
import { test } from 'node:test';
import { initTheme } from '@earendil-works/pi-coding-agent';
import { getKeybindings } from '@earendil-works/pi-tui';
import { RemoteUI } from '../remote/ui.ts';
import type { NativeView } from '../remote/protocol.ts';

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
  const ui = new RemoteUI({ exec: async (...args: any[]) => {
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
