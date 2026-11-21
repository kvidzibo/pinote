import { spawnSync } from 'node:child_process';
import { closeSync, openSync, readSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Temporal } from '@js-temporal/polyfill';
import { NoteError, canonicalInstant, pythonStrip } from './compat.ts';

// A missing /etc/localtime uses the system date program's default (no TZ).
type SystemZone = {tz:string|undefined};
type LocalZone = SystemZone|{abbreviation:string};
const zoneinfo='/usr/share/zoneinfo';
const utcZone={abbreviation:'UTC'};
const nonIanaZone=/^(?:right\/|posix\/|localtime$|posixrules$)/;
function zoneFile(path:string):SystemZone|undefined {
  if(!statSync(path).isFile()) return;
  const fd=openSync(path,'r');
  try {
    const magic=Buffer.alloc(4);
    if(readSync(fd,magic,0,4,0)===4 && magic.toString('latin1')==='TZif') return {tz:':'+path};
  } finally { closeSync(fd); }
}
function localZone():LocalZone|undefined {
  const setting=process.env.TZ;
  if(setting===undefined) {
    try { return zoneFile('/etc/localtime'); }
    catch(e) { if((e as NodeJS.ErrnoException).code==='ENOENT') return {tz:undefined}; return; }
  }
  // Do not let libc silently interpret a missing file as a POSIX TZ rule.
  const tzdir=process.env.TZDIR;
  if(tzdir&&tzdir.replace(/\/+$/,'')!==zoneinfo) return;
  const name=setting===''?'Universal':setting.replace(/^:/,'');
  if(!name) return utcZone;
  if(!/^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)*$/.test(name) || nonIanaZone.test(name)) return;
  const path=join(zoneinfo,name);
  try {
    const root=realpathSync(zoneinfo)+'/';
    const resolved=realpathSync(path);
    if(!resolved.startsWith(root) || nonIanaZone.test(resolved.slice(root.length))) return;
    return zoneFile(path);
  } catch(e) {
    if((e as NodeJS.ErrnoException).code==='ENOENT' && ['UTC','GMT','Universal'].includes(name)) return {abbreviation:name};
  }
}

const unavailable='Cannot read local time from /usr/bin/date. GNU coreutils date and system timezone data are required.';
const utf8=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true});
function systemDate(zone:SystemZone,seconds:number[],format:string):string[] {
  // Read absolute epoch seconds in a single batch, using one system rule set
  // (including TZif footer rules). Pass only the locale and validated zone.
  const env=zone.tz===undefined?{LC_ALL:'C'}:{LC_ALL:'C',TZ:zone.tz};
  const result=spawnSync('/usr/bin/date',['--file=-','+'+format],{
    env,input:seconds.map(s=>'@'+s+'\n').join(''),timeout:5000,maxBuffer:16384,
  });
  if(result.status!==0) throw new NoteError(unavailable);
  let lines:string[];
  try { lines=utf8.decode(result.stdout).split('\n'); }
  catch { throw new NoteError('System timezone output is not valid UTF-8.'); }
  if(lines.pop()!=='' || lines.length!==seconds.length) throw new NoteError(unavailable);
  return lines;
}
function offsetsAt(zone:SystemZone,seconds:number[]):number[] {
  return systemDate(zone,seconds,'%::z').map(line=>{
    const m=/^([+-])([01]\d|2[0-3]):([0-5]\d):([0-5]\d)$/.exec(line);
    if(!m) throw new NoteError(unavailable);
    return (m[1]==='-'?-1:1)*(Number(m[2])*3600+Number(m[3])*60+Number(m[4]));
  });
}
function wallOffset(zone:SystemZone,wallSecond:number):number {
  // IANA offsets are less than a day and its transitions are spaced more
  // than two days apart. Bracket every possible UTC candidate. In the usual
  // case there's one stable offset; near a transition round-trip both sides.
  const day=86400;
  const [before,after]=offsetsAt(zone,[wallSecond-day,wallSecond+day]);
  if(before===after) return before;
  const offsets=[before,after];
  const actual=offsetsAt(zone,offsets.map(offset=>wallSecond-offset));
  const matches=offsets.filter((offset,i)=>offset===actual[i]);
  if(matches.length!==1) throw new NoteError('This local time is ambiguous or skipped by daylight saving. Choose another time, or supply an explicit UTC offset.');
  return matches[0];
}
const wholeSecond=(instant:Temporal.Instant)=>Math.floor(instant.epochMilliseconds/1000);

export function parse_reminder_time(value: string): string {
  value=pythonStrip(value);
  const invalid='Use a date and time like 2026-09-18 14:30 (local time).';
  if(!/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?(?:Z|[+-]\d{2}:\d{2})?$/.test(value) || value.startsWith('0000-')) throw new NoteError(invalid);
  try {
    const iso=value.replace(' ','T');
    if(/T\d{2}:\d{2}:60/.test(iso)) throw new RangeError();
    if(/(?:Z|[+-]\d{2}:\d{2})$/.test(iso)) return canonicalInstant(Temporal.Instant.from(iso));
    // Validate the calendar, treating the wall fields as UTC only for arithmetic.
    const wall=Temporal.Instant.from(iso+'Z');
    const zone=localZone();
    if(!zone) throw new NoteError('Unsupported local time zone. Use an installed IANA time zone in TZ without a custom TZDIR, unset TZ, or supply an explicit UTC offset.');
    const offset='abbreviation' in zone?0:wallOffset(zone,wholeSecond(wall));
    return canonicalInstant(wall.subtract({seconds:offset}));
  } catch(e) { if(e instanceof NoteError) throw e; throw new NoteError(invalid); }
}
export function local_reminder_time(value: string): string {
  const instant=Temporal.Instant.from(value);
  // Absolute reminders remain usable with explicitly unsupported local zones.
  const zone=localZone()??utcZone;
  if('abbreviation' in zone) return instant.toString({smallestUnit:'second'}).replace('T',' ').slice(0,-1)+' '+zone.abbreviation;
  return systemDate(zone,[wholeSecond(instant)],'%Y-%m-%d %T %Z')[0];
}
