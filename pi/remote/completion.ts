import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

export interface TaskCompletedEvent {
  taskId: number;
  signal: AbortSignal;
  /** Register during synchronous event dispatch, before the listener's first await. */
  waitUntil(work: Promise<unknown>): void;
}

/** Local, best-effort work only; never turn an acknowledged Done into a failed write. */
export async function taskCompleted(
  events: Pick<ExtensionAPI['events'], 'emit'>,
  taskId: number,
  lifetime: AbortSignal,
  warn: () => void,
): Promise<void> {
  if (lifetime.aborted) return;
  const controller = new AbortController();
  const work: Promise<unknown>[] = [];
  let accepting = true, warned = false;
  const warning = () => {
    if (warned) return;
    warned = true;
    try { warn(); } catch { /* Diagnostics must not affect completion. */ }
  };
  let finish!: () => void;
  const cancelled = new Promise<void>((resolve) => { finish = resolve; });
  const cancel = () => { controller.abort(); finish(); };
  lifetime.addEventListener('abort', cancel, { once: true });
  // One deadline covers dispatch and all listeners, not 25 seconds per listener.
  const timer = setTimeout(() => { warning(); cancel(); }, 25_000);
  try {
    try {
      events.emit('pinote:task-completed', {
        taskId, signal: controller.signal,
        waitUntil(promise: Promise<unknown>) {
          const registered = accepting;
          const observed = Promise.resolve(promise).catch(() => { if (registered && !controller.signal.aborted) warning(); });
          if (registered) work.push(observed);
        },
      } satisfies TaskCompletedEvent);
    } catch { warning(); } // Dispatch failures only; Pi itself catches listener exceptions.
    finally { accepting = false; }
    if (work.length) await Promise.race([Promise.all(work), cancelled]);
  } finally {
    clearTimeout(timer);
    lifetime.removeEventListener('abort', cancel);
    controller.abort();
  }
}
