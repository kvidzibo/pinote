import { dirname, join } from 'node:path';
import { createPinoteEngine, StaleAction } from '../engine.ts';
import { FieldAutomation } from '../field-events.ts';

export class PinoteFailure extends Error {
  readonly uncertain: boolean;
  readonly stale: boolean;
  constructor(uncertain = false, stale = false) {
    super(stale ? 'Action not applied: state changed. Refresh and review before retrying.' :
      `Pinote request failed.${uncertain ? ' The write may have committed; refresh before retrying.' : ' Context unavailable; retrying in the background.'}`);
    this.uncertain = uncertain && !stale; this.stale = stale;
  }
}
/** Local task storage as one session sees it. Every call carries the conversation's saved state. */
export interface Peer {
  view(meta: Record<string, unknown>, signal: AbortSignal): Promise<unknown>;
  context(meta: Record<string, unknown>, signal: AbortSignal): Promise<string>;
  tool(name: string, args: Record<string, unknown>, meta: Record<string, unknown>, signal: AbortSignal): Promise<{ result: unknown; state?: unknown }>;
  action(params: Record<string, unknown>, signal: AbortSignal): Promise<{ view: unknown; draft?: string; preview?: string; notice?: string }>;
  close(): Promise<void>;
}
export type PeerFactory = (changed: () => void) => Promise<Peer>;
/** Reads watcher results that the desktop's scheduler saves; this process never runs watchers. */
export const connectPeer: PeerFactory = async (changed) => {
  let automation: FieldAutomation | undefined;
  try { automation = await FieldAutomation.open(); } catch { /* Tasks stay usable without watcher results. */ }
  const engine = createPinoteEngine({ fieldAutomation: automation, onChanged: changed,
    watcherLogPath: automation && join(dirname(automation.path), 'watchers.log') });
  return { ...engine, async close() { engine.close(); await automation?.close(); } };
};
/** Stable errors only: CLI output and task data never reach notices. */
export function failure(error: unknown, mutation: boolean): PinoteFailure {
  return new PinoteFailure(mutation, error instanceof StaleAction);
}
