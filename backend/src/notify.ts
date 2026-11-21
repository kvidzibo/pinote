import { execFile } from 'node:child_process';
import type { Note } from './store.ts';
import { findExecutable } from './runtime.ts';
export const STACK_TAG = 'pinote-reminders';
export class NotificationError extends Error {}
export function render(notes: Pick<Note, 'id' | 'text' | 'state'>[]): string {
  const lines = notes.slice(0, 10).map(note => {
    // Python str.split whitespace includes the four information separators.
    const chars = [...note.text.replace(/[\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/gu, ' ').replace(/^ | $/g, '')];
    const text = chars.length > 180 ? chars.slice(0, 179).join('') + '…' : chars.join('');
    const escaped = text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
    return `${note.id}. ${note.state === 'in_progress' ? '[in progress] ' : ''}${escaped}`;
  });
  if (notes.length > 10) lines.push(`… ${notes.length - 10} more; run note for the full list.`);
  if (!notes.length) lines.push('No active reminders.');
  lines.push('<span size="small">note · note done ID · note rm ID</span>');
  return lines.join('\u2028');
}
export async function show(notes: Note[]): Promise<void> {
  const executable = findExecutable('dunstify', process.env);
  if (!executable) throw new NotificationError('dunstify is not installed; install Dunst to show reminders.');
  await new Promise<void>((resolve, reject) => {
    execFile(executable, ['-a', 'pinote', '-u', 'normal', '-t', '0', '-h',
      `string:x-dunst-stack-tag:${STACK_TAG}`, '--', 'Reminders', render(notes).replaceAll('\\', '\\\\')],
    { timeout: 5000, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (!error) return resolve();
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') reject(new NotificationError('dunstify is not installed; install Dunst to show reminders.'));
      else if (error.killed) reject(new NotificationError('Dunst did not respond within 5 seconds.'));
      else if (typeof code === 'string') reject(new NotificationError(`Cannot run dunstify: ${error.message}`));
      else reject(new NotificationError(`Dunst could not show reminders: ${(stderr || stdout).trim() || code}`));
    });
  });
}
