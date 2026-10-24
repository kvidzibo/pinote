import { randomUUID } from 'node:crypto';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { connectPeer, remoteFailure, RemoteFailure, type Peer, type PeerFactory, type RemoteConfig } from './client.ts';
import { StateSchema, ViewSchema, UI_CONTEXT, UI_FEATURES, UI_STATE, type NativeView, type NativeControl } from './protocol.ts';

export const ENTRY_TYPE = 'pinote-remote-v1';
export interface SavedState { scope: string; contextId: string; state: Record<string, unknown>; retainOnNew?: boolean }
export interface BranchEntry { type: string; customType?: string; data?: unknown }
export function restoreState(branch: readonly BranchEntry[], scope: string): SavedState {
  let saved: SavedState = { scope, contextId: randomUUID(), state: {} };
  for (const entry of branch) {
    if (entry.type !== 'custom' || entry.customType !== ENTRY_TYPE) continue;
    const data = entry.data as SavedState | undefined;
    if (data?.scope === scope && typeof data.contextId === 'string' && data.contextId.length > 0 && data.contextId.length <= 256 && StateSchema.safeParse(data.state).success) saved = structuredClone(data);
  }
  return saved;
}

/** One queue owns state, reads and writes; queued work belongs to its originating epoch. */
export class RemoteSession {
  private epoch = 0;
  private lifetime = new AbortController();
  private connection?: AbortController;
  private peer?: Peer;
  private queue: Promise<unknown> = Promise.resolve();
  private refreshTimer?: ReturnType<typeof setTimeout>;
  private dirty = false;
  private refreshing = false;
  private active = false;
  private conversationId = '';
  private saved?: SavedState;
  view?: NativeView;
  fullscreen = false;
  onChange = () => {};
  private config: RemoteConfig;
  private persist: (saved: SavedState) => void;
  private factory: PeerFactory;
  constructor(config: RemoteConfig, persist: (saved: SavedState) => void, factory: PeerFactory = connectPeer) {
    this.config = config; this.persist = persist; this.factory = factory;
  }
  get signal(): AbortSignal { return this.lifetime.signal; }
  snapshot(): SavedState | undefined { return this.saved && structuredClone(this.saved); }
  current(): () => boolean { const epoch = this.epoch; return () => this.active && epoch === this.epoch; }
  async start(branch: readonly BranchEntry[], conversationId: string, carried?: SavedState): Promise<void> {
    await this.stop();
    this.lifetime = new AbortController(); this.active = true;
    this.conversationId = conversationId;
    this.saved = carried?.scope === this.config.scope ? structuredClone(carried) : restoreState(branch, this.config.scope);
    this.persist(this.saved);
    await this.refresh(true);
  }
  async stop(): Promise<void> {
    this.active = false; this.epoch++; this.lifetime.abort(); this.connection?.abort();
    clearTimeout(this.refreshTimer); this.refreshTimer = undefined; this.dirty = false; this.refreshing = false;
    const peer = this.peer; this.peer = undefined; this.view = undefined;
    this.queue = Promise.resolve(); this.onChange();
    await peer?.close().catch(() => {});
  }
  private meta(): Record<string, unknown> {
    if (!this.saved) throw new RemoteFailure();
    return {
      [UI_CONTEXT]: { conversationId: this.conversationId, contextId: this.saved.contextId, state: this.saved.state },
      [UI_FEATURES]: { actionRevisions: true, footerStyles: true, footerDoubleActions: true, footerSecondaryActions: true, footerNativeActions: this.fullscreen },
    };
  }
  private serial<T>(run: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const current = this.current();
    const work = this.queue.catch(() => {}).then(async () => {
      if (!current()) throw new RemoteFailure();
      signal?.throwIfAborted();
      return run();
    });
    this.queue = work;
    return work;
  }
  private async connected(explicit: boolean): Promise<Peer> {
    if (this.peer) return this.peer;
    if (!explicit || !this.active) throw new RemoteFailure();
    const current = this.current(), connection = new AbortController();
    this.connection?.abort(); this.connection = connection;
    const peer = await this.factory(this.config, AbortSignal.any([connection.signal, this.signal]),
      () => { if (current() && this.connection === connection) this.changed(); },
      () => {
        if (current() && this.connection === connection) { this.peer = undefined; this.view = undefined; this.onChange(); }
      });
    if (!current() || connection.signal.aborted) { await peer.close().catch(() => {}); throw new RemoteFailure(); }
    this.peer = peer;
    return peer;
  }
  private failed(error: unknown, mutation: boolean): never {
    this.view = undefined;
    const peer = this.peer; this.peer = undefined; this.connection?.abort();
    void peer?.close().catch(() => {}); this.onChange();
    throw remoteFailure(error, mutation);
  }
  private apply(view: NativeView): void {
    const changed = JSON.stringify(this.saved?.state) !== JSON.stringify(view.state) || this.saved?.retainOnNew !== view.retainOnNew;
    this.view = view;
    this.saved = { ...this.saved!, state: view.state, retainOnNew: view.retainOnNew };
    if (changed) this.persist(structuredClone(this.saved));
    this.onChange();
  }
  private async readView(peer: Peer, signal: AbortSignal): Promise<void> {
    const current = this.current();
    const result = await peer.read('pinote://ui', this.meta(), signal);
    if (!current()) throw new RemoteFailure();
    const text = result.contents.find((c) => c.mimeType === 'application/vnd.mcp-native-ui+json')?.text;
    if (!text || text.length > 256_000) throw new Error('Invalid Pinote view');
    this.apply(ViewSchema.parse(JSON.parse(text)));
  }
  refresh(explicit = false): Promise<void> {
    return this.serial(async () => {
      const current = this.current();
      try { await this.readView(await this.connected(explicit), this.signal); }
      catch (error) { if (current()) this.failed(error, false); throw new RemoteFailure(); }
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
        const result = await peer.read('pinote://agent-context', this.meta(), signal ? AbortSignal.any([this.signal, signal]) : this.signal);
        if (!current()) throw new RemoteFailure();
        const text = result.contents.find((c) => c.mimeType === 'application/vnd.mcp-agent-context+json')?.text;
        if (!text || text.length > 400_000) throw new Error('Invalid context');
        const data = JSON.parse(text);
        if (!data || Object.keys(data).sort().join(',') !== 'text,version' || data.version !== 1 || typeof data.text !== 'string' || data.text.length > 64_000) throw new Error('Invalid context');
        return data.text;
      } catch (error) { if (current()) this.failed(error, false); throw new RemoteFailure(); }
    }, signal);
  }
  tool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<CallToolResult> {
    return this.serial(async () => {
      const current = this.current(), mutation = ['propose', 'update_current'].includes(name);
      let attempted = false;
      try {
        const peer = await this.connected(true);
        attempted = true;
        const result = await peer.tool(name, args, this.meta(), signal ? AbortSignal.any([this.signal, signal]) : this.signal);
        if (!current()) throw new RemoteFailure(mutation);
        if (result.isError) throw new Error('Tool failed');
        if (result._meta && UI_STATE in result._meta) {
          const state = StateSchema.parse(result._meta[UI_STATE]);
          if (JSON.stringify(this.saved!.state) !== JSON.stringify(state)) {
            this.saved = { ...this.saved!, state };
            this.persist(structuredClone(this.saved));
          }
        }
        // Refresh failure must not turn an acknowledged write into a replay opportunity.
        try { await this.readView(peer, this.signal); } catch { if (current()) { this.view = undefined; this.onChange(); } }
        if (!current()) throw new RemoteFailure(mutation);
        return result;
      } catch (error) { if (current()) this.failed(error, mutation && attempted); throw new RemoteFailure(mutation && attempted); }
    }, signal);
  }
  action(view: NativeView, control: NativeControl, value?: NativeControl['value']): Promise<{ draft?: string; preview?: string }> {
    return this.serial(async () => {
      const current = this.current(); let attempted = false;
      const latest = this.view?.controls.find((c) => c.id === control.id && c.kind === control.kind);
      if (!latest || (control.revision ? latest.revision !== control.revision : this.view?.revision !== view.revision)) throw new RemoteFailure(false, true);
      try {
        const peer = await this.connected(true); attempted = true;
        const result = await peer.action({ uri: 'pinote://ui', action: control.id, revision: control.revision ?? view.revision, ...(value === undefined ? {} : { value }), _meta: this.meta() }, this.signal);
        if (!current()) throw new RemoteFailure(true);
        this.apply(result.view);
        return result;
      } catch (error) { if (current()) this.failed(error, attempted); throw new RemoteFailure(attempted); }
    });
  }
}
