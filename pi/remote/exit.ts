import { CustomEditor, type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { truncateToWidth } from '@earendil-works/pi-tui';
import { clean } from './protocol.ts';
import type { RemoteSession } from './session.ts';

const leave = 'Exit without completing';
const complete = 'Complete task and exit';

/** Default remote companion. /quit and nonempty-editor input remain Pi-owned. */
export function registerRemoteExit(pi: ExtensionAPI, getSession: () => RemoteSession | undefined): void {
  let invalidate: (() => void) | undefined;
  let stop: (() => void) | undefined;
  pi.on('session_start', (_event, ctx) => {
    stop?.();
    if (ctx.mode !== 'tui' || !ctx.hasUI) return;
    const previous = ctx.ui.getEditorComponent();
    let alive = true, pending = false, epoch = 0;
    let controller: AbortController | undefined;
    invalidate = () => { epoch++; controller?.abort(); };
    const exit = async () => {
      if (!alive || pending) return;
      pending = true;
      const generation = epoch, session = getSession();
      const operation = controller = new AbortController();
      const sessionId = ctx.sessionManager.getSessionId();
      const validSession = session?.current();
      const current = () => alive && generation === epoch && !operation.signal.aborted &&
        session === getSession() && !!validSession?.() &&
        ctx.sessionManager.getSessionId() === sessionId && ctx.ui.getEditorText().length === 0;
      const shutdown = () => { if (!ctx.isIdle()) ctx.abort(); ctx.shutdown(); };
      try {
        if (!session) throw new Error('unavailable');
        await session.refresh(true);
        if (!current()) return;
        const view = session.view;
        if (!view) throw new Error('unavailable');
        if (view.state.selectedId == null) { shutdown(); return; }
        const branch = ctx.sessionManager.getLeafId();
        const done = view.controls.find((c) => c.id === 'done' && c.kind === 'action');
        const title = truncateToWidth(clean((view.body ?? view.title).split('\n', 1)[0]), 70);
        const choice = await ctx.ui.select(`Pinote · ${title}`, ['Cancel', leave, complete], {
          signal: AbortSignal.any([operation.signal, session.signal]),
        });
        if (!current()) return;
        if (choice === leave) { shutdown(); return; }
        if (choice !== complete) return;
        const latest = session.view;
        if (!ctx.isIdle() || ctx.sessionManager.getLeafId() !== branch || !done ||
            !latest || latest.state.selectedId !== view.state.selectedId || latest.revision !== view.revision ||
            !latest.controls.some((c) => c.id === done.id && c.kind === done.kind && c.revision === done.revision)) {
          throw new Error('changed');
        }
        // Approval belongs to this exact displayed view, never to a refreshed revision.
        await session.action(view, done, undefined, () => ctx.isIdle());
        if (!current()) return;
        if (session.view && session.view.state.selectedId == null) ctx.shutdown();
        else ctx.ui.notify('Pinote: Pi stayed open because the selection was not cleared. Refresh /pinote before retrying.', 'warning');
      } catch {
        if (alive && generation === epoch) ctx.ui.notify('Pinote: Pi stayed open. Completion was not confirmed and may have committed; refresh /pinote before retrying. /quit exits without completing.', 'warning');
      } finally { pending = false; }
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
  pi.on('session_shutdown', () => { stop?.(); stop = invalidate = undefined; });
  const interrupted = () => { invalidate?.(); };
  pi.on('agent_start', interrupted);
  pi.on('session_before_switch', interrupted);
  pi.on('session_before_fork', interrupted);
  pi.on('session_before_tree', interrupted);
}
