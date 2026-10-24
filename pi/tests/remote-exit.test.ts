import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { registerRemoteExit } from '../remote/exit.ts';
import type { RemoteSession } from '../remote/session.ts';
import type { NativeView } from '../remote/protocol.ts';

const selected = (): NativeView => ({ version: 1, title: 'Pinote', body: 'Selected task', revision: 'displayed',
  state: { selectedId: 7 }, controls: [{ id: 'done', kind: 'action', label: 'Complete task', revision: 'task-7' }] });
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test('remote editor exit: cancellation, exact approval revision, direct completion and orderly exit', async () => {
  const handlers = new Map<string, Function[]>();
  const pi = {
    on: (name: string, handler: Function) => handlers.set(name, [...handlers.get(name) ?? [], handler]),
    exec: () => assert.fail('must not execute local CLI'),
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
  registerRemoteExit(pi, () => session as unknown as RemoteSession);
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
  idle = false;
  await press(); await choose('Exit without completing');
  assert.equal(actions, 2); assert.equal(shutdowns, 2); assert.equal(aborts, 1);
  session.refresh = async () => { session.view = { ...selected(), state: { selectedId: null } }; };
  await press(); assert.equal(shutdowns, 3);
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
  assert.equal(actions, 2);
  assert.equal(factory, later, 'must not overwrite later editor wrappers');
});
