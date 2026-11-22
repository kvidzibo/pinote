import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connectEngine } from './host.ts';

test('an unsupported note is rejected until upgraded; a supported one is checked once until replaced', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'pinote-version-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const command = join(dir, 'note'), version = join(dir, 'version'), log = join(dir, 'log');
  const install = async (file: string, reported: string) => writeFile(file, `#!${process.execPath}
const fs = require('node:fs'); const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, args.join(' ') + '\\n');
console.log(args[0] === '--version' ? ${reported} : '[]');
`, { mode: 0o700 });
  await install(command, `fs.readFileSync(${JSON.stringify(version)}, 'utf8')`);
  Object.assign(process.env, { PINOTE_NOTE_COMMAND: command, PI_CODING_AGENT_DIR: dir, XDG_DATA_HOME: dir, XDG_STATE_HOME: dir });
  const client = connectEngine();
  t.after(() => client.close());
  const tags = () => client.callTool({ name: 'tags', arguments: {},
    _meta: { 'native-ui/context': { conversationId: 'conversation', piSessionId: '12345678-1234-4234-8234-123456789012', state: {} } } });
  await writeFile(version, 'pinote 0.24.9');
  const rejected = await tags();
  assert.equal(rejected.isError, true);
  assert.match(rejected.content[0].text, /Pinote requires note 0\.25\.0\+/);
  await writeFile(version, 'pinote 0.25.0');
  for (let call = 0; call < 2; call++) assert.equal((await tags()).content[0].text, '[]');
  const calls = ['--version', '--version', '--no-notify agent tags', '--no-notify agent tags'];
  assert.deepEqual((await readFile(log, 'utf8')).trim().split('\n'), calls);
  // A replaced executable is checked again before it receives any command.
  await install(join(dir, 'older'), `'pinote 0.24.9'`);
  await rename(join(dir, 'older'), command);
  assert.match((await tags()).content[0].text, /Pinote requires note 0\.25\.0\+/);
  assert.deepEqual((await readFile(log, 'utf8')).trim().split('\n'), [...calls, '--version']);
});
