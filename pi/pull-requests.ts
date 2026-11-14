export function parsePullRequests(value: string | undefined): { url: string; number: string }[] {
  const results: { url: string; number: string }[] = [];
  const seen = new Set<string>();
  for (const line of (value ?? '').split(/\r?\n/)) {
    const text = line.trim().replace(/^-\s+/, '');
    const url = /^\[[^\]\r\n]*\]\(([^\s()]+)\)$/.exec(text)?.[1] ?? text;
    const match = /^https:\/\/github\.com\/([a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?)\/([a-z0-9_.-]{1,100})\/pull\/([1-9][0-9]*)\/?$/i.exec(url);
    if (!match || ['.', '..'].includes(match[2]) || !Number.isSafeInteger(Number(match[3]))) continue;
    const canonical = `https://github.com/${match[1]}/${match[2]}/pull/${match[3]}`.toLowerCase();
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    results.push({ url: canonical, number: match[3] });
    if (results.length === 64) break;
  }
  return results;
}

export function pullRequestValues(notes: Record<string, string>): string | undefined {
  const values = [notes.PRs, notes.PR].filter((value) => typeof value === 'string' && value.trim());
  return values.length ? values.join('\n') : undefined;
}
