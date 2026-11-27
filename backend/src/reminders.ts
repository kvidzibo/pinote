import { Temporal } from '@js-temporal/polyfill';
import { NoteError, canonicalInstant, strip } from './compat.ts';

// Local times use Node's bundled IANA time zone data, so no system date program
// or zoneinfo files are needed. TZ, when set, must name an IANA zone; POSIX rules
// and custom TZDIR data are rejected rather than silently read differently.
// ICU also accepts SystemV zones and Java-style abbreviations that name no IANA
// zone (CST could be Chicago or China); reject them rather than guess a region.
const nonIanaZone=/^(?:right\/|posix\/|SystemV\/|localtime$|posixrules$|(?:ACT|AET|AGT|ART|AST|BET|BST|CAT|CNT|CST|CTT|EAT|ECT|IET|IST|JST|MIT|NET|NST|PLT|PNT|PRT|PST|SST|VST)$)/i;
function knownZone(name:string|undefined):string|undefined {
  if(!name || name==='Etc/Unknown') return;
  try { return new Intl.DateTimeFormat('en-US',{timeZone:name}).resolvedOptions().timeZone; } catch { return; }
}
function localZone():string|undefined {
  const setting=process.env.TZ;
  if(setting===undefined) return knownZone(Intl.DateTimeFormat().resolvedOptions().timeZone);
  const tzdir=process.env.TZDIR;
  if(tzdir&&tzdir.replace(/\/+$/,'')!=='/usr/share/zoneinfo') return;
  const name=setting===''?'UTC':setting.replace(/^:/,'');
  if(!/^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)*$/.test(name) || nonIanaZone.test(name)) return;
  return knownZone(name);
}
// Prefer a letter abbreviation (US zones from en-US, European ones from en-GB), else a GMT offset.
function abbreviation(zone:string,epochMilliseconds:number):string {
  let name='';
  for(const locale of ['en-US','en-GB']) {
    name=new Intl.DateTimeFormat(locale,{timeZone:zone,timeZoneName:'short'}).formatToParts(epochMilliseconds).find(part=>part.type==='timeZoneName')!.value;
    if(!/^GMT[+-]/.test(name)) return name;
  }
  return name;
}

export function parse_reminder_time(value: string): string {
  value=strip(value);
  const invalid='Use a date and time like 2026-09-18 14:30 (local time).';
  if(!/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?(?:Z|[+-]\d{2}:\d{2})?$/.test(value) || value.startsWith('0000-')) throw new NoteError(invalid);
  let wall:Temporal.PlainDateTime;
  try {
    const iso=value.replace(' ','T');
    if(/T\d{2}:\d{2}:60/.test(iso)) throw new RangeError();
    if(/(?:Z|[+-]\d{2}:\d{2})$/.test(iso)) return canonicalInstant(Temporal.Instant.from(iso));
    wall=Temporal.PlainDateTime.from(iso,{overflow:'reject'});
  } catch { throw new NoteError(invalid); }
  const zone=localZone();
  if(!zone) throw new NoteError('Unsupported local time zone. Use an IANA time zone in TZ without a custom TZDIR, unset TZ, or supply an explicit UTC offset.');
  let instant:Temporal.Instant;
  try { instant=wall.toZonedDateTime(zone,{disambiguation:'reject'}).toInstant(); }
  catch { throw new NoteError('This local time is ambiguous or skipped by daylight saving. Choose another time, or supply an explicit UTC offset.'); }
  try { return canonicalInstant(instant); } catch { throw new NoteError(invalid); }
}
export function local_reminder_time(value: string): string {
  const instant=Temporal.Instant.from(value);
  // Absolute reminders remain usable with explicitly unsupported local zones.
  const zone=localZone()??'UTC';
  const wall=instant.toZonedDateTimeISO(zone).toPlainDateTime().toString({smallestUnit:'second'});
  return `${wall.replace('T',' ')} ${abbreviation(zone,instant.epochMilliseconds)}`;
}
