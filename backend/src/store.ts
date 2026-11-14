import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { dirname, isAbsolute } from 'node:path';
import { privateDirectory, privateFile, resolvePath, checkCancelled } from './runtime.ts';
import { NoteError, validate_text, validate_tag, validate_folder, timestamp, caseFold, codepointCompare, codepointLength, agentJSON, parseAgentJSON, validateAgentPatch } from './compat.ts';
import * as schema from './schema.ts';
export { NoteError, markdown } from './compat.ts';
export type Id = bigint;
export type NoteState = 'active'|'in_progress'|'done'|'removed'|'scheduled';
export interface Note { id:Id; text:string; state:NoteState; created_at:string; updated_at:string; tag:string|null; remind_at:string|null; reminder_due_at:string|null; archived_at:string|null; agent_notes:Record<string,string>; agent_event_id:bigint; pi_sessions:string[] }
export interface ImportSummary { notes:number; tags:number }
type Row=Record<string,any>;
type Revision={expected_updated_at:string};
const live=(state:string)=>state==='active'||state==='in_progress';
const missingTag='This tag no longer exists. Reopen Tags and try again.';
const stale='This task changed elsewhere. Close and reopen the editor or tag menu, then try again.';
function noteFromRow(row:Row):Note { return {tag:null,remind_at:null,reminder_due_at:null,archived_at:null,agent_event_id:0n,...row,agent_notes:parseAgentJSON(row.agent_notes),pi_sessions:JSON.parse(row.pi_sessions)} as Note; }

export class Store {
  public connection:DatabaseSync;
  constructor(path:string, options:{timeout?:number}={}) {
    privateDirectory(dirname(path)); privateFile(path);
    this.connection=new DatabaseSync(path);
    try {
      const timeout=options.timeout??10;
      if(!Number.isFinite(timeout)||timeout<0) throw new RangeError('timeout must be nonnegative');
      this.connection.exec(`PRAGMA busy_timeout = ${Math.min(2147483647,Math.floor(timeout*1000))}`);
      this.connection.exec('PRAGMA foreign_keys = ON');
      if(this.row('PRAGMA user_version')!.user_version!==8n) this.transaction(()=>{
        const version=Number(this.row('PRAGMA user_version')!.user_version);
        if(version===8) return;
        if(![0,1,2,3,4,5,6,7].includes(version)) throw new NoteError(`Unsupported database version ${version}; update pinote.`);
        if(version===0) for(const sql of schema.SCHEMA) this.connection.exec(sql);
        if(version===1) for(const sql of schema.MIGRATION_2) this.connection.exec(sql);
        for(let i=3;i<=8;i++) if(version<i) for(const sql of (schema as any)[`MIGRATION_${i}`]) this.connection.exec(sql);
        this.connection.exec('PRAGMA user_version = 8');
      });
    } catch(e) { this.connection.close(); throw e; }
  }
  close():void { this.connection.close(); }
  query(sql:string,...params:SQLInputValue[]):Row[] { const s=this.connection.prepare(sql); s.setReadBigInts(true); return s.all(...params); }
  row(sql:string,...params:SQLInputValue[]):Row|undefined { const s=this.connection.prepare(sql); s.setReadBigInts(true); return s.get(...params); }
  private run(sql:string,...params:SQLInputValue[]) { const s=this.connection.prepare(sql); s.setReadBigInts(true); return s.run(...params); }
  private transaction<T>(action:()=>T):T {
    checkCancelled();
    // Acquire reader exclusion before work, so COMMIT cannot wait on another
    // reader and then succeed after cancellation. Journal mode stays unchanged.
    this.connection.exec('BEGIN EXCLUSIVE');
    try {
      checkCancelled();
      const result=action();
      // The main thread records signals even during synchronous SQLite/import work.
      checkCancelled();
      this.connection.exec('COMMIT'); return result;
    }
    catch(e) { this.connection.exec('ROLLBACK'); throw e; }
  }
  private insert(text:string,state:string,action:string,when:string,tag:string|null):Id {
    const id=this.run('INSERT INTO notes(text,state,created_at,updated_at,tag) VALUES (?,?,?,?,?)',text,state,when,when,tag).lastInsertRowid as bigint;
    this.run('INSERT INTO events(note_id,action,previous_state,state,occurred_at,text,tag) VALUES (?,?,NULL,?,?,?,?)',id,action,state,when,text,tag);
    return id;
  }
  add(text:string, options:{tag?:string|null}={}):Id {
    text=validate_text(text); const tag=validate_tag(options.tag??null);
    return this.transaction(()=>this.insert(text,'active','add',timestamp(),this.registerTag(tag)));
  }
  add_note(text:string,options:{tag?:string|null;cwd?:string|null}={}):Note {
    text=validate_text(text); const tag=validate_tag(options.tag??null), cwd=options.cwd??null;
    if(cwd!==null&&!isAbsolute(cwd)) throw new NoteError('--cwd must be an absolute project directory.');
    return this.transaction(()=>{
      const id=this.insert(text,'active','add',timestamp(),this.registerTag(tag));
      if(cwd!==null) { this.changeState(id,'start','active','in_progress'); this.saveSelection(id,cwd); }
      return this.get(id);
    });
  }
  tags():string[] { return this.query('SELECT name FROM tags').map(r=>r.name as string).sort((a,b)=>codepointCompare(caseFold(a),caseFold(b))||codepointCompare(a,b)); }
  tag_folders():Record<string,string|null> { return Object.fromEntries(this.query('SELECT name, default_folder FROM tags ORDER BY name').map(r=>[r.name,r.default_folder])); }
  set_tag_folder(name:string,folder:string|null):boolean {
    folder=validate_folder(folder);
    return this.transaction(()=>{const r=this.row('SELECT default_folder FROM tags WHERE name=?',name); if(!r) throw new NoteError(missingTag); if(r.default_folder===folder) return false; this.run('UPDATE tags SET default_folder=? WHERE name=?',folder,name); return true;});
  }
  private registerTag(tag:string|null):string|null {
    if(tag===null) return null;
    const tags=this.tags(); if(tags.includes(tag)) return tag;
    const match=tags.find(n=>caseFold(n)===caseFold(tag)); if(match!==undefined) return match;
    this.run('INSERT INTO tags(name) VALUES (?)',tag); return tag;
  }
  create_tag(name:string,options:{folder?:string|null}={}):string {
    const tag=validate_tag(name), folder=validate_folder(options.folder??null); if(tag===null) throw new NoteError('Tag name cannot be empty.');
    return this.transaction(()=>{ const saved=this.registerTag(tag)!; if(folder!==null) this.run('UPDATE tags SET default_folder=? WHERE name=?',folder,saved); return saved; });
  }
  rename_tag(old:string,newName:string):boolean {
    const a=validate_tag(old),b=validate_tag(newName); if(a===null||b===null) throw new NoteError('Tag name cannot be empty.');
    return this.transaction(()=>{
      if(!this.row('SELECT 1 FROM tags WHERE name=?',a)) throw new NoteError(missingTag);
      if(a===b) return false;
      if(this.tags().some(n=>n!==a&&caseFold(n)===caseFold(b))) throw new NoteError('A tag with that name already exists. Choose another name.');
      this.run('INSERT INTO tags(name,default_folder) SELECT ?,default_folder FROM tags WHERE name=?',b,a);
      this.retagAll(a,b); this.run('DELETE FROM tags WHERE name=?',a); return true;
    });
  }
  delete_tag(name:string):boolean {
    const tag=validate_tag(name); if(tag===null) throw new NoteError('Tag name cannot be empty.');
    return this.transaction(()=>{if(!this.row('SELECT 1 FROM tags WHERE name=?',tag)) throw new NoteError(missingTag); this.retagAll(tag,null); this.run('DELETE FROM tags WHERE name=?',tag); return true;});
  }
  private retagAll(old:string,value:string|null):void {
    for(const r of this.query('SELECT * FROM notes WHERE tag=?',old)) {
      checkCancelled();
      const when=timestamp(r.updated_at); this.run('UPDATE notes SET tag=?,updated_at=? WHERE id=?',value,when,r.id);
      this.run("INSERT INTO events(note_id,action,previous_state,state,occurred_at,text,previous_text,tag,previous_tag,remind_at,previous_remind_at,agent_notes,previous_agent_notes) VALUES (?,'tag',?,?,?,?,?,?,?,?,?,?,?)",r.id,r.state,r.state,when,r.text,r.text,value,old,r.remind_at,r.remind_at,r.agent_notes,r.agent_notes);
    }
  }
  edit(note_id:Id,text:string,options:Revision):boolean { return this.edit_with_revision(note_id,text,options)[0]; }
  edit_with_revision(note_id:Id,text:string,options:Revision):[boolean,string] { return this.update(note_id,'edit',validate_text(text),options.expected_updated_at); }
  set_tag(note_id:Id,tag:string|null,options:Revision&{folder?:string|null}):boolean { return this.set_tag_with_revision(note_id,tag,options)[0]; }
  set_tag_with_revision(note_id:Id,tag:string|null,options:Revision&{folder?:string|null}):[boolean,string] { return this.update(note_id,'tag',validate_tag(tag),options.expected_updated_at,validate_folder(options.folder??null)); }
  private update(id:Id,action:string,value:string|null,expected:string,folder:string|null=null):[boolean,string] {
    return this.transaction(()=>{
      const r=this.row('SELECT * FROM notes WHERE id=?',id); if(!r||!live(r.state)||r.updated_at!==expected) throw new NoteError(stale);
      const text=action==='edit'?value:r.text; let tag=action==='tag'?value:r.tag;
      if(action==='tag'&&tag!==null) { tag=this.registerTag(tag); if(folder!==null) this.run('UPDATE tags SET default_folder=? WHERE name=?',folder,tag); }
      if(text===r.text&&tag===r.tag) return [false,r.updated_at];
      const when=timestamp(r.updated_at);
      this.run('UPDATE notes SET text=?,tag=?,updated_at=? WHERE id=?',text,tag,when,id);
      this.run('INSERT INTO events(note_id,action,previous_state,state,occurred_at,text,previous_text,tag,previous_tag,agent_notes,previous_agent_notes) VALUES (?,?,?,?,?,?,?,?,?,?,?)',id,action,r.state,r.state,when,text,r.text,tag,r.tag,r.agent_notes,r.agent_notes);
      return [true,when];
    });
  }
  private changeState(id:Id,action:string,previous:string,target:string,remind_at:string|null=null):void {
    const r=this.row('SELECT * FROM notes WHERE id=?',id)!; const when=timestamp(r.updated_at);
    this.run('UPDATE notes SET state=?,updated_at=?,remind_at=? WHERE id=?',target,when,remind_at,id);
    this.run('INSERT INTO events(note_id,action,previous_state,state,occurred_at,text,tag,remind_at,previous_remind_at,agent_notes,previous_agent_notes) VALUES (?,?,?,?,?,?,?,?,?,?,?)',id,action,previous,target,when,r.text,r.tag,remind_at,r.remind_at,r.agent_notes,r.agent_notes);
    if(!live(target)) this.run('DELETE FROM agent_selections WHERE note_id=?',id);
  }
  schedule(note_id:Id,due:string,options:{expected_updated_at?:string|null}={}):boolean {
    if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}\+00:00$/.test(due)) throw new NoteError('Reminder time must include a timezone.');
    return this.transaction(()=>{
      if(due<=timestamp()) throw new NoteError('Choose a reminder time in the future.');
      const r=this.row('SELECT * FROM notes WHERE id=?',note_id); if(!r) throw new NoteError(`No note with ID ${note_id}.`);
      if(options.expected_updated_at!=null&&r.updated_at!==options.expected_updated_at) throw new NoteError('This task changed elsewhere. Close and reopen Set reminder.');
      if(!live(r.state)&&r.state!=='scheduled') throw new NoteError(`Note ${note_id} is ${r.state}; restore it first.`);
      if(r.remind_at===due) return false;
      this.changeState(note_id,'schedule',r.state,'scheduled',due); return true;
    });
  }
  scheduled_notes():Note[] { return this.query("SELECT * FROM notes WHERE state='scheduled' ORDER BY remind_at,id").map(noteFromRow); }
  has_due():boolean { return !!this.row("SELECT 1 FROM notes WHERE state='scheduled' AND remind_at<=? LIMIT 1",timestamp()); }
  activate_due():number {
    if(!this.has_due()) return 0;
    return this.transaction(()=>{ const rows=this.query("SELECT id FROM notes WHERE state='scheduled' AND remind_at<=? ORDER BY remind_at,id",timestamp()); for(const r of rows) this.changeState(r.id,'remind','scheduled','active'); return rows.length; });
  }
  transition(note_id:Id,action:string,options:{expected_states?:Set<string>|null;expected_updated_at?:string|null;allow_unchanged?:boolean;pi_session_id?:string|null}={}):boolean {
    const session=options.pi_session_id??null;
    if(session!==null) {
      if(typeof session!=='string'||session.length>256||! /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(session)) throw new NoteError('--pi-session-id must be a valid Pi session ID (at most 256 characters).');
      if(action!=='start') throw new NoteError('Pi sessions can only be recorded when starting a task.');
    }
    const target=({start:'in_progress',reset:'active',done:'done',rm:'removed',restore:'active'} as Record<string,string>)[action];
    if(!target) throw new NoteError(`Unknown action ${action}.`);
    return this.transaction(()=>{
      const r=this.row('SELECT state,updated_at,pi_sessions FROM notes WHERE id=?',note_id);
      if(options.expected_states!=null&&(!r||!options.expected_states.has(r.state))) return false;
      if(!r) throw new NoteError(`No note with ID ${note_id}.`);
      if(options.expected_updated_at!=null&&r.updated_at!==options.expected_updated_at) return false;
      if(r.state===target&&!options.allow_unchanged) return false;
      if((['start','reset'].includes(action)&&['done','removed','scheduled'].includes(r.state))||(action==='done'&&['removed','scheduled'].includes(r.state))) throw new NoteError(`Note ${note_id} is ${r.state}; restore it first.`);
      if(r.state!==target) this.changeState(note_id,action,r.state,target);
      if(session!==null) { const sessions:string[]=JSON.parse(r.pi_sessions); if(!sessions.includes(session)) { sessions.push(session); this.run('UPDATE notes SET pi_sessions=? WHERE id=?',JSON.stringify(sessions).replaceAll(',',', '),note_id); } }
      return true;
    });
  }
  archived_notes():Note[] { return this.query("WITH archived_events AS (SELECT note_id,MAX(id) AS event_id FROM events WHERE action IN ('done','rm','import') AND state IN ('done','removed') GROUP BY note_id) SELECT notes.*,COALESCE(events.occurred_at,notes.updated_at) AS archived_at FROM notes LEFT JOIN archived_events ON archived_events.note_id=notes.id LEFT JOIN events ON events.id=archived_events.event_id WHERE notes.state IN ('done','removed') ORDER BY archived_at DESC,notes.id DESC").map(noteFromRow); }
  notes(options:{all_states?:boolean}={}):Note[] {
    return this.query("WITH latest_reminder_event AS (SELECT note_id,MAX(id) AS event_id FROM events WHERE action IN ('schedule','remind','done','rm') GROUP BY note_id), latest_agent_event AS (SELECT note_id,MAX(id) AS agent_event_id FROM events WHERE action='agent' GROUP BY note_id) SELECT notes.*, COALESCE(agent_events.agent_event_id,0) AS agent_event_id, CASE WHEN events.action='remind' THEN events.previous_remind_at END AS reminder_due_at FROM notes LEFT JOIN latest_agent_event AS agent_events ON agent_events.note_id=notes.id LEFT JOIN latest_reminder_event ON latest_reminder_event.note_id=notes.id LEFT JOIN events ON events.id=latest_reminder_event.event_id"+(options.all_states?'':" WHERE notes.state IN ('active','in_progress')")+' ORDER BY notes.id').map(noteFromRow);
  }
  get(note_id:Id):Note {
    const row=this.row("SELECT notes.*, COALESCE((SELECT MAX(id) FROM events WHERE note_id=notes.id AND action='agent'),0) AS agent_event_id FROM notes WHERE id=?",note_id);
    if(!row) throw new NoteError(`No note with ID ${note_id}.`); return noteFromRow(row);
  }
  private saveSelection(id:Id,cwd:string):void { this.run('INSERT INTO agent_selections(cwd,note_id) VALUES (?,?) ON CONFLICT(cwd) DO UPDATE SET note_id=excluded.note_id',resolvePath(cwd),id); }
  selected(cwd:string):Note|null { const r=this.row("SELECT notes.* FROM agent_selections JOIN notes ON notes.id=note_id WHERE cwd=? AND state IN ('active','in_progress')",resolvePath(cwd)); return r?noteFromRow(r):null; }
  select(note_id:Id,cwd:string):Note {
    return this.transaction(()=>{ const note=this.get(note_id); if(!live(note.state)) throw new NoteError(`Note ${note_id} is ${note.state}; restore it first.`); if(note.state==='active') this.changeState(note_id,'start',note.state,'in_progress'); this.saveSelection(note_id,cwd); return this.get(note_id); });
  }
  update_agent(note_id:Id,fields:Record<string,string>,remove:string[],options:Revision):Note {
    const {patch,deleted}=validateAgentPatch(fields,remove);
    return this.transaction(()=>{
      const note=this.get(note_id); if(!live(note.state)||note.updated_at!==options.expected_updated_at) throw new NoteError('This task changed elsewhere. Read it again before updating.');
      const updated=Object.fromEntries([...Object.entries(note.agent_notes).filter(([k])=>!deleted.has(k)),...patch]);
      const encoded=agentJSON(updated), previous=agentJSON(note.agent_notes);
      if(Object.keys(updated).length>64||Buffer.byteLength(encoded,'utf8')>32768) throw new NoteError('Agent notes cannot exceed 64 fields or 32 KiB of JSON.');
      if(encoded===previous) return note;
      const when=timestamp(note.updated_at); this.run('UPDATE notes SET agent_notes=?,updated_at=? WHERE id=?',encoded,when,note_id);
      this.run("INSERT INTO events(note_id,action,previous_state,state,occurred_at,text,previous_text,tag,previous_tag,agent_notes,previous_agent_notes) VALUES (?,'agent',?,?,?,?,?,?,?,?,?)",note_id,note.state,note.state,when,note.text,note.text,note.tag,note.tag,encoded,previous);
      return this.get(note_id);
    });
  }
  private eventPage(after:bigint|null,limit:number):{cursor:bigint;rows:Row[]} {
    const maximum=9007199254740991n;
    if(after!==null&&(typeof after!=='bigint'||after<0n||after>maximum)) throw new NoteError('Cursor must be a nonnegative safe integer.');
    if(typeof limit!=='number'||!Number.isInteger(limit)||limit<1||limit>1000) throw new NoteError('Limit must be between 1 and 1000.');
    const tail=this.row('SELECT COALESCE(MAX(id),0) AS tail FROM events')!.tail as bigint;
    if(tail>maximum) throw new NoteError('Event history exceeds the safe cursor range.');
    if(after===null) return {cursor:tail,rows:[]};
    if(after>tail) throw new NoteError('Cursor is ahead of current event history.');
    const rows=this.query('SELECT * FROM events WHERE id>? AND id<=? ORDER BY id LIMIT ?',after,tail,limit);
    return {cursor:rows.length?rows.at(-1)!.id:after,rows};
  }
  completion_events(after:bigint|null=null,limit:number=256):{cursor:bigint;events:Row[]} {
    const {cursor,rows}=this.eventPage(after,limit); const events=[];
    for(const r of rows) if(r.action==='done'&&r.state==='done'&&live(r.previous_state)) { this.safeTask(r.note_id); events.push({id:r.id,task_id:r.note_id,timestamp:r.occurred_at}); }
    return {cursor,events};
  }
  private safeTask(id:bigint):void { if(id>9007199254740991n) throw new NoteError('Task ID exceeds the safe integer range.'); }
  field_events(after:bigint|null=null,limit:number=256):{cursor:bigint;events:Row[]} {
    const {cursor,rows}=this.eventPage(after,limit), events:Row[]=[];
    const actions=new Set(['agent','edit','tag','start','reset','done','rm','restore','schedule','remind']);
    for(const r of rows) {
      if(!actions.has(r.action)) continue;
      const before:Record<string,string>=live(r.previous_state)?JSON.parse(r.previous_agent_notes):{};
      const afterFields:Record<string,string>=live(r.state)?JSON.parse(r.agent_notes):{};
      for(const key of [...new Set([...Object.keys(before),...Object.keys(afterFields)])].sort(codepointCompare)) {
        const had=Object.hasOwn(before,key),has=Object.hasOwn(afterFields,key);
        const previous=had?before[key]:null,value=has?afterFields[key]:null;
        if(previous===value) continue; this.safeTask(r.note_id);
        events.push({id:r.id,taskId:r.note_id,field:key,event:!had?'added':!has?'removed':'changed',value,previousValue:previous});
      }
    }
    return {cursor,events};
  }
  history(note_id:Id|null=null):Row[] {
    if(note_id!==null&&!this.row('SELECT 1 FROM notes WHERE id=?',note_id)) throw new NoteError(`No note with ID ${note_id}.`);
    return note_id===null?this.query('SELECT * FROM events ORDER BY id'):this.query('SELECT * FROM events WHERE note_id=? ORDER BY id',note_id);
  }
  import_notes(source:string,entries:[string,string,string|null][]):ImportSummary|null {
    const clean=entries.map(([text,state,tag])=>{ const saved=validate_tag(tag); if(tag!==null&&saved===null) throw new NoteError('Tag name cannot be empty.'); return [validate_text(text),state,saved] as const; });
    if(clean.some(([,state])=>!['active','in_progress','done'].includes(state))) throw new NoteError('Imported notes must be active, in progress, or done.');
    return this.transaction(()=>{
      if(this.row('SELECT 1 FROM imports WHERE source=?',source)) return null;
      if(!clean.length) return {notes:0,tags:0};
      const count=this.tags().length,when=timestamp();
      for(const [text,state,tag] of clean) { checkCancelled(); this.insert(text,state,'import',when,this.registerTag(tag)); }
      this.run('INSERT INTO imports(source,imported_at,note_count) VALUES (?,?,?)',source,when,clean.length);
      return {notes:clean.length,tags:this.tags().length-count};
    });
  }
}
