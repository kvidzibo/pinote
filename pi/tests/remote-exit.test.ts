import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { pullBeforeExit, registerRemoteExit } from '../remote/exit.ts';
import type { RemoteSession } from '../remote/session.ts';
import type { NativeView } from '../remote/protocol.ts';

const selected = (): NativeView => ({ version: 1, title: 'Pinote', body: 'Selected task', revision: 'displayed',
  state: { selectedId: 7 }, controls: [{ id: 'done', kind: 'action', label: 'Complete task', revision: 'task-7' }] });
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test('remote editor exit: cancellation, exact approval revision, direct completion and orderly exit', async () => {
  const handlers = new Map<string, Function[]>();
  let launch = false, pulls = 0, pullCode = 0;
  const pi = {
    on: (name: string, handler: Function) => handlers.set(name, [...handlers.get(name) ?? [], handler]),
    exec: async (command: string, args: string[]) => {
      assert.equal(launch, true, 'only dedicated launch completion may pull');
      assert.equal(command, 'git');
      assert.deepEqual(args, ['pull', '--ff-only', '--no-rebase', '--no-autostash']);
      assert.equal(session.view?.state.selectedId, null);
      pulls++;
      return { code: pullCode, killed: false, stdout: '', stderr: '' };
    },
    events: { emit: () => assert.fail('must not use gateway events') },
  } as unknown as ExtensionAPI;
  let text = '', idle = true, leaf = 'branch', shutdowns = 0, aborts = 0, forwarded = 0;
  let refreshes = 0, actions = 0, uncertain = false;
  const notices: string[] = [];
  let resolveChoice: (choice?: string) => void = () => assert.fail('no dialog');
  let dialogSignal: AbortSignal | undefined;
  let displayed: NativeView;
  const session = {
    signal: new AbortController().signal,
    current: () => () => true,
    view: selected() as NativeView | undefined,
    refresh: async (explicit: boolean) => { assert.equal(explicit, true); refreshes++; session.view = selected(); },
    action: async (view: NativeView, control: NativeView['controls'][number]) => {
      actions++;
      assert.equal(view, displayed, 'must submit the displayed view, not a new approval revision');
      assert.equal(control, displayed.controls[0]);
      if (uncertain) { session.view = undefined; throw new Error('uncertain write'); }
      session.view = { ...selected(), state: { selectedId: null }, controls: [] };
      return {};
    },
  };
  const previous = (() => ({ getText: () => text, setText: (value: string) => { text = value; },
    render: () => [], invalidate: () => {}, handleInput: () => { forwarded++; } })) as
    NonNullable<ReturnType<ExtensionContext['ui']['getEditorComponent']>>;
  let factory: ReturnType<ExtensionContext['ui']['getEditorComponent']> = previous;
  const ctx = {
    mode: 'tui', hasUI: true,
    sessionManager: { getSessionId: () => 'session', getLeafId: () => leaf },
    isIdle: () => idle, abort: () => { aborts++; }, shutdown: () => { shutdowns++; },
    ui: {
      getEditorComponent: () => factory,
      setEditorComponent: (next: typeof factory) => { factory = next; },
      getEditorText: () => text,
      notify: (message: string) => notices.push(message),
      select: async (_title: string, options: string[], { signal }: { signal: AbortSignal }) => {
        assert.deepEqual(options, ['Cancel', 'Exit without completing', 'Complete task and exit']);
        displayed = session.view!;
        dialogSignal = signal;
        return new Promise<string | undefined>((resolve) => {
          resolveChoice = resolve;
          signal.addEventListener('abort', () => resolve(undefined), { once: true });
        });
      },
    },
  } as unknown as ExtensionContext;
  const emit = async (name: string) => { for (const handler of handlers.get(name) ?? []) await handler({}, ctx); };
  registerRemoteExit(pi, () => session as unknown as RemoteSession, (taskId) => launch && taskId === 7);
  await emit('session_start');
  let editor = factory!({} as any, {} as any, { matches: (data: string, action: string) => action === 'app.exit' && data === 'configured-exit' } as any);
  const press = async () => { editor.handleInput('configured-exit'); await tick(); };
  const choose = async (choice?: string) => { resolveChoice(choice); await tick(); };
  text = 'draft'; await press(); text = '';
  editor.handleInput('/quit');
  assert.equal(forwarded, 2); assert.equal(refreshes, 0);
  await press(); await choose('Cancel');
  assert.equal(actions, 0); assert.equal(shutdowns, 0);
  for (const event of ['agent_start', 'session_before_switch', 'session_before_fork', 'session_before_tree']) {
    await press(); await emit(event);
    assert.equal(dialogSignal?.aborted, true);
    await choose('Complete task and exit');
  }
  assert.equal(actions, 0);
  await press(); session.view = { ...session.view!, revision: 'newer' };
  const beforeApproval = refreshes;
  await choose('Complete task and exit');
  assert.equal(actions, 0); assert.equal(refreshes, beforeApproval, 'no refresh after approval');
  await press(); leaf = 'other-branch'; await choose('Complete task and exit');
  assert.equal(actions, 0);
  await press(); idle = false; await choose('Complete task and exit');
  assert.equal(actions, 0); idle = true;
  await press(); text = 'new draft'; await choose('Complete task and exit'); text = '';
  assert.equal(actions, 0);
  uncertain = true;
  await press(); const beforeWrite = refreshes; await choose('Complete task and exit');
  assert.equal(actions, 1); assert.equal(shutdowns, 0); assert.equal(refreshes, beforeWrite);
  assert.match(notices.at(-1)!, /refresh .*before retrying/);
  uncertain = false;
  await press(); await choose('Complete task and exit');
  assert.equal(actions, 2); assert.equal(shutdowns, 1); assert.equal(aborts, 0);
  assert.equal(pulls, 0);
  launch = true; pullCode = 1;
  await press(); await choose('Complete task and exit');
  assert.equal(actions, 3); assert.equal(pulls, 1); assert.equal(shutdowns, 1);
  assert.match(notices.at(-1)!, /git pull failed/);
  pullCode = 0;
  await press(); await choose('Complete task and exit');
  assert.equal(actions, 4); assert.equal(pulls, 2); assert.equal(shutdowns, 2);
  idle = false;
  await press(); await choose('Exit without completing');
  assert.equal(actions, 4); assert.equal(shutdowns, 3); assert.equal(aborts, 1);
  session.refresh = async () => { session.view = { ...selected(), state: { selectedId: null } }; };
  await press(); assert.equal(shutdowns, 4);
  await emit('session_shutdown'); assert.equal(factory, previous);
  await emit('session_start');
  editor = factory!({} as any, {} as any, { matches: () => true } as any);
  session.refresh = async () => { session.view = selected(); };
  await press();
  const later = (() => editor) as typeof previous;
  factory = later;
  await emit('session_shutdown');
  assert.equal(dialogSignal?.aborted, true);
  await choose('Complete task and exit');
  assert.equal(actions, 4);
  assert.equal(factory, later, 'must not overwrite later editor wrappers');
});

test('remote /new gates replacement on exact task approval without exiting Pi', async () => {
  const handlers = new Map<string, Function[]>();
  const pi = { on: (name: string, handler: Function) =>
    handlers.set(name, [...handlers.get(name) ?? [], handler]) } as unknown as ExtensionAPI;
  let draft = 'keep my draft', idle = true, leaf = 'branch', actions = 0, refreshes = 0;
  let unavailable = false, uncertain = false, unselected = false;
  let choose: (choice?: string) => void;
  const notices: string[] = [];
  const session = {
    signal: new AbortController().signal, current: () => () => true,
    view: selected() as NativeView | undefined,
    refresh: async () => {
      refreshes++;
      if (unavailable) throw new Error('unavailable');
      session.view = unselected ? { ...selected(), state: { selectedId: null } } : selected();
    },
    action: async (view: NativeView, control: NativeView['controls'][number], _value: unknown, allow: () => boolean) => {
      assert.equal(allow(), true);
      assert.equal(view.revision, 'displayed'); assert.equal(control.revision, 'task-7');
      actions++;
      if (uncertain) { session.view = undefined; throw new Error('uncertain write'); }
      session.view = { ...view, state: { selectedId: null }, controls: [] };
      return {};
    },
  };
  const ctx = {
    mode: 'tui', hasUI: true, isIdle: () => idle,
    shutdown: () => assert.fail('/new must not exit Pi'),
    sessionManager: { getSessionId: () => 'session', getLeafId: () => leaf },
    ui: {
      getEditorComponent: () => undefined, setEditorComponent() {}, getEditorText: () => draft,
      notify: (message: string) => notices.push(message),
      select: async (_title: string, options: string[], { signal }: { signal: AbortSignal }) => {
        assert.deepEqual(options, ['Cancel', 'Start new session without completing', 'Complete task and start new session']);
        return new Promise<string | undefined>((resolve) => {
          choose = resolve;
          signal.addEventListener('abort', () => resolve(undefined), { once: true });
        });
      },
    },
  } as unknown as ExtensionContext;
  const emit = async (name: string, data = {}) => {
    let result;
    for (const handler of handlers.get(name) ?? []) result = await handler(data, ctx) ?? result;
    return result;
  };
  const startNew = () => emit('session_before_switch', { reason: 'new' });
  const decide = async (choice?: string, change = () => {}) => {
    const result = startNew(); await tick(); change(); choose(choice); return result;
  };
  registerRemoteExit(pi, () => session as unknown as RemoteSession);
  await emit('session_start');
  assert.equal(await emit('session_before_switch', { reason: 'resume' }), undefined);
  assert.equal(refreshes, 0, 'resume must not show the new-session prompt');
  assert.deepEqual(await decide('Cancel'), { cancel: true });
  assert.deepEqual(await decide(), { cancel: true }, 'Escape cancels /new');
  assert.equal(await decide('Start new session without completing'), undefined);
  assert.equal(actions, 0); assert.equal(draft, 'keep my draft');
  const complete = 'Complete task and start new session';
  assert.deepEqual(await decide(complete, () => { session.view!.revision = 'changed'; }), { cancel: true });
  assert.deepEqual(await decide(complete, () => { leaf = 'other'; }), { cancel: true });
  assert.deepEqual(await decide(complete, () => { idle = false; }), { cancel: true }); idle = true;
  assert.deepEqual(await decide(complete, () => { draft = 'changed'; }), { cancel: true });
  const interrupted = startNew(); await tick(); await emit('agent_start');
  assert.deepEqual(await interrupted, { cancel: true });
  assert.equal(actions, 0);
  uncertain = true;
  assert.deepEqual(await decide(complete), { cancel: true });
  assert.equal(actions, 1); assert.match(notices.at(-1)!, /refresh .*before retrying/);
  uncertain = false;
  assert.equal(await decide(complete), undefined);
  assert.equal(actions, 2); assert.equal(session.view!.state.selectedId, null);
  unselected = true;
  assert.equal(await startNew(), undefined, 'no selected task needs no prompt');
  unavailable = true;
  assert.deepEqual(await startNew(), { cancel: true }, 'unavailable is not unselected');
  (ctx as any).mode = 'rpc';
  const before = refreshes;
  assert.equal(await startNew(), undefined); assert.equal(refreshes, before);
  await emit('session_shutdown');
});

test('successful pull cannot close a session or draft that changed while it ran', async () => {
  let draft = '', leaf = 'branch', idle = true, current = true;
  let finish: (result: { code: number; killed: boolean }) => void;
  const pi = { exec: () => new Promise((resolve) => { finish = resolve; }) } as unknown as ExtensionAPI;
  const ctx = {
    cwd: '/tmp', isIdle: () => idle,
    sessionManager: { getSessionId: () => 'session', getLeafId: () => leaf },
    ui: { getEditorText: () => draft, notify() {} },
  } as unknown as ExtensionContext;
  for (const change of [() => { draft = 'new draft'; }, () => { leaf = 'other'; },
    () => { idle = false; }, () => { current = false; }]) {
    draft = ''; leaf = 'branch'; idle = true; current = true;
    const pulling = pullBeforeExit(pi, ctx, new AbortController().signal, () => current);
    change();
    finish!({ code: 0, killed: false });
    assert.equal(await pulling, false);
  }
});
