import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { Temporal } from '@js-temporal/polyfill';
import { NoteError, canonicalInstant, pythonStrip } from './compat.ts';

export function parse_reminder_time(value: string): string {
  value=pythonStrip(value);
  const invalid='Use a date and time like 2026-09-18 14:30 (local time).';
  if(!/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?(?:Z|[+-]\d{2}:\d{2})?$/.test(value) || value.startsWith('0000-')) throw new NoteError(invalid);
  try {
    // PlainDateTime rejects invalid calendar dates (and explicitly reject leap seconds).
    const plain=value.replace(/(?:Z|[+-]\d{2}:\d{2})$/,'').replace(' ','T');
    if(/T\d{2}:\d{2}:60/.test(plain)) throw new RangeError();
    const wall=Temporal.PlainDateTime.from(plain,{overflow:'reject'});
    if(/(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
      const result=canonicalInstant(Temporal.Instant.from(value.replace(' ','T')));
      if(!/^(?!0000)\d{4}-/.test(result)) throw new RangeError();
      return result;
    }
    let zoned:Temporal.ZonedDateTime;
    try { zoned=wall.toZonedDateTime(Temporal.Now.timeZoneId(),{disambiguation:'reject'}); }
    catch { throw new NoteError('This local time is ambiguous or skipped by daylight saving. Choose another time, or supply an explicit UTC offset.'); }
    return canonicalInstant(zoned.toInstant());
  } catch(e) { if(e instanceof NoteError) throw e; throw new NoteError(invalid); }
}
export function local_reminder_time(value: string): string {
  const instant=Temporal.Instant.from(value);
  const local=instant.toZonedDateTimeISO(Temporal.Now.timeZoneId());
  const wall=local.toPlainDateTime().toString({smallestUnit:'second'}).replace('T',' ');
  return wall+' '+zoneAbbreviation(instant,local.offsetNanoseconds/1e9);
}

// ICU's localized short names (e.g. GMT+1) differ from libc's %Z (CET).
// Read the same system TZif abbreviations used by Python, without a subprocess.
function zoneAbbreviation(instant:Temporal.Instant,offset:number):string {
  const tz=(process.env.TZ??'').replace(/^:/,'');
  const path=tz?(isAbsolute(tz)?tz:join('/usr/share/zoneinfo',tz)):'/etc/localtime';
  try {
    const data=readFileSync(path);
    const counts=(start:number)=>Array.from({length:6},(_,i)=>data.readUInt32BE(start+20+i*4));
    const size=(c:number[],width:number)=>c[3]*(width+1)+c[4]*6+c[5]+c[2]*(width+4)+c[1]+c[0];
    if(data.toString('ascii',0,4)!=='TZif') throw new Error('Not TZif');
    let start=0,width=4,c=counts(0);
    if(data[4]!==0) { start=44+size(c,4); width=8; c=counts(start); }
    const [,,leaps,timeCount,typeCount,charCount]=c;
    const times=start+44, indexes=times+timeCount*width, types=indexes+timeCount, chars=types+typeCount*6;
    const ns=instant.epochNanoseconds;
    const seconds=(ns<0n?ns-999999999n:ns)/1000000000n;
    let index=0,last:bigint|null=null;
    for(let i=0;i<timeCount;i++) {
      const when=width===8?data.readBigInt64BE(times+i*8):BigInt(data.readInt32BE(times+i*4));
      last=when; if(when>seconds) break; index=data[indexes+i];
    }
    const name=(i:number)=>{const pos=chars+data[types+i*6+5]; return data.toString('ascii',pos,data.indexOf(0,pos));};
    // Beyond the final transition, TZif v2+ carries POSIX standard/DST names.
    // Temporal has already computed the offset, so choose its matching rule.
    if(timeCount&&last!==null&&seconds>last) {
      const end=chars+charCount+leaps*(width+4)+c[1]+c[0];
      const tail=data.toString('ascii',end).trim();
      const m=/^(?:<([^>]+)>|([A-Za-z]+))([+-]?\d+(?::\d+(?::\d+)?)?)(?:(?:<([^>]+)>|([A-Za-z]+))([+-]?\d+(?::\d+(?::\d+)?)?)?)?/.exec(tail);
      if(m) {
        const parseOffset=(s:string)=>{const negative=s.startsWith('-'); const p=s.replace(/^[+-]/,'').split(':').map(Number); return (negative?1:-1)*(p[0]*3600+(p[1]??0)*60+(p[2]??0));};
        const standard=parseOffset(m[3]);
        if(offset===standard) return m[1]??m[2];
        if((m[4]||m[5])&&offset===(m[6]?parseOffset(m[6]):standard+3600)) return m[4]??m[5];
      }
    }
    return name(index);
  } catch {
    // Minimal systems without zoneinfo still have ICU's timezone data.
    return new Intl.DateTimeFormat('en-US',{timeZoneName:'short'}).formatToParts(new Date(Number(instant.epochMilliseconds))).find(p=>p.type==='timeZoneName')!.value;
  }
}
