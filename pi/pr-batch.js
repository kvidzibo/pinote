import { createHash } from 'node:crypto';
/** Seconds between checks: the watcher's `interval` setting, kept within the scheduler's 10–86,400 range. */
export function recheckSeconds(event) {
    const interval = event?.params?.interval;
    return Number.isFinite(interval) ? Math.min(86_400, Math.max(10, Math.round(interval))) : 60;
}
/** Applies the configured interval to a single PR result that asks for another check; errors never retry sooner than their own delay. */
export function withInterval(event, result) {
    if (!result.recheckAfterSeconds) return result;
    const seconds = recheckSeconds(event);
    return { ...result, recheckAfterSeconds: result.state === 'error' ? Math.max(result.recheckAfterSeconds, seconds) : seconds };
}
/** Shared bounded execution and alert identity for the two trusted PR watchers.
 * @returns {Promise<import('./field-events.ts').FieldResult>} */
export async function checkPRBatch(event, requests, check, errorResult) {
    const signal = AbortSignal.timeout(25_000);
    const items = new Array(requests.length);
    let next = 0;
    async function worker() {
        while (next < requests.length) {
            const index = next++;
            const request = requests[index];
            try {
                signal.throwIfAborted();
                items[index] = { url: request.url, ...await check(request, signal) };
            }
            catch {
                const previous = event.previousResult?.items?.find((item) => item.url === request.url);
                // Retain failure identity through outages, never an actionable error.
                items[index] = { url: request.url, ...errorResult(),
                    ...(previous?.notification ? { notification: previous.notification } : {}) };
            }
        }
    }
    await Promise.all(Array.from({ length: Math.min(4, requests.length) }, worker));
    const result = { state: 'multiple', items };
    if (items.some((item) => !['merged', 'closed'].includes(item.state ?? '')))
        result.recheckAfterSeconds = recheckSeconds(event);
    const failures = items.filter((item) => ['failed', 'conflict'].includes(item.state ?? ''));
    const knownFailures = items.filter((item) => item.notification);
    if (knownFailures.length) {
        const fingerprint = createHash('sha256').update(JSON.stringify(knownFailures.map((item) => [item.url, item.notification.key]).sort((a, b) => a[0].localeCompare(b[0])))).digest('hex');
        result.notification = {
            key: `prs:${fingerprint}`,
            message: failures.length
                ? failures.map((item) => `PR #${item.url.split('/').at(-1)} ${item.url}: ${item.notification.message}`).join('\n').slice(0, 1000)
                : event.previousResult?.notification?.message ?? 'PR checks unavailable',
        };
    }
    return result;
}
