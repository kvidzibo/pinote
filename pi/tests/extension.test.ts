import assert from 'node:assert/strict';
import { test } from 'node:test';
import { StaleAction } from '../engine.ts';
import { getKeybindings, visibleWidth } from '@earendil-works/pi-tui';
import { createEventBus, initTheme } from '@earendil-works/pi-coding-agent';
import { PinoteFailure, type Peer, type PeerFactory } from '../extension/client.ts';
import { ENTRY_TYPE, SCOPE, PinoteSession, restoreState, type SavedState } from '../extension/session.ts';
import { UI_CONTEXT, UI_FEATURES, ViewSchema, type NativeView } from '../extension/protocol.ts';
import { toolDefinitions } from '../extension/tools.ts';

// Stands for private task data in storage errors: it must never reach a notice.
const token = 'private-detail-never-shown-01234567890123456789';
const view = (state = {}): NativeView => ({ version: 1, title: 'Pinote', revision: 'view-1', state, retainOnNew: true,
  controls: [{ id: 'complete', kind: 'action', label: 'Complete', revision: 'task-1' }], footer: [{ text: 'Task', action: 'complete' }] });
function harness(overrides: Partial<Peer> = {}) {
  const saved: SavedState[] = [], metas: Record<string, unknown>[] = [];
  let connections = 0, changed = () => {};
  const peer: Peer = {
    view: async (meta) => { metas.push(structuredClone(meta)); return view((meta[UI_CONTEXT] as SavedState).state); },
    context: async (meta) => { metas.push(structuredClone(meta)); return 'fresh task data'; },
    tool: async () => ({ result: 'ok' }),
    action: async () => ({ view: view({ selectedId: null }) }), close: async () => {}, ...overrides,
  };
  const factory: PeerFactory = async (notify) => { connections++; changed = notify; return peer; };
  const session = new PinoteSession((state) => saved.push(structuredClone(state)), factory);
  return { session, saved, metas, connections: () => connections, changed: () => changed() };
}
// Instantiate native loaders and keep them mounted until their asynchronous work finishes.
async function loader(factory: any) {
  initTheme('dark', false);
  let component: any;
  try {
    return await new Promise((resolve) => {
      component = factory({ terminal: { rows: 36, columns: 100 }, requestRender() {} },
        { fg: (_color: string, text: string) => text }, getKeybindings(), resolve);
      component.render(100);
      assert.equal(component.handleInput, undefined, 'Pending operations must not accept activation keys');
    });
  } finally { component?.dispose(); }
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test('branch-only restoration, selections saved by the former HTTP client and independent unrelated launch', async () => {
  const a = restoreState([]), b = restoreState([]);
  assert.notEqual(a.contextId, b.contextId);
  const branch = [{ type: 'custom', customType: ENTRY_TYPE, data: { ...a, state: { selectedId: 7 } } }];
  assert.equal(restoreState(branch).state.selectedId, 7);
  const piSessionId = '12345678-1234-4234-8234-123456789012';
  // An endpoint-scoped selection may name another database's task: only a task recording this Pi session is kept.
  const legacy = [{ ...branch[0], data: { ...branch[0].data, scope: 'endpoint-hash', state: { selectedId: 7, search: 'old' } } }];
  for (const [sessions, selectedId] of [[[piSessionId], 7], [['another-session'], undefined]] as const) {
    const upgraded = harness({ tool: async (name, args) => { assert.equal(name, 'get_task'); assert.deepEqual(args, { task_id: 7 }); return { result: { id: 7, 'pi-sessions': sessions } }; } });
    await upgraded.session.start(legacy, 'pi-session', undefined, piSessionId);
    assert.deepEqual(upgraded.session.snapshot()?.state, selectedId ? { selectedId } : {});
    assert.equal(upgraded.session.snapshot()?.scope, SCOPE);
    assert.equal(upgraded.session.snapshot()?.contextId, a.contextId);
    await upgraded.session.stop();
  }
  const unverifiable = harness({ tool: async () => { throw new Error(token); } });
  await unverifiable.session.start(legacy, 'pi-session', undefined, piSessionId);
  assert.deepEqual(unverifiable.session.snapshot()?.state, {}, 'An unreadable task fails closed');
  await unverifiable.session.stop();
  const h = harness();
  await h.session.start(branch, 'pi-session', undefined, piSessionId);
  assert.equal((h.metas[0][UI_CONTEXT] as any).piSessionId, piSessionId);
  assert.equal((h.metas[0][UI_CONTEXT] as any).contextId, a.contextId);
  assert.equal((h.metas[0][UI_CONTEXT] as any).conversationId, 'pi-session');
  assert.equal((h.metas[0][UI_FEATURES] as any).actionRevisions, true);
  const carried = h.session.snapshot();
  await h.session.start([], 'new-pi-session', carried);
  assert.equal((h.metas.at(-1)![UI_CONTEXT] as any).piSessionId, undefined, 'Never inherit a prior Pi session ID');
  assert.equal(h.session.snapshot()?.state.selectedId, 7);
  assert.equal(h.session.snapshot()?.contextId, a.contextId);
  await h.session.start([], 'unrelated');
  assert.deepEqual(h.session.snapshot()?.state, {});
  await h.session.stop();
});

test('field alerts are task-scoped and deduplicated across refresh and reload without model turns', async () => {
  const notice = { id: '12345678-1234-4234-8234-123456789012', taskId: 7, field: 'PR', message: 'Checks failed' };
  const selected = { ...view({ selectedId: 7 }), fieldNotifications: [notice, { ...notice, id: '12345678-1234-4234-8234-123456789013', taskId: 8 }] };
  const h = harness({ view: async () => selected });
  const delivered: string[] = [];
  h.session.onFieldNotification = (item) => { delivered.push(item.id); return true; };
  await h.session.start([], 'fields');
  await h.session.refresh();
  assert.deepEqual(delivered, [notice.id]);
  const saved = h.session.snapshot()!;
  await h.session.start([{ type: 'custom', customType: ENTRY_TYPE, data: saved }], 'fields');
  assert.deepEqual(delivered, [notice.id], 'branch receipts survive /reload');
  selected.state = { selectedId: null };
  await h.session.refresh();
  assert.deepEqual(delivered, [notice.id]);
  await h.session.stop();
});

test('grouped field alerts acknowledge every PR atomically and retain partial pending receipts across reload', async () => {
  const ids = ['12345678-1234-4234-8234-123456789012', '12345678-1234-4234-8234-123456789013'];
  const parse = (receiptIds?: string[]) => ViewSchema.safeParse({ ...view(), fieldNotifications: [{ id: ids[0], taskId: 7, field: 'PR', message: 'Checks failed', ...(receiptIds === undefined ? {} : { receiptIds }) }] }).success;
  assert.equal(parse(), true, 'Receipt groups are optional');
  assert.equal(parse([ids[0]]), true);
  for (const invalid of [[], [ids[0], ids[0]], ['invalid'], [ids[1]], Array.from({ length: 65 }, (_, i) => `12345678-1234-4234-8234-${String(i).padStart(12, '0')}`)]) {
    assert.equal(parse(invalid), false);
  }
  const notice = { id: ids[0], receiptIds: ids, taskId: 7, field: 'PR', message: 'Checks failed', triggerWorker: true as const };
  const selected = { ...view({ selectedId: 7 }), fieldNotifications: [notice] };
  const h = harness({ view: async (meta) => {
    assert.equal((meta[UI_FEATURES] as any).fieldReceiptGroups, true);
    return selected;
  } });
  const prior = { ...restoreState([]), state: { selectedId: 7 }, fieldReceipts: [ids[0]] };
  let ready = false, attempts = 0, delivered = 0;
  h.session.onFieldNotification = () => {
    attempts++;
    if (!ready) return false;
    delivered++;
    return true;
  };
  try {
    await h.session.start([{ type: 'custom', customType: ENTRY_TYPE, data: prior }], 'groups');
    assert.equal(attempts, 1, 'An acknowledged group ID must not hide an unacknowledged member');
    assert.equal(h.session.hasPendingFieldNotifications, true);
    assert.deepEqual(h.session.snapshot()!.fieldReceipts, [ids[0]], 'Busy callbacks acknowledge no additional IDs');
    ready = true;
    await h.session.refresh();
    assert.equal(delivered, 1, 'One group delivers one worker turn');
    assert.equal(h.session.hasPendingFieldNotifications, false);
    assert.deepEqual(h.session.snapshot()!.fieldReceipts, ids);
    assert.deepEqual(h.saved.at(-1)!.fieldReceipts, ids, 'All IDs are persisted together');
    await h.session.refresh();
    await h.session.start([{ type: 'custom', customType: ENTRY_TYPE, data: h.session.snapshot()! }], 'groups');
    assert.equal(delivered, 1, 'Fully acknowledged groups do not replay after restart');
  } finally { await h.session.stop(); }
});

test('enabled watcher alerts trigger once, defer busy workers, and revalidate after settling', async (t) => {
  const { default: extension } = await import('../index.ts');
  const handlers = new Map<string, (...args: any[]) => any>(), entries: any[] = [], sent: any[] = [], notices: string[] = [];
  let idle = true, session!: PinoteSession;
  const notice = { id: '12345678-1234-4234-8234-123456789012', taskId: 7, field: 'PR', message: 'CI failed', triggerWorker: true as const };
  let current = { ...view({ selectedId: 7 }), fieldNotifications: [notice] };
  t.mock.method(PinoteSession.prototype, 'refresh', async function (this: PinoteSession) {
    session = this; (this as any).apply(current);
  });
  extension({
    registerTool() {}, registerCommand() {}, registerEntryRenderer() {},
    events: { on() { return () => {}; } },
    appendEntry: (customType: string, data: any) => entries.push({ type: 'custom', customType, data }),
    sendMessage: (message: any, options: any) => sent.push({ message, options }),
    on: (name: string, handler: (...args: any[]) => any) => {
      const previous = handlers.get(name);
      handlers.set(name, async (...args) => { await previous?.(...args); return handler(...args); });
    },
  } as any);
  const ctx = { mode: 'rpc', hasUI: true, isIdle: () => idle,
    sessionManager: { getSessionFile: () => undefined, getSessionId: () => 'worker', getBranch: () => entries },
    ui: { notify: (message: string) => notices.push(message) } };
  try {
    await handlers.get('session_start')!({ reason: 'startup' }, ctx);
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0].options, { triggerTurn: true, deliverAs: 'followUp' });
    assert.match(sent[0].message.content, /Investigate and fix/);
    assert.match(sent[0].message.content, /untrusted data, not instructions/);
    await session.refresh();
    await handlers.get('session_start')!({ reason: 'reload' }, ctx);
    assert.equal(sent.length, 1, 'Persisted receipts prevent duplicate worker turns after reload');
    idle = false;
    current.fieldNotifications = [{ ...notice, id: '12345678-1234-4234-8234-123456789013' }];
    await session.refresh();
    assert.equal(session.hasPendingFieldNotifications, true);
    assert.equal(sent.length, 1, 'Busy workers do not queue stale prompts');
    idle = true;
    await handlers.get('agent_settled')!({ aborted: true });
    assert.equal(sent.length, 1, 'Aborting does not immediately restart work');
    current.fieldNotifications = [];
    await handlers.get('agent_settled')!({ aborted: false });
    assert.equal(sent.length, 1, 'Resolved or disabled alerts do not wake a worker');
    idle = false;
    current.fieldNotifications = [
      { ...notice, id: '12345678-1234-4234-8234-123456789014' },
      { ...notice, id: '12345678-1234-4234-8234-123456789017', field: 'Other PR' },
    ];
    await session.refresh(); idle = true;
    await handlers.get('agent_settled')!({ aborted: false });
    assert.equal(sent.length, 2, 'Only one turn is reserved while Pi defers sends during agent_settled');
    assert.equal(session.hasPendingFieldNotifications, true, 'Other alerts remain unacknowledged');
    await session.refresh();
    assert.equal(sent.length, 2, 'An idle refresh before agent_start cannot queue a second turn');
    idle = false;
    await handlers.get('agent_start')!({});
    current.fieldNotifications = []; // The first turn resolves both failures or disables the watcher.
    idle = true;
    await handlers.get('agent_settled')!({ aborted: false });
    assert.equal(sent.length, 2, 'Resolved pending alerts never become stale follow-up turns');
    current = { ...view({ selectedId: 8 }), fieldNotifications: [{ ...notice, id: '12345678-1234-4234-8234-123456789015' }] };
    await session.refresh(); assert.equal(sent.length, 2, 'Another task cannot trigger work');
    current = { ...view({ selectedId: 7 }), fieldNotifications: [{ ...notice, triggerWorker: undefined } as any] };
    current.fieldNotifications[0].id = '12345678-1234-4234-8234-123456789016';
    await session.refresh(); assert.equal(sent.length, 2);
    assert.match(notices.at(-1)!, /CI failed/, 'Alerts without a worker request remain notification-only');
  } finally {
    await handlers.get('session_shutdown')!({ reason: 'quit' });
  }
});

test('eight explicit direct schemas; tool state is applied before next serialized call', async () => {
  assert.deepEqual(toolDefinitions.map((t) => t.name).sort(), ['fields', 'get_current', 'get_task', 'propose', 'search', 'suggest_later', 'tags', 'update_current']);
  const seen: unknown[] = [];
  const h = harness({ tool: async (_name, _args, meta) => {
    seen.push(structuredClone((meta[UI_CONTEXT] as any).state));
    await sleep(10);
    return { result: 'ok', state: { selectedId: 19 } };
  } });
  await h.session.start([], 'conversation');
  await Promise.all([h.session.tool('propose', { title: 'task' }), h.session.tool('get_current', {})]);
  assert.deepEqual(seen, [{}, { selectedId: 19 }]);
  assert.equal(h.session.snapshot()?.state.selectedId, 19);
  assert.equal(await h.session.context(), 'fresh task data');
  await h.session.stop();
});

test('mutations never replay; read-only recovery preserves selection and shows disconnected status', async (t) => {
  const { PinoteUI } = await import('../extension/ui.ts');
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0, failRead = false, selectedId = 7, pendingRead: Promise<void> | undefined;
  const h = harness({
    tool: async () => { calls++; throw new Error(`note failed: ${token}`); },
    view: async () => {
      const captured = view({ selectedId });
      if (pendingRead) await pendingRead;
      if (failRead) throw new Error(token);
      return captured;
    },
  });
  await h.session.start([], 'conversation');
  const components: any[] = [], statuses: Array<string | undefined> = [];
  for (const mode of ['fullscreen', 'regular']) {
    new PinoteUI({} as any, h.session).attach({ mode: 'tui', ui: {
      theme: { fg: (_color: string, text: string) => text },
      setWidget: (_key: string, factory: any) => components.push(factory({ mode, requestRender() {} }, { fg: (_color: string, text: string) => text })),
      setStatus: (_key: string, value: string | undefined) => statuses.push(value),
    } } as any);
  }
  // Both attachments share one session; repaint the fullscreen component directly.
  assert.match(components[0].render(80).join(''), /Task/);
  await assert.rejects(h.session.tool('update_current', { expected_updated_at: 'old' }), (e: Error) => e.message.includes('may have committed') && !e.message.includes(token));
  assert.equal(calls, 1); assert.equal(h.connections(), 1); assert.equal(h.session.view, undefined);
  assert.equal(h.session.snapshot()?.state.selectedId, 7);
  assert.match(components[0].render(80).join(''), /unavailable · retrying/);
  assert.match(statuses.at(-1)!, /unavailable · retrying/);
  assert.ok(visibleWidth(components[0].render(20)[0]) <= 20);
  assert.equal(components[0].handleMouse({ type: 'click', button: 'left', x: 0, y: 0 }), undefined);
  const advance = async (ms: number) => { t.mock.timers.tick(ms); await new Promise<void>((resolve) => setImmediate(resolve)); };
  failRead = true;
  await advance(1000); assert.equal(h.connections(), 2);
  await advance(1999); assert.equal(h.connections(), 2);
  await advance(1); assert.equal(h.connections(), 3);
  let connections = 3;
  for (const delay of [4000, 8000, 16_000, 30_000, 30_000]) {
    await advance(delay - 1); assert.equal(h.connections(), connections);
    await advance(1); assert.equal(h.connections(), ++connections);
  }
  failRead = false;
  await advance(30_000); assert.equal(h.connections(), ++connections);
  assert.equal(calls, 1); assert.equal((h.session.view as NativeView | undefined)?.state.selectedId, 7);
  assert.match(components[0].render(80).join(''), /Task/);
  assert.doesNotMatch(statuses.at(-1)!, /disconnected/);
  await assert.rejects(h.session.tool('update_current', {}), PinoteFailure);
  await h.session.stop();
  await advance(60_000);
  assert.equal(h.connections(), connections, 'Stopping cancels pending recovery');
  await h.session.start([], 'before-reload'); connections++;
  await assert.rejects(h.session.tool('update_current', {}), PinoteFailure);
  let release!: () => void;
  pendingRead = new Promise<void>(resolve => { release = resolve; });
  await advance(1000); assert.equal(h.connections(), ++connections, 'Recovery is in flight');
  await h.session.stop('reload');
  pendingRead = undefined; selectedId = 8;
  const savedBeforeReload = h.saved.length;
  await h.session.start([], 'after-reload'); connections++;
  release(); await advance(60_000);
  assert.equal(h.connections(), connections, 'Old recovery cannot restart after reload');
  assert.equal(h.session.snapshot()?.state.selectedId, 8);
  assert.equal((h.session.view as NativeView | undefined)?.state.selectedId, 8);
  assert.ok(!h.saved.slice(savedBeforeReload).some(saved => saved.state.selectedId === 7), 'Late old view never overwrites the new session');
  await h.session.stop();
});

test('menu/footer completion refuses busy agents and rechecks immediately before queued writes', async () => {
  const { PinoteUI } = await import('../extension/ui.ts');
  const current = view(); current.controls[0].id = 'done'; current.footer = [{ text: 'Task', doubleAction: 'done' }];
  let idle = false, actions = 0, release!: () => void, started!: () => void;
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  const began = new Promise<void>((resolve) => { started = resolve; });
  const h = harness({
    view: async () => current,
    tool: async () => { started(); await waiting; return { result: null }; },
    action: async () => { actions++; return { view: current }; },
  });
  await h.session.start([], 'conversation');
  const notices: string[] = [];
  const ctx = { mode: 'tui', isIdle: () => idle, ui: { notify: (message: string) => notices.push(message), custom: loader,
    select: async (_title: string, choices: string[]) => { assert.deepEqual(choices, ['Cancel', 'Complete task']); return 'Complete task'; } } } as any;
  const ui = new PinoteUI({} as any, h.session);
  assert.equal(await ui.dispatch(ctx, h.session.view!, current.controls[0]), false);
  assert.equal(actions, 0); assert.match(notices[0], /current agent run/);
  idle = true;
  const blocker = h.session.tool('get_current', {});
  await began;
  const queued = ui.dispatch(ctx, h.session.view!, current.controls[0]);
  idle = false; release(); await blocker;
  assert.equal(await queued, false); assert.equal(actions, 0, 'Busy state must be checked again after queueing');
  idle = true;
  assert.equal(await ui.dispatch(ctx, h.session.view!, current.controls[0]), true);
  assert.equal(actions, 1);
  await h.session.stop();
});

test('footer double-click approves completion once without changing menu approval or completion guards', async () => {
  const { PinoteUI } = await import('../extension/ui.ts');
  for (const scenario of ['ordinary', 'dedicated', 'busy', 'stale', 'failed']) {
    const current = view({ selectedId: 7 });
    current.controls = [
      { id: 'done', kind: 'action', label: 'Complete task', revision: 'task-1' },
      { id: 'preview', kind: 'action', label: 'Preview', revision: 'task-1' },
    ];
    current.footer = [{ text: 'Task', action: 'preview', doubleAction: 'done' }];
    const actions: string[] = [];
    const h = harness({ view: async () => current, action: async (params) => {
      assert.equal(typeof params.action, 'string');
      actions.push(params.action as string);
      if (scenario === 'failed' && params.action === 'done') throw new Error('Unavailable');
      return { view: params.action === 'done' ? view({ selectedId: null }) : structuredClone(current) };
    } });
    await h.session.start([], 'conversation');
    let footer: any, prompts = 0, shutdowns = 0, idle = true;
    const theme = { fg: (_color: string, text: string) => text, italic: (text: string) => text } as any;
    const ctx = { mode: 'tui', isIdle: () => idle, shutdown: () => { shutdowns++; }, ui: {
      theme, setStatus() {}, notify() {}, custom: loader,
      setWidget: (_key: string, factory: any) => {
        footer = factory({ mode: 'fullscreen', requestRender() {} }, theme);
      },
      select: async (_title: string, choices: string[]) => {
        prompts++; assert.equal(choices[0], 'Cancel'); return 'Cancel';
      },
      setEditorText: () => assert.fail('Completion must preserve the editor'),
    } } as any;
    const ui = new PinoteUI({} as any, h.session, () => scenario === 'dedicated');
    ui.attach(ctx);
    try {
      assert.equal(await ui.dispatch(ctx, h.session.view!, current.controls[0]), false);
      assert.equal(prompts, 1, 'Menu completion still asks');
      assert.deepEqual(actions, []);
      footer.render(80);
      const click = (clickCount: number) => footer.handleMouse({ type: 'click', button: 'left', x: 1, y: 0, clickCount });
      click(1); await sleep(520);
      assert.deepEqual(actions, ['preview'], 'Single-click remains preview-only');
      footer.render(80);
      if (scenario === 'busy') idle = false;
      if (scenario === 'stale') {
        current.controls[0].revision = 'task-2';
        await h.session.refresh(); // Keep the old rendered hit region until the next paint.
      }
      click(1); click(2); click(3); await sleep(30);
      assert.equal(prompts, 1, 'Double-click must not ask again');
      assert.deepEqual(actions, ['busy', 'stale'].includes(scenario) ? ['preview'] : ['preview', 'done'], scenario);
      assert.equal(shutdowns, scenario === 'dedicated' ? 1 : 0, scenario);
      if (scenario === 'ordinary' || scenario === 'dedicated') assert.equal(h.session.view?.state.selectedId, null);
    } finally { footer.dispose(); await h.session.stop(); }
  }
});

test('footer double-click accepts suggestions once while preserving menu review and stale/failure guards', async () => {
  const { PinoteUI } = await import('../extension/ui.ts');
  for (const scenario of ['ordinary', 'busy', 'stale', 'failed']) {
    const current = view({ selectedId: null });
    current.controls = [
      { id: 'proposal:accept', kind: 'action', label: 'Accept suggestion', revision: 'proposal-1', confirm: 'Create, start and select this suggestion?' },
      { id: 'proposal:preview', kind: 'action', label: 'Preview suggestion', revision: 'proposal-1' },
    ];
    current.footer = [{ text: '? Suggested task', action: 'proposal:preview', doubleAction: 'proposal:accept' }];
    const actions: string[] = [];
    const h = harness({ view: async () => current, action: async (params) => {
      actions.push(params.action as string);
      if (scenario === 'failed' && params.action === 'proposal:accept') throw new Error('Unavailable');
      return { view: params.action === 'proposal:accept' ? view({ selectedId: 7 }) : structuredClone(current) };
    } });
    await h.session.start([], 'conversation');
    let footer: any, reviews = 0;
    const theme = { fg: (_color: string, text: string) => text, italic: (text: string) => text } as any;
    const ctx = { mode: 'tui', isIdle: () => scenario !== 'busy', ui: {
      theme, setStatus() {}, notify() {}, custom: async () => { reviews++; return false; },
      setWidget: (_key: string, factory: any) => {
        footer = factory({ mode: 'fullscreen', requestRender() {} }, theme);
      },
      select: () => assert.fail('Footer acceptance must not ask again'),
      setEditorText: () => assert.fail('Acceptance must preserve the editor'),
    } } as any;
    const ui = new PinoteUI({} as any, h.session);
    ui.attach(ctx);
    try {
      assert.equal(await ui.dispatch(ctx, h.session.view!, current.controls[0]), false);
      assert.equal(reviews, 1, 'Menu acceptance still requires review');
      assert.deepEqual(actions, []);
      ctx.ui.custom = loader;
      footer.render(80);
      const click = (clickCount: number) => footer.handleMouse({ type: 'click', button: 'left', x: 1, y: 0, clickCount });
      click(1); await sleep(520);
      assert.deepEqual(actions, ['proposal:preview'], 'Single-click only previews');
      footer.render(80);
      if (scenario === 'stale') {
        current.controls[0].revision = 'proposal-2';
        await h.session.refresh(); // Leave the old rendered hit region until repaint.
      }
      click(1); click(2); click(3); await sleep(30);
      assert.deepEqual(actions, scenario === 'stale' ? ['proposal:preview'] : ['proposal:preview', 'proposal:accept'], scenario);
      assert.equal(reviews, 1);
      if (scenario === 'ordinary' || scenario === 'busy') assert.equal(h.session.view?.state.selectedId, 7);
      if (scenario === 'failed') assert.equal(h.session.view, undefined, 'Uncertain acceptance is not replayed');
    } finally { footer.dispose(); await h.session.stop(); }
  }
});

test('tool errors throw, failed fresh context is unavailable rather than cached/no-task', async () => {
  let fail = false;
  const h = harness({
    tool: async () => { throw new Error(token); },
    view: async () => view(),
    context: async () => { if (fail) throw new Error(token); return 'selected task'; },
  });
  await h.session.start([], 'conversation');
  assert.equal(await h.session.context(), 'selected task'); fail = true;
  await assert.rejects(h.session.context(), PinoteFailure);
  await assert.rejects(h.session.tool('get_current', {}), PinoteFailure);
  await h.session.stop();
});

test('session epoch cancels queued and in-flight work without state contamination', async () => {
  let release!: () => void, started!: () => void;
  const began = new Promise<void>((resolve) => { started = resolve; });
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  let calls = 0;
  const h = harness({ tool: async () => { calls++; started(); await waiting; return { result: null, state: { selectedId: 99 } }; } });
  await h.session.start([], 'old');
  const first = h.session.tool('propose', { title: 'old' });
  const second = h.session.tool('propose', { title: 'queued' });
  const rejected = Promise.all([assert.rejects(first, PinoteFailure), assert.rejects(second, PinoteFailure)]);
  await began;
  await h.session.start([], 'new');
  release(); await rejected;
  assert.equal(calls, 1); assert.deepEqual(h.session.snapshot()?.state, {});
  assert.ok(!h.saved.some((state) => state.state.selectedId === 99));
  await h.session.stop();
});

test('stale displayed revisions fail closed; a stale engine error is definitely not-applied', async () => {
  let actions = 0;
  const h = harness({ action: async () => { actions++; throw new StaleAction(); } });
  await h.session.start([], 'conversation');
  const old = view(); old.controls[0].revision = 'obsolete';
  await assert.rejects(h.session.action(old, old.controls[0]), (e: PinoteFailure) => e.stale && !e.uncertain);
  assert.equal(actions, 0);
  const current = h.session.view!;
  await assert.rejects(h.session.action(current, current.controls[0]), (e: PinoteFailure) => e.stale && !e.message.includes(token));
  assert.equal(actions, 1);
  await h.session.stop();
});

test('change notifications coalesce and never reconnect or start model work', async () => {
  let reads = 0;
  const h = harness({ view: async () => { reads++; await sleep(15); return view(); } });
  await h.session.start([], 'conversation');
  for (let i = 0; i < 50; i++) h.changed();
  await sleep(120);
  assert.equal(reads, 2); assert.equal(h.connections(), 1);
  await h.session.stop(); h.changed(); await sleep(100);
  assert.equal(reads, 2);
});

test('native fullscreen footer keeps preview and double completion/acceptance distinct', async () => {
  const { NativeFooter } = await import('../extension/footer.ts');
  const calls: Array<string | undefined> = [];
  const current = view();
  current.controls.push({ id: 'preview', label: 'Preview', kind: 'action', revision: 'task-1' });
  current.footer = [{ text: '▤ ', openApp: true }, { text: 'Task', action: 'preview', doubleAction: 'complete' }];
  const theme = { fg: (_color: string, text: string) => text, italic: (text: string) => text } as any;
  const footer = new NativeFooter(() => [{ uri: 'pinote://ui', view: current }], theme,
    async (_row, item, action) => { calls.push(item.openApp ? 'open' : action); return true; }, () => {});
  footer.render(80);
  const click = (x: number, clickCount: number) => footer.handleMouse({ type: 'click', button: 'left', x, y: 0, clickCount } as any);
  click(3, 1); click(3, 2); await sleep(5);
  assert.deepEqual(calls, ['complete']);
  click(3, 1); await sleep(520);
  assert.deepEqual(calls, ['complete', 'preview']);
  click(0, 1); await sleep(5);
  assert.deepEqual(calls, ['complete', 'preview', 'open']);
  // A proposal has no single-click mutation, only a separately negotiated double action.
  current.footer = [{ text: '? Proposal', doubleAction: 'complete' }]; footer.render(80);
  click(1, 1); await sleep(520); assert.equal(calls.length, 3);
  click(1, 1); click(1, 2); await sleep(5); assert.equal(calls.length, 4);
  footer.dispose();
});

test('required review has no default approval and non-TUI review cannot authorize actions', async () => {
  const { review } = await import('../extension/ui.ts');
  const controller = new AbortController();
  let options: string[] = [];
  const ctx = {
    mode: 'tui', ui: {
      custom: async (factory: any) => new Promise((resolve) => {
        const tui = { terminal: { rows: 30, columns: 80 }, requestRender() {} };
        const theme = { fg: (_color: string, text: string) => text };
        const keys = { matches: (data: string, action: string) => action === 'tui.select.confirm' && data === '\r' };
        const component = factory(tui, theme, keys, resolve);
        component.render(80); component.handleInput('\r'); component.dispose();
      }),
      select: async (_title: string, values: string[]) => { options = values; return values[0]; },
    },
  } as any;
  assert.equal(await review(ctx, 'Confirm change', 'All change details', controller.signal), false);
  assert.deepEqual(options, ['Cancel', 'Confirm']);
  assert.equal(await review({ mode: 'rpc' } as any, 'Confirm', 'details', controller.signal), false);

  const { literal } = await import('../extension/protocol.ts');
  const disclosure = literal('界'.repeat(4000) + 'FINAL_DISCLOSURE_SUFFIX');
  assert.ok(disclosure.length > 20_000);
  const longCtx = { mode: 'tui', ui: {
    select: async () => 'Confirm',
    custom: async (factory: any) => new Promise((resolve) => {
      let completed = false;
      const tui = { terminal: { rows: 30, columns: 80 }, children: [] as any[], requestRender() {} };
      const theme = { fg: (_color: string, value: string) => value };
      const keys = { matches: (data: string, action: string) =>
        (action === 'tui.select.confirm' && data === '\r') || (action === 'tui.select.down' && data === '\x1b[B') };
      const component = factory(tui, theme, keys, (value: boolean) => { completed = true; resolve(value); });
      tui.children = [{ render: () => [] }, { render: () => Array(18).fill('Other dock widget') }, { children: [component] }];
      let rows = component.render(80);
      assert.ok(rows.length <= 11, 'Disclosure must fit below competing dock widgets');
      const displayed = [...rows];
      component.handleInput('\r');
      assert.equal(completed, false, 'Partial disclosure cannot authorize a write');
      for (let line = 0; line < 1000 && !rows.join('\n').includes('Review complete'); line++) {
        component.handleInput('\x1b[B'); rows = component.render(80); displayed.push(...rows);
      }
      assert.match(rows.join('\n'), /Review complete/);
      assert.match(displayed.join('\n'), /FINAL_DISCLOSURE_SUFFIX/, 'The saved suffix must be visible before approval');
      component.handleInput('\r'); component.dispose();
    }),
  } } as any;
  assert.equal(await review(longCtx, 'Save long prompt', disclosure, controller.signal), true);
});

test('menu bounds native layout and preserves search/selection across notification refresh and resize', async () => {
  const { pinoteMenu } = await import('../extension/menu.ts');
  const { initTheme } = await import('@earendil-works/pi-coding-agent');
  initTheme('dark', false);
  const { getKeybindings, visibleWidth } = await import('@earendil-works/pi-tui');
  const state = { search: '', selected: undefined as string | undefined };
  const current = view({ screen: 'settings' });
  current.body = 'Summary '.repeat(100);
  current.controls = Array.from({ length: 20 }, (_, i) => ({ id: `setting-${i}`, kind: 'toggle' as const,
    label: `Setting ${i}`, value: false, description: 'Long selected setting help '.repeat(100) }));
  const tui = { terminal: { rows: 24, columns: 56 }, children: [] as any[], requestRender() {} };
  const theme = { fg: (_color: string, text: string) => text };
  const controller = new AbortController();
  let component: any, changed = () => {}, result: any;
  const ctx = { ui: { custom: async (factory: any) => new Promise((resolve) => {
    component = factory(tui, theme, getKeybindings(), (value: any) => { result = value; resolve(value); });
    // Pi's transcript, inline custom owner, and native footer/widget siblings.
    tui.children = [{ render: () => [] }, { children: [component] }, { render: () => Array(7).fill('footer') }];
  }) } } as any;
  const watch = (callback: () => void) => { changed = callback; return () => {}; };
  const bounded = () => {
    const rows = component.render(tui.terminal.columns);
    assert.ok(rows.length <= tui.terminal.rows - 8, `${rows.length} rows overflow reserved footer`);
    assert.ok(rows.every((row: string) => visibleWidth(row) <= tui.terminal.columns));
    assert.match(rows.join(' ').replace(/\s+/g, ' '), /Ctrl\+R refresh/);
    return rows;
  };
  const first = pinoteMenu(ctx, current, state, controller.signal, watch);
  bounded();
  component.handleInput('Setting'); component.handleInput('\r');
  assert.equal(typeof result, 'undefined', 'Unrendered filter changes cannot activate a stale row');
  component.render(56);
  component.handleInput('\x1b[B'); bounded();
  assert.equal(state.search, 'Setting'); assert.equal(state.selected, 'setting-1');
  changed(); assert.deepEqual(await first, { id: '__changed' }); component.dispose();
  const second = pinoteMenu(ctx, current, state, controller.signal, watch);
  bounded(); assert.equal(state.selected, 'setting-1');
  // Input in a new geometry must not activate until that geometry has rendered.
  tui.terminal.columns = 40; component.handleInput('\r'); assert.equal(result.id, '__changed');
  bounded(); assert.equal(state.selected, 'setting-1');
  tui.terminal.rows = 12; component.render(40); component.handleInput('\r');
  assert.equal(result.id, '__changed');
  tui.terminal.rows = 30; tui.terminal.columns = 80; bounded();
  assert.equal(state.search, 'Setting'); assert.equal(state.selected, 'setting-1');
  component.handleInput('\r');
  assert.deepEqual(await second, { id: 'setting-1' }); component.dispose();
});

test('extension registers eight tools before startup and returns hidden unavailable context', async () => {
  const { default: extension } = await import('../index.ts');
  const tools: string[] = [], commands: string[] = [], handlers = new Map<string, (...args: any[]) => any>();
  extension({
    registerTool: (tool: any) => tools.push(tool.name),
    registerCommand: (name: string) => commands.push(name),
    registerEntryRenderer() {},
    events: { on() { return () => {}; } },
    on: (name: string, handler: (...args: any[]) => any) => handlers.set(name, handler),
  } as any);
  assert.equal(tools.length, 8);
  assert.ok(tools.every((name) => name.startsWith('pinote_')));
  assert.deepEqual(commands, ['pinote']);
  const event = { systemPromptOptions: { sections: {} as Record<string, string> } };
  const { message } = await handlers.get('before_agent_start')!(event, {});
  assert.match(event.systemPromptOptions.sections.pinote_remote, /UNTRUSTED TASK DATA/);
  assert.equal(message.customType, 'pinote-context');
  assert.equal(message.display, false);
  const { service, text } = JSON.parse(message.content);
  assert.equal(service, 'pinote');
  assert.match(text, /UNAVAILABLE/);
  assert.match(text, /Do not infer no task/);
});

const selectedDone = (selectedId: unknown = 7) => {
  const current = view({ selectedId });
  current.controls[0].id = 'done';
  current.footer = [];
  return current;
};

test('acknowledged Done awaits bounded local hooks outside the queue without weakening completion guards', async (t) => {
  const { taskCompleted } = await import('../extension/completion.ts');
  let actions = 0, emitted = 0, release!: () => void, entered!: () => void;
  const began = new Promise<void>((resolve) => { entered = resolve; });
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  const h = harness({ view: async (meta) => selectedDone((meta[UI_CONTEXT] as SavedState).state.selectedId ?? null),
    action: async () => { actions++; return { view: view({ selectedId: null }) }; } });
  await h.session.start([], 'conversation', { scope: SCOPE, contextId: 'test', state: { selectedId: 7 } });
  let hookSignal!: AbortSignal;
  h.session.onCompleted = (id, signal) => taskCompleted({ emit: (name, data) => {
    emitted++; assert.equal(name, 'pinote:task-completed');
    const event = data as import('../extension/completion.ts').TaskCompletedEvent;
    assert.equal(id, 7); assert.equal(event.taskId, 7); hookSignal = event.signal;
    assert.equal(h.session.snapshot()?.state.selectedId, null);
    event.waitUntil((async () => {
      await h.session.tool('get_current', {}); // Would deadlock inside the serial queue.
      entered(); await waiting;
    })());
  } }, id, signal, () => assert.fail('unexpected warning'));
  const current = h.session.view!;
  let returned = false;
  const action = h.session.action(current, current.controls[0]).then(() => { returned = true; });
  await began;
  assert.equal(returned, false); assert.equal(actions, 1); assert.equal(emitted, 1);
  release(); await action;
  assert.equal(hookSignal.aborted, true);
  assert.equal(h.session.snapshot()?.state.selectedId, null);
  await h.session.stop();

  // Invalid, failed and external completions must not emit.
  for (const scenario of ['stale', 'denied', 'failed', 'uncleared', 'other', 'invalid', 'external']) {
    const current = selectedDone(scenario === 'invalid' ? '7' : 7);
    if (scenario === 'other') current.controls[0].id = 'clear';
    const h = harness({ view: async () => current, action: async () => {
      if (scenario === 'failed') throw new Error(token);
      return { view: scenario === 'uncleared' ? current : view({ selectedId: null }) };
    } });
    let emitted = 0;
    h.session.onCompleted = async () => { emitted++; };
    await h.session.start([], 'conversation');
    if (scenario === 'external') { current.state.selectedId = null; await h.session.refresh(); }
    else {
      const displayed = structuredClone(h.session.view!);
      if (scenario === 'stale') displayed.controls[0].revision = 'old';
      const action = h.session.action(displayed, displayed.controls[0], undefined, () => scenario !== 'denied');
      if (['stale', 'denied', 'failed'].includes(scenario)) await assert.rejects(action, PinoteFailure);
      else await action;
    }
    assert.equal(emitted, 0, scenario);
    await h.session.stop();
  }

  // No listeners and late registrations cannot delay completion.
  const lifetime = new AbortController();
  await taskCompleted({ emit() {} }, 7, lifetime.signal, () => assert.fail('unexpected warning'));
  let lateEvent!: import('../extension/completion.ts').TaskCompletedEvent;
  await taskCompleted({ emit: (_name, data) => { lateEvent = data as typeof lateEvent; } }, 7, lifetime.signal, () => assert.fail('unexpected warning'));
  lateEvent.waitUntil(Promise.reject(new Error(token)));
  await Promise.resolve();
  assert.equal(lateEvent.signal.aborted, true);

  // Rejection, cancellation and the total deadline preserve acknowledged success.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const diagnostics = t.mock.method(console, 'error', () => {});
  for (const scenario of ['reject', 'cancel', 'timeout', 'sync-work']) {
    const h = harness({ view: async () => selectedDone() });
    await h.session.start([], 'conversation');
    let entered!: () => void, warnings = 0, emitted = 0;
    const began = new Promise<void>((resolve) => { entered = resolve; });
    let event!: import('../extension/completion.ts').TaskCompletedEvent;
    const events = createEventBus();
    events.on('pinote:task-completed', (data) => {
      emitted++; event = data as typeof event;
      entered();
      event.waitUntil(scenario === 'sync-work' ? Promise.resolve().then(() => { throw new Error(token); }) :
        scenario === 'reject' ? Promise.reject(new Error(token)) : new Promise(() => {}));
      if (scenario === 'timeout') event.waitUntil(new Promise(() => {}));
    });
    h.session.onCompleted = (id, signal) => taskCompleted(events, id, signal, () => { warnings++; });
    const current = h.session.view!;
    let returned = false;
    const action = h.session.action(current, current.controls[0]).then(() => { returned = true; });
    await began;
    if (scenario === 'cancel') await h.session.stop('quit');
    if (scenario === 'timeout') {
      t.mock.timers.tick(24_999); await Promise.resolve(); assert.equal(returned, false);
      t.mock.timers.tick(1);
    }
    await action; // Must resolve, not become an uncertain PinoteFailure.
    assert.equal(emitted, 1); assert.equal(event.signal.aborted, true);
    if (scenario === 'cancel') assert.equal(event.signal.reason, 'quit', 'Shutdown reason reaches completion listeners');
    assert.equal(warnings, scenario === 'cancel' ? 0 : 1);
    assert.equal(h.session.snapshot()?.state.selectedId, null);
    if (scenario !== 'cancel') assert.ok(h.session.view, 'Hook failure must not invalidate a valid view');
    t.mock.timers.tick(25_000);
    assert.equal(warnings, scenario === 'cancel' ? 0 : 1, 'Deadline must be cleared');
    assert.equal(diagnostics.mock.calls.length, 0, 'Registered failures never reach Pi’s raw event-bus logger');
    await h.session.stop();
  }
  diagnostics.mock.restore();
});
