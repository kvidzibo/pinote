// Plain JavaScript: bundled watchers import this file, and Node does not strip types under node_modules.
import { parsePR } from './pr-url.js';
/** @param {string | undefined} value @returns {{ url: string; number: string; label?: string }[]} */
export function parsePullRequests(value) {
    /** @type {{ url: string; number: string; label?: string }[]} */
    const results = [];
    const seen = new Set();
    for (const line of (value ?? '').split(/\r?\n/)) {
        const text = line.trim().replace(/^-\s+/, '');
        const link = /^\[([^\]\r\n]*)\]\(([^\s()]+)\)$/.exec(text);
        const url = link?.[2] ?? text;
        const match = /^https:\/\/github\.com\/([a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?)\/([a-z0-9_.-]{1,100})\/pull\/([1-9][0-9]*)\/?$/i.exec(url);
        let parsed;
        if (/^https?:\/\/github\.com\/.*\/pull\//i.test(url)) {
            if (!match || ['.', '..'].includes(match[2]) || !Number.isSafeInteger(Number(match[3])))
                continue;
            parsed = { url: `https://github.com/${match[1]}/${match[2]}/pull/${match[3]}`.toLowerCase(), number: match[3] };
        }
        else
            parsed = parsePR(url);
        if (!parsed)
            continue;
        // Recognition is display-only; each watcher separately enforces its network trust.
        const canonical = new URL(parsed.url).href;
        if (seen.has(canonical)) {
            if (link)
                results.find((pr) => pr.url === canonical).label ??= link[1];
            continue;
        }
        if (results.length >= 64)
            continue;
        seen.add(canonical);
        results.push({ url: canonical, number: parsed.number, ...(link ? { label: link[1] } : {}) });
    }
    return results;
}
/** @param {Record<string, string>} notes @returns {string | undefined} */
export function pullRequestValues(notes) {
    const values = [notes.PRs, notes.PR].filter((value) => typeof value === 'string' && value.trim());
    return values.length ? values.join('\n') : undefined;
}
