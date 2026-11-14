import { createHash } from 'node:crypto';
import type { FieldResult } from './mcp/field-events.ts';

type Request = { url: string; number: string; label?: string };
type Result = Omit<FieldResult, 'items'>;

/** Shared bounded execution and alert identity for the two trusted PR watchers. */
export async function checkPRBatch(
  event: { previousResult?: FieldResult }, requests: Request[],
  check: (request: Request, signal: AbortSignal) => Promise<Result>, errorResult: () => Result,
): Promise<FieldResult> {
  const signal = AbortSignal.timeout(25_000);
  const items: NonNullable<FieldResult['items']> = new Array(requests.length);
  let next = 0;
  async function worker() {
    while (next < requests.length) {
      const index = next++;
      const request = requests[index];
      try {
        signal.throwIfAborted();
        items[index] = { url: request.url, ...await check(request, signal) };
      } catch {
        const previous = event.previousResult?.items?.find((item) => item.url === request.url);
        // Retain failure identity through outages, never an actionable error.
        items[index] = { url: request.url, ...errorResult(),
          ...(previous?.notification ? { notification: previous.notification } : {}) };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, requests.length) }, worker));
  const result: FieldResult = { state: 'multiple', items };
  if (items.some((item) => !['merged', 'closed'].includes(item.state ?? ''))) result.recheckAfterSeconds = 60;
  const failures = items.filter((item) => ['failed', 'conflict'].includes(item.state ?? ''));
  const knownFailures = items.filter((item) => item.notification);
  if (knownFailures.length) {
    const fingerprint = createHash('sha256').update(JSON.stringify(
      knownFailures.map((item) => [item.url, item.notification!.key]).sort((a, b) => a[0].localeCompare(b[0])),
    )).digest('hex');
    result.notification = {
      key: `prs:${fingerprint}`,
      message: failures.length
        ? failures.map((item) => `PR #${item.url.split('/').at(-1)} ${item.url}: ${item.notification!.message}`).join('\n').slice(0, 1000)
        : event.previousResult?.notification?.message ?? 'PR checks unavailable',
    };
  }
  return result;
}
