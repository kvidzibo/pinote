/** Deliberately small Markdown interchange format, not a general parser. */
import type { Note } from './store.ts';
export type Entry = [string, string, string | null];
export function parse(text: string): Entry[] {
  const entries: Entry[] = [];
  let parent: string | null = null, tag: string | null = null;
  let childIndent: number | null = null, continuationIndent: number | null = null;
  for (const line of text.replaceAll('\r\n', '\n').split('\n')) {
    if (continuationIndent !== null && line.startsWith(' '.repeat(continuationIndent))) {
      entries[entries.length - 1][0] += '\n' + line.slice(continuationIndent);
      continue;
    }
    const match = /^([ \t]*)[-*+][ \t]+(?:\[([ xX~])\][ \t]*)?(.*)$/s.exec(line);
    if (!match) continue;
    const [, indent, checked, body] = match;
    let width = 0;
    for (const char of indent) width += char === '\t' ? 4 - width % 4 : 1;
    const state = checked === 'x' || checked === 'X' ? 'done' : checked === '~' ? 'in_progress' : 'active';
    if (width === 0) {
      entries.push([body, state, null]); parent = checked === undefined ? body : null;
      tag = null; childIndent = null;
    } else if (parent !== null || tag !== null) {
      if (tag === null) { tag = parent; parent = null; childIndent = width; entries.pop(); }
      else if (width !== childIndent) continue;
      entries.push([body, state, tag]);
    } else continue;
    continuationIndent = checked !== undefined ? width + 4 : null;
  }
  return entries;
}
function exportNotes(notes: Pick<Note, 'text' | 'state'>[]): string {
  const lines = ['# Reminders', ''];
  for (const note of notes) {
    if (note.state === 'removed' || note.state === 'scheduled') continue;
    const mark = note.state === 'done' ? 'x' : note.state === 'in_progress' ? '~' : ' ';
    const [first, ...rest] = note.text.split('\n');
    lines.push(`- [${mark}] ${first}`, ...rest.map(line => '    ' + line));
  }
  return lines.join('\n') + '\n';
}
export { exportNotes as export };
