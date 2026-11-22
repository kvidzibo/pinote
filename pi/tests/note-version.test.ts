import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connectEngine } from './host.ts';

test('an unsupported note is rejected until upgraded; a supported one is checked once', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'pinote-version-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const command = join(dir, 'note'), version = join(dir, 'version'), log = join(dir, 'log');
  await writeFile(command, `#!${process.execPath}
const fs = require('node:fs'); const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, args.join(' ') + '\\n');
console.log(args[0] === '--version' ? fs.readFileSync(${JSON.stringify(version)}, 'utf8') : '[]');
`, { mode: 0o700 });
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
  assert.deepEqual((await readFile(log, 'utf8')).trim().split('\n'),
    ['--version', '--version', '--no-notify agent tags', '--no-notify agent tags']);
});
