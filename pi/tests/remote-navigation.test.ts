import assert from 'node:assert/strict';
import { test } from 'node:test';
import { initTheme } from '@earendil-works/pi-coding-agent';
import { getKeybindings } from '@earendil-works/pi-tui';
import { editValue } from '../remote/dialogs.ts';
import { menuView, parentScreen, serverScreen } from '../remote/navigation.ts';
import { remoteMenu } from '../remote/menu.ts';
import { RemoteUI } from '../remote/ui.ts';
import type { NativeView } from '../remote/protocol.ts';

const view = (): NativeView => ({ version: 1, title: 'Pinote', revision: 'server-view', state: { screen: 'settings', selectedId: 7 }, controls: [
  { id: 'handoffPrompt', kind: 'text', multiline: true, label: 'Handoff prompt', value: '  First line  \n\nLast line  \n', revision: 'prompt-revision', confirm: 'Shared change' },
  { id: 'titleWidth', kind: 'number', label: 'Title width', value: 60, revision: 'width-revision', confirm: 'Shared change' },
  { id: 'taskOfferPolicy', kind: 'select', label: 'Suggestions', value: 'off', revision: 'policy-revision', options: [{ label: 'Off', value: 'off' }] },
  { id: 'field:Owner', kind: 'action', label: 'Owner', revision: 'field-revision' },
] });

// Run the real custom factory; loaders resolve asynchronously and are disposed only afterwards.
function native(script: (component: any, rows: string[]) => void | Promise<void>) {
  return async (factory: any) => {
    let component: any;
    try { return await new Promise((resolve, reject) => {
      component = factory({ terminal: { rows: 48, columns: 100 }, requestRender() {} },
        { fg: (_color: string, text: string) => text }, getKeybindings(), resolve);
      const rows = component.render(100);
      if (component.handleInput) Promise.resolve(script(component, rows)).catch(reject);
    }); } finally { component?.dispose(); }
  };
}

test('grouped navigation, plain editors, cancellation, preview and pending search retain safety', async (t) => {
  initTheme('dark', false);
  await t.test('local groups retain server control identity and revisions', () => {
    const current = view();
    assert.deepEqual(menuView(current, 'settings').controls.map((c) => c.id), ['__prompts', '__fields', 'taskOfferPolicy', '__footer']);
    for (const [screen, id] of [['prompts', 'handoffPrompt'], ['footer', 'titleWidth'], ['fields', 'field:Owner']] as const) {
      const grouped = menuView(current, screen);
      assert.equal(grouped.revision, current.revision);
      assert.equal(grouped.controls.find((c) => c.id === id), current.controls.find((c) => c.id === id));
      assert.equal(serverScreen(screen), 'settings');
      assert.equal(parentScreen(screen), 'settings');
    }
    assert.equal(menuView(current, 'settings').controls[2], current.controls[2]);
    current.controls.push(
      { id: 'bar:Worktree', kind: 'action', label: '1 Worktree', description: 'Shown as bottom-bar field 1.' },
      { id: 'bar:PRs', kind: 'action', label: 'PRs', description: 'Hidden.' },
    );
    assert.deepEqual(menuView(current, 'footer').controls.map((control) => control.id), ['titleWidth', 'bar:Worktree', 'bar:PRs']);
    assert.equal(menuView(current, 'footer').controls[1], current.controls.at(-2));
    assert.ok(menuView(current, 'settings').controls.every((control) => !control.id.startsWith('bar:')));
    current.controls.push({ id: 'watcher:abc', label: 'GitHub PR', kind: 'toggle', value: false, revision: 'watcher-revision' });
    assert.equal(menuView(current, 'fields').controls[0].id, '__watchers');
    assert.equal(menuView(current, 'watchers').controls[0], current.controls.at(-1));
    assert.equal(parentScreen('watchers'), 'fields');
    assert.equal(serverScreen('watchers'), 'settings');
  });
  await t.test('plain Input and Editor prefill exact whitespace and reject invalid numbers', async () => {
    const current = view(), signal = new AbortController().signal;
    const prompt = current.controls[0];
    const draft = { text: String(prompt.value) };
    const multiline = await editValue({ ui: { custom: native((component, rows) => {
      assert.match(rows.join(' '), /First line/);
      assert.ok(!rows.join(' ').includes('"First line'), 'Editor is plain text, not JSON');
      component.handleInput('\r');
    }) } } as any, 'Prompt', current, prompt, draft, signal);
    assert.equal(multiline, prompt.value, 'Unchanged multiline input retains blank lines, spaces and final newline');
    const number = await editValue({ ui: { custom: native((component, rows) => {
      assert.match(rows.join(' ').replace(/\x1b_pi:\/?fc\x07/g, ''), /60/);
      component.handleInput('\x05'); component.handleInput('\x15'); component.handleInput('not a number'); component.handleInput('\r');
      assert.match(component.render(100).join(' '), /Enter a whole number/);
      component.handleInput('\x05'); component.handleInput('\x15'); component.handleInput('72'); component.render(100); component.handleInput('\r');
    }) } } as any, 'Width', current, current.controls[1], { text: '60' }, signal);
    assert.equal(number, 72);
    const plain = { id: 'plain', kind: 'text' as const, label: 'Plain text', value: '  exact whitespace  ' };
    const text = await editValue({ ui: { custom: native((component) => component.handleInput('\r')) } } as any,
      'Plain text', current, plain, { text: plain.value }, signal);
    assert.equal(text, plain.value, 'Single-line text is not trimmed');
  });
  await t.test('review cancellation performs no write; completion cancellation also performs no write', async () => {
    const current = view(), signal = new AbortController().signal;
    let approvals = 0, writes = 0;
    const session: any = { signal, current: () => () => true, view: current, action: async () => { writes++; return {}; } };
    const ui = new RemoteUI({} as any, session);
    const ctx: any = { mode: 'tui', isIdle: () => true, ui: {
      notify: (message: string) => assert.fail(message),
      custom: native((component, rows) => { assert.match(rows.join(' '), /Review complete/); component.handleInput('\r'); }),
      select: async (_title: string, options: string[]) => { approvals++; assert.equal(options[0], 'Cancel'); return options[0]; },
    } };
    assert.equal(await ui.dispatch(ctx, current, current.controls[1], 72), false);
    assert.equal(await ui.dispatch(ctx, current, { id: 'done', kind: 'action', label: 'Complete' }), false);
    assert.equal(approvals, 2); assert.equal(writes, 0);
  });
  await t.test('preview uses a mounted loader then an inline read-only document, never an appended entry', async () => {
    const current = view();
    let documents = 0, actions = 0;
    const session: any = { signal: new AbortController().signal, current: () => () => true, view: current,
      action: async () => { actions++; await Promise.resolve(); return { preview: 'Full task preview' }; } };
    const ui = new RemoteUI({ appendEntry: () => assert.fail('Preview must stay inline') } as any, session);
    const ctx: any = { mode: 'tui', ui: { notify: (message: string) => assert.fail(message),
      custom: native((component, rows) => { documents++; assert.match(rows.join(' '), /Full task preview/); assert.match(rows.join(' '), /Read-only/); component.handleInput('\x1b'); }),
    } };
    assert.equal(await ui.dispatch(ctx, current, { id: 'preview', kind: 'action', label: 'Preview' }), true);
    assert.equal(actions, 1); assert.equal(documents, 1);
  });
  await t.test('picker preview discloses a clipped full title without starting or selecting the task', async () => {
    const text = 'Shared title prefix '.repeat(120) + 'DISTINCT END';
    const current: NativeView = { version: 1, title: 'Pinote', revision: 'r', state: { selectedId: null },
      controls: [{ id: 'select:7', kind: 'action', label: text.slice(0, 2000) }] };
    let step = 0, reads = 0;
    const session: any = { signal: new AbortController().signal, current: () => () => true, view: current,
      refresh: async () => {}, action: () => assert.fail('Preview must not start/select a task'),
      tool: async (name: string, args: unknown) => {
        reads++; assert.equal(name, 'get_task'); assert.deepEqual(args, { task_id: 7 });
        return { content: [{ type: 'text', text: JSON.stringify({ id: 7, text }) }] };
      },
    };
    const ctx: any = { mode: 'tui', ui: { notify: (message: string) => assert.fail(message),
      custom: native((component, rows) => {
        switch (step++) {
          case 0:
            assert.match(rows.join(' '), /F1 preview/);
            assert.ok(!rows.join(' ').includes('DISTINCT END'));
            component.handleInput('\x1bOP'); break;
          case 1:
            assert.match(rows.join(' '), /Task text #7/);
            component.handleInput('\x1b[6~');
            assert.match(component.render(100).join(' '), /DISTINCT END/);
            component.handleInput('\x1b'); break;
          default: component.handleInput('\x1b');
        }
      }),
    } };
    await new RemoteUI({} as any, session).open(ctx);
    assert.equal(step, 3); assert.equal(reads, 1); assert.equal(current.state.selectedId, null);
  });
  await t.test('tasks open directly with New task first; Tab and Escape preserve the task search', async () => {
    const taskControls: NativeView['controls'] = [
      { id: 'add', kind: 'text', label: 'New task', icon: '+', value: '', multiline: true },
      { id: 'select:7', kind: 'action', label: 'Sample task' },
      { id: 'screen:settings', kind: 'action', label: 'Settings' },
    ];
    const current: NativeView = { version: 1, title: 'Pinote', revision: 'r', state: { screen: 'tasks', search: '' }, controls: taskControls };
    let step = 0;
    const session: any = { signal: new AbortController().signal, current: () => () => true, view: current,
      refresh: async () => {}, action: async (_view: NativeView, control: { id: string }) => {
        assert.ok(['screen:settings', 'screen:tasks'].includes(control.id), 'Navigation never mutates tasks');
        current.state.screen = control.id.slice(7);
        current.controls = current.state.screen === 'tasks' ? taskControls : [...view().controls, { id: 'screen:tasks', kind: 'action', label: 'Tasks' }];
        return {};
      },
    };
    const ctx: any = { mode: 'tui', ui: { notify: (message: string) => assert.fail(message), custom: native((component, rows) => {
      switch (step++) {
        case 0:
          assert.match(rows.join(' '), /Search tasks/);
          assert.ok(rows.findIndex((row) => row.includes('+ New task')) < rows.findIndex((row) => row.includes('Sample task')));
          component.handleInput('\x1bOP'); // F1 on New task is inert.
          component.handleInput('Sample'); component.render(100); component.handleInput('\t'); break;
        case 1:
          assert.match(rows.join(' '), /Pinote \/ Settings/);
          assert.ok(rows.findIndex((row) => row.includes('Agent guidance')) < rows.findIndex((row) => row.includes('Fields')));
          component.handleInput('\x1b'); break;
        case 2:
          assert.match(rows.join(' ').replace(/\x1b_pi:\/?fc\x07/g, ''), /Sample/);
          component.handleInput('\t'); break;
        case 3: component.handleInput('\t'); break; // Tab returns to tasks too.
        case 4: component.handleInput('\x1b'); break; // Root closes, no old home screen.
        default: assert.fail('Unexpected extra menu');
      }
    }) } };
    await new RemoteUI({} as any, session).open(ctx);
    assert.equal(step, 5);
    assert.equal(parentScreen('tasks'), undefined);
    assert.equal(parentScreen('settings'), 'tasks');
  });
  await t.test('Tab waits for an in-flight search before acquiring navigation revisions', async () => {
    let started!: () => void, release!: () => void, steps = 0, active = true;
    const searching = new Promise<void>((resolve) => { started = resolve; });
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const current: NativeView = { version: 1, title: 'Pinote', revision: 'before', state: { screen: 'tasks', search: '' }, controls: [
      { id: 'search', kind: 'text', label: 'Search' },
      { id: 'screen:settings', kind: 'action', label: 'Settings', revision: 'before' },
      { id: 'select:7', kind: 'action', label: 'Sample task' },
    ] };
    const session: any = { signal: new AbortController().signal, current: () => () => active, view: current,
      refresh: async () => {}, action: async (_view: NativeView, control: { id: string; revision?: string }, query: string) => {
        if (control.id === 'search') {
          started(); await waiting;
          current.state.search = query;
          current.controls = [{ id: 'screen:settings', kind: 'action', label: 'Settings', revision: 'after-search' }];
        } else {
          assert.equal(control.revision, 'after-search', 'Navigation must use the revision returned by search');
          current.state.screen = 'settings';
          current.controls = view().controls;
        }
        session.onChange();
        return {};
      },
    };
    const ctx: any = { mode: 'tui', ui: { notify: (message: string) => assert.fail(message),
      select: () => assert.fail('Search/navigation must not enter stale-state recovery'),
      custom: native(async (component, rows) => {
        if (steps++ === 0) {
          component.handleInput('Sample'); component.render(100);
          await searching;
          component.handleInput('\t');
          // Let navigation queue before the search response arrives.
          await new Promise((resolve) => setImmediate(resolve)); release();
        } else {
          assert.match(rows.join(' '), /Pinote \/ Settings/);
          active = false;
          component.handleInput('\x1b');
        }
      }),
    } };
    try { await new RemoteUI({} as any, session).open(ctx); assert.equal(steps, 2); }
    finally { release(); }
  });
  await t.test('server search suppresses keyboard and mouse activation until results arrive', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const current = view(); current.state = { search: '' };
    current.controls = [{ id: 'select:7', kind: 'action', label: 'Old result' }];
    let component: any, completed = false, searches = 0, release!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const state = { search: '' };
    const ctx: any = { ui: { custom: async (factory: any) => new Promise((resolve) => {
      component = factory({ terminal: { rows: 36, columns: 100 }, requestRender() {} },
        { fg: (_color: string, text: string) => text }, getKeybindings(), (value: unknown) => { completed = true; resolve(value); });
    }) } };
    const result = remoteMenu(ctx, current, state, new AbortController().signal, () => () => {}, { search: 'tasks',
      onSearch: async (query) => { searches++; assert.equal(query, 'new'); await waiting; },
    });
    try {
      component.render(100); component.handleInput('new'); component.render(100); component.handleInput('\r');
      assert.equal(completed, false); assert.equal(searches, 0);
      t.mock.timers.tick(250); assert.equal(searches, 1);
      const rows = component.render(100);
      assert.match(rows.join(' '), /Selection is disabled/);
      component.handleInput('\r'); component.handleInput('\x1bOP');
      for (let y = 0; y < rows.length; y++) component.handleMouse({ type: 'click', button: 'left', x: 3, y, clickCount: 1 });
      assert.equal(completed, false, 'Old task rows must remain inert during search');
      release(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
      component.render(100); component.handleInput('\r');
      assert.equal(completed, false, 'Settled search without a matching server view is still stale');
      component.handleInput('\x1b'); assert.equal(await result, undefined); component.dispose();
      current.state.search = state.search;
      const refreshed = remoteMenu(ctx, current, state, new AbortController().signal, () => () => {}, { search: 'tasks' });
      component.render(100); component.handleInput(' tail');
      assert.equal(state.search, 'new tail', 'A result refresh preserves the native input caret instead of prepending later typing');
      component.handleInput('\x1b'); await refreshed;
    } finally { release(); component.dispose(); }
  });
});
