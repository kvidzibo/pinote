import { mkdirSync, statSync } from 'node:fs';
import { isAbsolute, normalize } from 'node:path';
import { expandHome, resolvePath } from './runtime.ts';
import { Temporal } from '@js-temporal/polyfill';
import { caseFold } from 'unicode-case-folding';

export class NoteError extends Error { constructor(message: string) { super(message); this.name = 'NoteError'; } }
export { caseFold };
// Whitespace here includes the information separators (U+001C–U+001F) and excludes the BOM.
export const strip = (s: string): string => s.replace(/^[\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+|[\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/gu, '');
export const codepointLength = (s: string): number => [...s].length;
export function codepointCompare(a: string, b: string): number {
  const aa = [...a], bb = [...b];
  for (let i=0; i<Math.min(aa.length,bb.length); i++) { const d=aa[i].codePointAt(0)!-bb[i].codePointAt(0)!; if(d) return d; }
  return aa.length-bb.length;
}
export function validate_tag(value: string|null): string|null {
  if(value === null) return null;
  if(/[\p{Cc}\p{Cs}\p{Zl}\p{Zp}]/u.test(value)) throw new NoteError('Tag names must be a single line without control characters.');
  value=strip(value).normalize('NFC');
  if(codepointLength(value)>64) throw new NoteError('Tag names cannot exceed 64 characters.');
  return value || null;
}
export function validate_text(value: string): string {
  value=strip(value.replaceAll('\r\n','\n'));
  if(!value) throw new NoteError('Note text cannot be empty.');
  if(codepointLength(value)>4096) throw new NoteError('Note text cannot exceed 4096 characters.');
  if(/[\p{Cc}\p{Cs}]/u.test(value.replaceAll('\n','').replaceAll('\t',''))) throw new NoteError('Note text contains unsupported control characters.');
  return value;
}
export function validateImportEntries(entries: [string,string,string|null][]): [string,string,string|null][] {
  return entries.map(([text,state,tag]) => {
    const saved=validate_tag(tag);
    if(tag!==null && saved===null) throw new NoteError('Tag name cannot be empty.');
    if(!['active','in_progress','done'].includes(state)) throw new NoteError('Imported notes must be active, in progress, or done.');
    return [validate_text(text),state,saved];
  });
}
export function validatePiSession(value: unknown): string|null {
  if(value == null) return null;
  if(typeof value !== 'string' || value.length > 256 || !/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(value)) throw new NoteError('--pi-session-id must be a valid Pi session ID (at most 256 characters).');
  return value;
}
export function validate_folder(value: string|null): string|null {
  if(value === null) return null;
  try {
    const path=resolvePath(expandHome(value));
    if(statSync(path).isDirectory()) return path;
  } catch { /* Invalid, inaccessible or missing directory. */ }
  throw new NoteError('Choose an existing directory.');
}
// A tag folder created with a new tag. Checked lexically: the filesystem is only
// touched if the tag is inserted, and the path is used as given, not resolved.
export function validate_new_folder(value: string|null): string|null {
  if(value === null) return null;
  if(!isAbsolute(value) || value.includes('\0') || normalize(value) !== value) throw new NoteError('A new tag folder must be a normalized absolute path.');
  return value;
}
// Creates the folder itself (its parent must exist); an existing entry must already be a
// folder, so a dangling symlink is a collision rather than a way to create its target.
export function create_folder(path: string): void {
  try { mkdirSync(path); } catch(error) {
    if((error as NodeJS.ErrnoException).code !== 'EEXIST') throw new NoteError(`Cannot create ${path}: ${(error as Error).message}`);
    if(!statSync(path, { throwIfNoEntry: false })?.isDirectory()) throw new NoteError(`${path} exists but is not a folder.`);
  }
}
export function canonicalInstant(value: Temporal.Instant): string {
  const result=value.toString({fractionalSecondDigits:6}).replace(/Z$/, '+00:00');
  if(!/^(?!0000)\d{4}-/.test(result)) throw new RangeError('Date is outside the supported range (years 1–9999).');
  return result;
}
export function timestamp(previous?: string): string {
  let now=Temporal.Now.instant().round({smallestUnit:'microsecond',roundingMode:'floor'});
  if(previous) {
    let old:Temporal.Instant|undefined;
    try { old=Temporal.Instant.from(previous); } catch {} // Legacy revisions may be arbitrary strings.
    if(old&&Temporal.Instant.compare(now,old)<=0) now=old.add({microseconds:1});
  }
  return canonicalInstant(now);
}
/** A field holds Markdown text or a list of single-line items. */
export type AgentValue = string|string[];
export type AgentNotes = Record<string,AgentValue>;
/** A value's text form: a list is its items, one per line. */
export const agentText = (value: AgentValue): string => Array.isArray(value) ? value.join('\n') : value;
export const agentTexts = (fields: AgentNotes): Record<string,string> => Object.fromEntries(Object.entries(fields).map(([k,v])=>[k,agentText(v)]));
// Canonical JSON with keys in code-point order, so equal notes encode equally.
export function agentJSON(fields: AgentNotes): string {
  return '{'+Object.keys(fields).sort(codepointCompare).map(k=>JSON.stringify(k)+':'+JSON.stringify(fields[k])).join(',')+'}';
}
function agentValue(v: unknown): AgentValue {
  if(typeof v==='string') {
    validate_text(v); const value=v.replaceAll('\r\n','\n'); if(codepointLength(value)>4096) throw new NoteError('Agent field values cannot exceed 4096 characters.'); return value;
  }
  if(!Array.isArray(v)) throw new NoteError('Agent field values must be Markdown strings or lists of strings.');
  if(!v.length||v.length>256) throw new NoteError('Agent field lists must have 1–256 items; remove the field to empty it.');
  return Array.from(v,item=>{
    if(typeof item!=='string') throw new NoteError('Agent field list items must be strings.');
    let value:string;
    try { value=validate_text(item); } catch(error) { throw new NoteError((error as Error).message.replace('Note text','Agent field list items')); }
    if(value.includes('\n')) throw new NoteError('Agent field list items must be single lines.');
    return value;
  });
}
export function validateAgentPatch(fields: unknown, remove: string[]): {patch: Map<string,AgentValue>; deleted: Set<string>} {
    if(fields===null||typeof fields!=='object'||Array.isArray(fields)||![Object.prototype,null].includes(Object.getPrototypeOf(fields))) throw new NoteError('Agent fields must be a JSON object of label: Markdown string or list pairs.');
    const label=(value:string)=>{ if(typeof value!=='string') throw new NoteError('Agent field labels must be strings.'); const result=validate_tag(value); if(result===null) throw new NoteError('Agent field labels cannot be empty.'); return result; };
    const patch=new Map<string,AgentValue>();
    for(const [k,v] of Object.entries(fields)) {
      const key=label(k); if(patch.has(key)) throw new NoteError('Agent field labels must be unique after normalization.');
      patch.set(key,agentValue(v));
    }
    const deleted=new Set(remove.map(label)); if([...deleted].some(k=>patch.has(k))) throw new NoteError('Cannot set and remove the same agent field in one update.');
  if(patch.size>64||Buffer.byteLength(agentJSON(Object.fromEntries(patch)),'utf8')>32768) throw new NoteError('Agent notes cannot exceed 64 fields or 32 KiB of JSON.');
  return {patch,deleted};
}
export function markdown(note: {text:string;agent_notes:AgentNotes}): string {
  const fields=Object.entries(note.agent_notes).sort(([a],[b])=>codepointCompare(a,b));
  if(!fields.length) return note.text;
  return note.text+'\n\n## Agent\n'+fields.map(([k,v])=>k.replace(/[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/g,'\\$&')+(Array.isArray(v)?':\n'+v.map(item=>'- '+item).join('\n'):': '+v)).join('\n\n');
}
