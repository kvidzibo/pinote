import { createHash } from 'node:crypto';
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
        result.recheckAfterSeconds = 60;
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
