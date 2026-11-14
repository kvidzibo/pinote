import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolvePath } from './runtime.ts';
import { Temporal } from '@js-temporal/polyfill';
import { caseFold } from 'unicode-case-folding';

export class NoteError extends Error { constructor(message: string) { super(message); this.name = 'NoteError'; } }
export { caseFold };
// Python str.isspace includes information separators, excludes BOM.
export const pythonStrip = (s: string): string => s.replace(/^[\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+|[\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/gu, '');
export const codepointLength = (s: string): number => [...s].length;
export function codepointCompare(a: string, b: string): number {
  const aa = [...a], bb = [...b];
  for (let i=0; i<Math.min(aa.length,bb.length); i++) { const d=aa[i].codePointAt(0)!-bb[i].codePointAt(0)!; if(d) return d; }
  return aa.length-bb.length;
}
export function validate_tag(value: string|null): string|null {
  if(value === null) return null;
  if(/[\p{Cc}\p{Cs}\p{Zl}\p{Zp}]/u.test(value)) throw new NoteError('Tag names must be a single line without control characters.');
  value=pythonStrip(value).normalize('NFC');
  if(codepointLength(value)>64) throw new NoteError('Tag names cannot exceed 64 characters.');
  return value || null;
}
export function validate_text(value: string): string {
  value=pythonStrip(value.replaceAll('\r\n','\n'));
  if(!value) throw new NoteError('Note text cannot be empty.');
  if(codepointLength(value)>4096) throw new NoteError('Note text cannot exceed 4096 characters.');
  if(/[\p{Cc}\p{Cs}]/u.test(value.replaceAll('\n','').replaceAll('\t',''))) throw new NoteError('Note text contains unsupported control characters.');
  return value;
}
export function validatePiSession(value: unknown): string|null {
  if(value == null) return null;
  if(typeof value !== 'string' || value.length > 256 || !/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(value)) throw new NoteError('--pi-session-id must be a valid Pi session ID (at most 256 characters).');
  return value;
}
export function validate_folder(value: string|null): string|null {
  if(value === null) return null;
  if(value==='~' || value.startsWith('~/')) value=homedir()+value.slice(1);
  const path=resolvePath(value);
  try { if(statSync(path).isDirectory()) return path; } catch {}
  throw new NoteError('Choose an existing directory.');
}
export function canonicalInstant(value: Temporal.Instant): string {
  const result=value.toString({fractionalSecondDigits:6}).replace(/Z$/, '+00:00');
  if(!/^(?!0000)\d{4}-/.test(result)) throw new RangeError('Date is outside the Python datetime range.');
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
// json.dumps(..., ensure_ascii=False, sort_keys=True), including Python separators.
export function agentJSON(fields: Record<string,string>): string {
  return '{'+Object.keys(fields).sort(codepointCompare).map(k=>JSON.stringify(k)+': '+JSON.stringify(fields[k])).join(', ')+'}';
}
export function validateAgentPatch(fields: unknown, remove: string[]): {patch: Map<string,string>; deleted: Set<string>} {
    if(fields===null||typeof fields!=='object'||Array.isArray(fields)||![Object.prototype,null].includes(Object.getPrototypeOf(fields))) throw new NoteError('Agent fields must be a JSON object of label: Markdown string pairs.');
    const label=(value:string)=>{ if(typeof value!=='string') throw new NoteError('Agent field labels must be strings.'); const result=validate_tag(value); if(result===null) throw new NoteError('Agent field labels cannot be empty.'); return result; };
    const patch=new Map<string,string>();
    for(const [k,v] of Object.entries(fields)) {
      const key=label(k); if(patch.has(key)) throw new NoteError('Agent field labels must be unique after normalization.');
      if(typeof v!=='string') throw new NoteError('Agent field values must be Markdown strings.');
      validate_text(v); const value=v.replaceAll('\r\n','\n'); if(codepointLength(value)>4096) throw new NoteError('Agent field values cannot exceed 4096 characters.'); patch.set(key,value);
    }
    const deleted=new Set(remove.map(label)); if([...deleted].some(k=>patch.has(k))) throw new NoteError('Cannot set and remove the same agent field in one update.');
  if(patch.size>64||Buffer.byteLength(agentJSON(Object.fromEntries(patch)),'utf8')>32768) throw new NoteError('Agent notes cannot exceed 64 fields or 32 KiB of JSON.');
  return {patch,deleted};
}
// Preserve Python dict insertion order even for integer-looking labels.
export function parseAgentJSON(encoded: string): Record<string,string> {
  const value=JSON.parse(encoded) as Record<string,string>;
  const keys=[...encoded.matchAll(/("(?:[^"\\]|\\.)*")\s*:\s*("(?:[^"\\]|\\.)*")/g)].map(m=>JSON.parse(m[1]) as string);
  return new Proxy(value,{ownKeys:()=>[...new Set(keys)]});
}
export function markdown(note: {text:string;agent_notes:Record<string,string>}): string {
  const fields=Object.entries(note.agent_notes);
  if(!fields.length) return note.text;
  return note.text+'\n\n## Agent\n'+fields.map(([k,v])=>k.replace(/[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/g,'\\$&')+': '+v).join('\n\n');
}
