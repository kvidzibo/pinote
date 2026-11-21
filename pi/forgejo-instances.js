// Trusted Forgejo instances: the rules shared by the watcher and the settings that save them.
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const unsafe = /[\s\\\u0000-\u001f\u007f-\u009f]/u;
const segment = /^[A-Za-z0-9_.-]+$/;

/** @param {unknown} value @returns {URL} */
export function instanceURL(value) {
  if (typeof value !== 'string' || value.length > 2048 || unsafe.test(value) || /[?#]/u.test(value)) throw new Error('Invalid URL');
  const raw = /^https?:\/\/([^/]+)(\/.*)?$/.exec(value);
  if (!raw || raw[1].includes('@')) throw new Error('Invalid URL');
  const url = new URL(value);
  const loopbackHTTP = url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !loopbackHTTP || url.username || url.password) throw new Error('Invalid URL');
  // Check the raw path before URL normalization can hide traversal.
  const path = (raw[2] ?? '').replace(/\/$/, '');
  if (path && path.slice(1).split('/').some((part) => !segment.test(part) || ['.', '..'].includes(part))) throw new Error('Invalid path');
  return url;
}

/** @param {unknown} entries @returns {{ url: string; tokenEnv?: string }[]} Longest base URL first. */
export function parseInstances(entries) {
  if (!Array.isArray(entries) || entries.length > 32) throw new Error('Invalid instances');
  const seen = new Set();
  return entries.map((entry) => {
    if (!object(entry) || Object.keys(entry).some((key) => !['url', 'tokenEnv'].includes(key))) throw new Error('Invalid instance');
    const url = instanceURL(entry.url).href.replace(/\/$/, '');
    if (seen.has(url) || entry.tokenEnv !== undefined && (typeof entry.tokenEnv !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(entry.tokenEnv))) throw new Error('Invalid instance');
    seen.add(url);
    return { url, tokenEnv: entry.tokenEnv };
  }).sort((a, b) => b.url.length - a.url.length);
}
