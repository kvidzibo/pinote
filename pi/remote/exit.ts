import { CustomEditor, type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { truncateToWidth } from '@earendil-works/pi-tui';
import { clean } from './protocol.ts';
import type { RemoteSession } from './session.ts';

/** Default remote companion. /quit and nonempty-editor exit input remain Pi-owned. */
export function registerRemoteExit(pi: ExtensionAPI, getSession: () => RemoteSession | undefined): void {
  let invalidate: (() => void) | undefined;
  let stop: (() => void) | undefined;
  let confirm: ((reason: 'exit' | 'new') => Promise<boolean>) | undefined;
  pi.on('session_start', (_event, ctx) => {
    stop?.();
    if (ctx.mode !== 'tui' || !ctx.hasUI) return;
    const previous = ctx.ui.getEditorComponent();
    let alive = true, pending = false, epoch = 0;
    let controller: AbortController | undefined;
    invalidate = () => { epoch++; controller?.abort(); };
    confirm = async (reason) => {
      if (!alive || pending) return false;
      const leave = reason === 'new' ? 'Start new session without completing' : 'Exit without completing';
      const complete = reason === 'new' ? 'Complete task and start new session' : 'Complete task and exit';
      pending = true;
      const generation = epoch, session = getSession();
      const operation = controller = new AbortController();
      const sessionId = ctx.sessionManager.getSessionId();
      const draft = ctx.ui.getEditorText();
      const validSession = session?.current();
      const current = () => alive && generation === epoch && !operation.signal.aborted &&
        session === getSession() && !!validSession?.() &&
        ctx.sessionManager.getSessionId() === sessionId &&
        (reason === 'exit' ? ctx.ui.getEditorText().length === 0 : ctx.ui.getEditorText() === draft);
      try {
        if (!session) throw new Error('unavailable');
        await session.refresh(true);
        if (!current()) return false;
        const view = session.view;
        if (!view) throw new Error('unavailable');
        if (view.state.selectedId == null) return true;
        const branch = ctx.sessionManager.getLeafId();
        const done = view.controls.find((c) => c.id === 'done' && c.kind === 'action');
        const title = truncateToWidth(clean((view.body ?? view.title).split('\n', 1)[0]), 70);
        const choice = await ctx.ui.select(`Pinote · ${title}`, ['Cancel', leave, complete], {
          signal: AbortSignal.any([operation.signal, session.signal]),
        });
        if (!current()) return false;
        if (choice === leave) return true;
        if (choice !== complete) return false;
        const latest = session.view;
        if (!ctx.isIdle() || ctx.sessionManager.getLeafId() !== branch || !done ||
            !latest || latest.state.selectedId !== view.state.selectedId || latest.revision !== view.revision ||
            !latest.controls.some((c) => c.id === done.id && c.kind === done.kind && c.revision === done.revision)) {
          throw new Error('changed');
        }
        // Approval belongs to this exact displayed view, never to a refreshed revision.
        await session.action(view, done, undefined, () => current() && ctx.isIdle() && ctx.sessionManager.getLeafId() === branch);
        if (!current()) return false;
        if (session.view && session.view.state.selectedId == null) return true;
        ctx.ui.notify('Pinote: Pi stayed in this session because the selection was not cleared. Refresh /pinote before retrying.', 'warning');
      } catch {
        if (alive && generation === epoch) ctx.ui.notify('Pinote: Pi stayed in this session. Completion was not confirmed and may have committed; refresh /pinote before retrying. /quit exits without completing.', 'warning');
      } finally { pending = false; }
      return false;
    };
    const exit = async () => {
      if (await confirm?.('exit')) {
        if (!ctx.isIdle()) ctx.abort();
        ctx.shutdown();
      }
    };
    const factory: NonNullable<ReturnType<typeof ctx.ui.getEditorComponent>> = (tui, theme, keybindings) => {
      const editor = previous ? previous(tui, theme, keybindings) : new CustomEditor(tui, theme, keybindings);
      const handleInput = editor.handleInput.bind(editor);
      editor.handleInput = (data) => {
        if (alive && keybindings.matches(data, 'app.exit') && editor.getText().length === 0) { void exit(); return; }
        handleInput(data);
      };
      return editor;
    };
    ctx.ui.setEditorComponent(factory);
    stop = () => {
      alive = false;
      invalidate?.();
      if (ctx.ui.getEditorComponent() === factory) ctx.ui.setEditorComponent(previous);
    };
  });
  pi.on('session_shutdown', () => { stop?.(); stop = invalidate = confirm = undefined; });
  const interrupted = () => { invalidate?.(); };
  pi.on('agent_start', interrupted);
  pi.on('session_before_switch', async (event, ctx) => {
    interrupted();
    if (event.reason === 'new' && ctx.mode === 'tui' && ctx.hasUI && !await confirm?.('new')) {
      return { cancel: true };
    }
  });
  pi.on('session_before_fork', interrupted);
  pi.on('session_before_tree', interrupted);
}
