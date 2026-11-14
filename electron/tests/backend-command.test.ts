import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { backendCommand, backendEnvironment } from '../src/backend-command.ts';

test('bundled backend uses supported trusted Node without injection or Python fallback', () => {
  const root = mkdtempSync(join(tmpdir(),'pinote-node-command-'));
  try {
    const bundle=join(root,'bridge.mjs'); writeFileSync(bundle,'');
    assert.deepEqual(backendCommand(bundle,{PINOTE_NODE:process.execPath,NODE_OPTIONS:'--require=/missing'}),{executable:process.execPath,args:[bundle]});
    assert.throws(()=>backendCommand(bundle,{PATH:'.:relative',PINOTE_NODE:'node'}),/Install Node/);
    assert.throws(()=>backendCommand(bundle,{PINOTE_NODE:join(root,'missing')}),/Install Node/);
    const old=join(root,'old-node'); writeFileSync(old,'#!/bin/sh\necho v22.18.0\n',{mode:0o700});
    assert.throws(()=>backendCommand(bundle,{PINOTE_NODE:old}),/22.19/);
    assert.throws(()=>backendCommand(bundle,{PINOTE_ELECTRON_BACKEND:'relative'}),/Install Pinote/);
    assert.deepEqual(backendCommand(bundle,{PINOTE_ELECTRON_BACKEND:old}),{executable:old,args:[]});
    assert.deepEqual(backendEnvironment({PATH:'/usr/bin',NODE_OPTIONS:'bad',NODE_PATH:'bad',ELECTRON_RUN_AS_NODE:'1'}),{PATH:'/usr/bin'});
  } finally { rmSync(root,{recursive:true,force:true}); }
});
