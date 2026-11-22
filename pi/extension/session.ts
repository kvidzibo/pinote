import { randomUUID } from 'node:crypto';
import { connectPeer, failure, PinoteFailure, type Peer, type PeerFactory } from './client.ts';
import { StateSchema, ViewSchema, UI_CONTEXT, UI_FEATURES, type NativeView, type NativeControl } from './protocol.ts';

export const ENTRY_TYPE = 'pinote-remote-v1';
export interface SavedState { scope: string; contextId: string; state: Record<string, unknown>; retainOnNew?: boolean; fieldReceipts?: string[] }
export interface BranchEntry { type: string; customType?: string; data?: unknown }
/** Entries refer to this machine's task storage. Entries saved by the former HTTP client carry
 * an endpoint hash as scope; PinoteSession.start verifies them before use. */
export const SCOPE = 'local';
export function restoreState(branch: readonly BranchEntry[]): SavedState {
  let saved: SavedState = { scope: SCOPE, contextId: randomUUID(), state: {} };
  for (const entry of branch) {
    if (entry.type !== 'custom' || entry.customType !== ENTRY_TYPE) continue;
    const data = entry.data as SavedState | undefined;
    if (data && typeof data.contextId === 'string' && data.contextId.length > 0 && data.contextId.length <= 256 && StateSchema.safeParse(data.state).success) {
      saved = structuredClone(data);
      saved.fieldReceipts = Array.isArray(data.fieldReceipts) ? data.fieldReceipts.filter((id) => typeof id === 'string' && /^[a-f0-9-]{36}$/.test(id)).slice(-4096) : [];
    }
  }
  return saved;
}

/** One queue owns state, reads and writes; queued work belongs to its originating epoch. */
export class PinoteSession {
  private epoch = 0;
  private lifetime = new AbortController();
  private connection?: AbortController;
  private peer?: Peer;
  private queue: Promise<unknown> = Promise.resolve();
  private refreshTimer?: ReturnType<typeof setTimeout>;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private reconnectDelay = 1000;
  private dirty = false;
  private refreshing = false;
  private active = false;
  private conversationId = '';
  private piSessionId?: string;
  private saved?: SavedState;
  view?: NativeView;
  fullscreen = false;
  onChange = () => {};
  onCompleted?: (taskId: number, signal: AbortSignal) => Promise<void>;
  onFieldNotification?: (notice: NonNullable<NativeView['fieldNotifications']>[number]) => boolean;
  private persist: (saved: SavedState) => void;
  private factory: PeerFactory;
  constructor(persist: (saved: SavedState) => void, factory: PeerFactory = connectPeer) {
    this.persist = persist; this.factory = factory;
  }
  get signal(): AbortSignal { return this.lifetime.signal; }
  snapshot(): SavedState | undefined { return this.saved && structuredClone(this.saved); }
  current(): () => boolean { const epoch = this.epoch; return () => this.active && epoch === this.epoch; }
  async start(branch: readonly BranchEntry[], conversationId: string, carried?: SavedState, piSessionId?: string): Promise<void> {
    await this.stop();
    this.lifetime = new AbortController(); this.active = true;
    this.conversationId = conversationId;
    this.piSessionId = piSessionId;
    const restored = carried ? structuredClone(carried) : restoreState(branch);
    // Nothing may read an unverified selection: expose empty state until adoption decides.
    this.saved = restored.scope === SCOPE ? restored : { ...restored, scope: SCOPE, state: {} };
    if (restored.scope !== SCOPE) await this.adopt(restored.state.selectedId);
    this.persist(this.saved);
    await this.refresh(true);
  }
  /** A selection saved by the former HTTP client may name another database's task. Keep it only
   * if this machine's task records this Pi session among those that selected it; else start unselected. */
  private async adopt(id: unknown): Promise<void> {
    const current = this.current();
    let known = false;
    if (typeof id === 'number' && this.piSessionId) {
      try {
        const { result } = await (await this.connected(true)).tool('get_task', { task_id: id },
          { [UI_CONTEXT]: { conversationId: this.conversationId, state: {} } }, this.signal);
        const sessions = (result as { 'pi-sessions'?: unknown } | null)?.['pi-sessions'];
        known = Array.isArray(sessions) && sessions.includes(this.piSessionId);
      } catch { /* Unverifiable: fail closed. */ }
    }
    if (known && current()) this.saved = { ...this.saved!, state: { selectedId: id } };
  }
  async stop(reason?: string): Promise<void> {
    this.active = false; this.epoch++; this.lifetime.abort(reason); this.connection?.abort();
    clearTimeout(this.refreshTimer); this.refreshTimer = undefined; this.dirty = false; this.refreshing = false;
    clearTimeout(this.reconnectTimer); this.reconnectTimer = undefined; this.reconnectDelay = 1000;
    const peer = this.peer; this.peer = undefined; this.view = undefined;
    this.queue = Promise.resolve(); this.onChange();
    await peer?.close().catch(() => {});
  }
  private meta(): Record<string, unknown> {
    if (!this.saved) throw new PinoteFailure();
    return {
      [UI_CONTEXT]: { conversationId: this.conversationId, piSessionId: this.piSessionId, contextId: this.saved.contextId, state: this.saved.state, fieldReceipts: this.saved.fieldReceipts ?? [] },
      [UI_FEATURES]: { actionRevisions: true, fieldEvents: true, fieldReceiptGroups: true, fieldWatchers: true, watcherDiagnostics: true, footerStyles: true, footerDoubleActions: true, footerSecondaryActions: true, footerNativeActions: this.fullscreen },
    };
  }
  private serial<T>(run: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const current = this.current();
    const work = this.queue.catch(() => {}).then(async () => {
      if (!current()) throw new PinoteFailure();
      signal?.throwIfAborted();
      return run();
    });
    this.queue = work;
    return work;
  }
  private async connected(explicit: boolean): Promise<Peer> {
    if (this.peer) return this.peer;
    if (!explicit || !this.active) throw new PinoteFailure();
    const current = this.current(), connection = new AbortController();
    this.connection?.abort(); this.connection = connection;
    const peer = await this.factory(() => { if (current() && this.connection === connection) this.changed(); });
    if (!current() || connection.signal.aborted) { await peer.close().catch(() => {}); throw new PinoteFailure(); }
    this.peer = peer;
    return peer;
  }
  private disconnected(): void {
    this.view = undefined;
    const peer = this.peer, connection = this.connection;
    this.peer = undefined; this.connection = undefined;
    connection?.abort(); void peer?.close().catch(() => {});
    this.reconnect(); this.onChange();
  }
  private failed(error: unknown, mutation: boolean): never {
    this.disconnected();
    throw failure(error, mutation);
  }
  /** Recover only the current view: never retry a tool, action or launch handoff. */
  private reconnect(): void {
    if (!this.active || this.view || this.reconnectTimer) return;
    const current = this.current();
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (!current()) return;
      void this.serial(async () => {
        if (this.view) return;
        try { await this.readView(await this.connected(true), this.signal); }
        catch (error) { if (current()) this.failed(error, false); }
      }).catch(() => {});
    }, this.reconnectDelay);
    this.reconnectTimer.unref();
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30_000);
  }
  get hasPendingFieldNotifications(): boolean {
    const receipts = new Set(this.saved?.fieldReceipts ?? []);
    return !!this.view?.fieldNotifications?.some((notice) => notice.taskId === this.view?.state.selectedId && (notice.receiptIds ?? [notice.id]).some((id) => !receipts.has(id)));
  }
  private apply(view: NativeView): void {
    clearTimeout(this.reconnectTimer); this.reconnectTimer = undefined; this.reconnectDelay = 1000;
    let changed = JSON.stringify(this.saved?.state) !== JSON.stringify(view.state) || this.saved?.retainOnNew !== view.retainOnNew;
    this.view = view;
    this.saved = { ...this.saved!, state: view.state, retainOnNew: view.retainOnNew };
    const receipts = new Set(this.saved.fieldReceipts ?? []);
    let delivered = false;
    for (const notice of view.fieldNotifications ?? []) {
      const ids = notice.receiptIds ?? [notice.id];
      if (notice.taskId !== view.state.selectedId || ids.every((id) => receipts.has(id))) continue;
      if (this.onFieldNotification?.(notice)) {
        for (const id of ids) receipts.add(id);
        changed = delivered = true;
      }
    }
    if (receipts.size) this.saved.fieldReceipts = [...receipts].slice(-4096);
    if (changed) this.persist(structuredClone(this.saved));
    this.onChange();
    // Receipt-filtered pages let later alerts progress even when earlier failures persist.
    if (delivered) this.changed();
  }
  private async readView(peer: Peer, signal: AbortSignal): Promise<void> {
    const current = this.current();
    const view = await peer.view(this.meta(), signal);
    if (!current() || this.peer !== peer) throw new PinoteFailure();
    this.apply(ViewSchema.parse(view));
  }
  refresh(explicit = false): Promise<void> {
    return this.serial(async () => {
      const current = this.current();
      try { await this.readView(await this.connected(explicit), this.signal); }
      catch (error) { if (current()) this.failed(error, false); throw new PinoteFailure(); }
    });
  }
  private changed(): void {
    this.dirty = true;
    if (this.refreshTimer || this.refreshing) return;
    const current = this.current();
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      if (!current() || !this.dirty || !this.peer) return;
      this.refreshing = true;
      void (async () => {
        try {
          do { this.dirty = false; await this.refresh(); }
          while (current() && this.dirty && this.peer);
        } catch { /* Refresh already cleared unavailable UI; no model turn. */ }
        finally { if (current()) this.refreshing = false; }
      })();
    }, 75);
  }
  context(signal?: AbortSignal): Promise<string> {
    return this.serial(async () => {
      const current = this.current();
      try {
        const peer = await this.connected(true);
        const text = await peer.context(this.meta(), signal ? AbortSignal.any([this.signal, signal]) : this.signal);
        if (!current() || this.peer !== peer) throw new PinoteFailure();
        return text;
      } catch (error) { if (current()) this.failed(error, false); throw new PinoteFailure(); }
    }, signal);
  }
  /** Resolves to the tool's JSON result. */
  tool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    return this.serial(async () => {
      const current = this.current(), mutation = ['propose', 'suggest_later', 'update_current'].includes(name);
      let attempted = false;
      try {
        const peer = await this.connected(true);
        attempted = true;
        const { result, state: next } = await peer.tool(name, args, this.meta(), signal ? AbortSignal.any([this.signal, signal]) : this.signal);
        if (!current() || this.peer !== peer) throw new PinoteFailure(mutation);
        if (next) {
          const state = StateSchema.parse(next);
          if (JSON.stringify(this.saved!.state) !== JSON.stringify(state)) {
            this.saved = { ...this.saved!, state };
            this.persist(structuredClone(this.saved));
          }
        }
        // Recover the view separately; never replay an acknowledged write.
        try { await this.readView(peer, this.signal); } catch { if (current()) this.disconnected(); }
        if (!current()) throw new PinoteFailure(mutation);
        return result;
      } catch (error) { if (current()) this.failed(error, mutation && attempted); throw new PinoteFailure(mutation && attempted); }
    }, signal);
  }
  async action(view: NativeView, control: NativeControl, value?: NativeControl['value'], allow = () => true): Promise<{ draft?: string; preview?: string; notice?: string }> {
    const signal = this.signal;
    let completedId: number | undefined;
    const result = await this.serial(async () => {
      const current = this.current(); let attempted = false;
      if (!allow()) throw new PinoteFailure(false, true);
      const latest = this.view?.controls.find((c) => c.id === control.id && c.kind === control.kind);
      if (!latest || (control.revision ? latest.revision !== control.revision : this.view?.revision !== view.revision)) throw new PinoteFailure(false, true);
      try {
        const peer = await this.connected(true);
        if (!allow()) throw new PinoteFailure(false, true);
        const taskId = this.view?.state.selectedId;
        attempted = true;
        const { view: next, ...result } = await peer.action({ action: control.id, revision: control.revision ?? view.revision, ...(value === undefined ? {} : { value }), _meta: this.meta() }, this.signal);
        if (!current() || this.peer !== peer) throw new PinoteFailure(true);
        const applied = ViewSchema.parse(next);
        this.apply(applied);
        if (control.id === 'done' && control.kind === 'action' &&
            typeof taskId === 'number' && Number.isSafeInteger(taskId) && taskId > 0 &&
            applied.state.selectedId == null) completedId = taskId;
        return result;
      } catch (error) {
        if (!attempted && error instanceof PinoteFailure && error.stale) throw error;
        if (current()) this.failed(error, attempted);
        throw new PinoteFailure(attempted);
      }
    });
    // Outside the serial queue: trusted listeners may query this session themselves.
    // Hook failures cannot invalidate or replay the acknowledged write.
    if (completedId !== undefined && !signal.aborted) {
      try { await this.onCompleted?.(completedId, signal); } catch { /* Best effort only. */ }
    }
    return result;
  }
}
