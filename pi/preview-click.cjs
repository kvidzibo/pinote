#!/usr/bin/env node
'use strict';
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');

const urlPattern = /^pi-note-preview:\/\/([1-9][0-9]*)-([0-9a-f]{8})\/([0-9a-f]{32})\/([1-9][0-9]*)\/([0-9a-f]{32})$/;

function parse(value) {
  if (typeof value !== 'string' || value.length > 160) throw new Error('Preview unavailable');
  const m = urlPattern.exec(value);
  if (!m || m[0] !== value) throw new Error('Preview unavailable');
  const pid = Number(m[1]), id = Number(m[4]);
  if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(id) || pid <= 0 || id <= 0) throw new Error('Preview unavailable');
  return { pid, tag: m[2], capability: m[3], id, nonce: m[5] };
}
function socketPathFor(value) {
  const p = parse(value);
  return path.join(`/tmp/pi-note-preview-${typeof process.getuid === 'function' ? process.getuid() : -1}`, `${p.pid}-${p.tag}.sock`);
}
function verify(file) {
  const uid = typeof process.getuid === 'function' ? process.getuid() : -1;
  if (uid < 0) throw new Error('Preview unavailable');
  const dir = `/tmp/pi-note-preview-${uid}`;
  const ds = fs.lstatSync(dir);
  if (!ds.isDirectory() || ds.isSymbolicLink() || ds.uid !== uid || (ds.mode & 0o777) !== 0o700) throw new Error('Preview unavailable');
  const ss = fs.lstatSync(file);
  if (!ss.isSocket() || ss.isSymbolicLink() || ss.uid !== uid || (ss.mode & 0o777) !== 0o600) throw new Error('Preview unavailable');
}
function preview(value) {
  let p, file;
  try { p = parse(value); file = socketPathFor(value); verify(file); }
  catch { return Promise.reject(new Error('Preview unavailable')); }
  return new Promise((resolve, reject) => {
    const client = net.createConnection(file);
    let response = Buffer.alloc(0), done = false;
    const finish = (err, result) => {
      if (done) return;
      done = true; clearTimeout(timer); client.destroy();
      err ? reject(new Error('Preview unavailable')) : resolve(result);
    };
    const timer = setTimeout(() => finish(new Error()), 6000);
    client.on('connect', () => client.write(`preview ${p.capability} ${p.id} ${p.nonce}\n`));
    client.on('data', chunk => {
      response = Buffer.concat([response, chunk]);
      if (response.length > 64) return finish(new Error());
      const text = response.toString('utf8');
      if (text.includes('\n')) finish(text === 'accepted\n' ? null : new Error(), text === 'accepted\n');
    });
    client.on('error', () => finish(new Error()));
    client.on('end', () => { if (!done) finish(new Error()); });
  });
}
if (require.main === module) {
  if (process.argv.length !== 3) {
    console.error('Usage: preview-click.cjs <preview URL>');
    process.exitCode = 2;
  } else {
    preview(process.argv[2]).catch(() => {
      console.error('Pinote preview unavailable; select a task and wait until Pi is idle.');
      process.exitCode = 1;
    });
  }
}
module.exports = { preview, socketPathFor };
