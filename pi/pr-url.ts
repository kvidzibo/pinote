// Display recognition only: this does not authorize network access to any host.
export function parsePR(value: string): { url: string; number: string } | undefined {
  if (!value || value.length > 2048 || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) return;
  const url = /^\[[^\[\]\r\n]*\]\(([^\s]+)\)$/u.exec(value)?.[1] ?? value;
  if (/[\s\\?#]/u.test(url)) return;
  const match = /^https:\/\/([^/]+)\/((?:[A-Za-z0-9_.-]+\/)*)(pulls?)\/([1-9][0-9]*)\/?$/u.exec(url);
  if (!match || !Number.isSafeInteger(Number(match[4]))) return;
  const segments = match[2].slice(0, -1).split("/");
  if (segments.length < 2 || segments.some((part) => part === "." || part === "..")) return;
  let parsed: URL;
  try { parsed = new URL(url); } catch { return; }
  if (!parsed.hostname || parsed.username || parsed.password || match[1].includes("@")) return;
  if (match[3] === "pull" && (match[1] !== "github.com" || segments.length !== 2 || !/^[A-Za-z0-9_-]+$/u.test(segments[0]))) return;
  return { url: url.replace(/\/$/u, ""), number: match[4] };
}
