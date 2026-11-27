import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store, NoteError } from '../../src/store.ts';
import { imageHashes, imageInfo, decodeImage, MAX_IMAGE_BYTES } from '../../src/images.ts';
import { respond } from '../../src/bridge.ts';
import { discoverPaths } from '../../src/runtime.ts';

const bytes = (...parts: (string | number[])[]) => Buffer.concat(parts.map(p => typeof p === 'string' ? Buffer.from(p, 'latin1') : Buffer.from(p)));
const png = (w: number, h: number) => { const b = bytes('\x89PNG\r\n\x1a\n', [0, 0, 0, 13], 'IHDR', [0, 0, 0, 0, 0, 0, 0, 0], [8, 6, 0, 0, 0]); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20); return b; };
const webpLossless = (w: number, h: number) => { const b = bytes('RIFF', [0, 0, 0, 0], 'WEBPVP8L', [0, 0, 0, 0, 0x2f], [0, 0, 0, 0], [0, 0, 0, 0, 0]); b.writeUInt32LE((w - 1) | (h - 1) << 14, 21); return b; };
const webpExtended = (w: number, h: number) => { const b = bytes('RIFF', [0, 0, 0, 0], 'WEBPVP8X', [10, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0, 0, 0], [0, 0]); b.writeUIntLE(w - 1, 24, 3); b.writeUIntLE(h - 1, 27, 3); return b; };
const webpLossy = (w: number, h: number) => { const b = bytes('RIFF', [0, 0, 0, 0], 'WEBPVP8 ', [0, 0, 0, 0], [0, 0, 0, 0x9d, 0x01, 0x2a], [0, 0, 0, 0], [0, 0]); b.writeUInt16LE(w, 26); b.writeUInt16LE(h, 28); return b; };
const jpeg = (w: number, h: number) => { const b = bytes([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 11, 8, 0, 0, 0, 0, 3, 0, 0, 0]); b.writeUInt16BE(h, 13); b.writeUInt16BE(w, 15); return b; };
const ref = (hash: string) => `![image](pinote:sha256-${hash})`;

test('image headers decide type and size; other bytes are refused', () => {
  assert.deepEqual(imageInfo(png(640, 480)), { mime: 'image/png', width: 640, height: 480 });
  assert.deepEqual(imageInfo(bytes('GIF89a', [10, 0, 20, 0])), { mime: 'image/gif', width: 10, height: 20 });
  assert.deepEqual(imageInfo(webpLossless(2560, 1440)), { mime: 'image/webp', width: 2560, height: 1440 });
  assert.deepEqual(imageInfo(webpExtended(300, 200)), { mime: 'image/webp', width: 300, height: 200 });
  assert.deepEqual(imageInfo(webpLossy(33, 44)), { mime: 'image/webp', width: 33, height: 44 });
  assert.deepEqual(imageInfo(jpeg(1024, 768)), { mime: 'image/jpeg', width: 1024, height: 768 });
  for (const bad of [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), Buffer.alloc(0), png(4097, 1), png(0, 5), Buffer.alloc(MAX_IMAGE_BYTES + 1)]) assert.throws(() => imageInfo(bad), NoteError);
  assert.throws(() => decodeImage('not base64!'), NoteError); assert.throws(() => decodeImage('QQ'), NoteError);
  assert.deepEqual(imageHashes(`a ${ref('a'.repeat(64))}\n${ref('b'.repeat(64))} ![x](pinote:sha256-short)`), ['a'.repeat(64), 'b'.repeat(64)]);
});

test('images are stored once and pruned only when no task text or kept draft references them', t => {
  const dir = mkdtempSync(join(tmpdir(), 'pinote-images-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'notes.db'), s = new Store(path);
  try {
    assert.equal(s.image('a'.repeat(64)), null); assert.deepEqual(s.prune_images([]), []);
    const first = s.add_image(png(2, 2)), again = s.add_image(png(2, 2));
    assert.equal(first.changed, true); assert.equal(again.changed, false); assert.equal(again.hash, first.hash);
    assert.deepEqual(s.image(first.hash), { mime: 'image/png', bytes: new Uint8Array(png(2, 2)) });
    const archived = s.add_image(png(3, 3)), draft = s.add_image(png(4, 4)), orphan = s.add_image(png(5, 5));
    s.add(`Shot ${ref(first.hash)}`);
    const done = s.add(`Old\n${ref(archived.hash)}`); s.transition(done, 'done');
    assert.deepEqual(s.prune_images([draft.hash]), [orphan.hash]);
    assert.equal(s.image(orphan.hash), null);
    // Deleting an image from text releases it once no other task uses it.
    s.edit(1n, 'Shot', { expected_updated_at: s.get(1n).updated_at });
    assert.deepEqual(s.prune_images([]).sort(), [first.hash, draft.hash].sort());
    assert.ok(s.image(archived.hash));
  } finally { s.close(); }
  // The table is additive: the database stays at schema 8 for earlier backends.
  const raw = new DatabaseSync(path, { readOnly: true });
  try { assert.equal(raw.prepare('PRAGMA user_version').get()!.user_version, 8); } finally { raw.close(); }
});

test('bridge stores, reads and prunes images with strict parameters', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'pinote-images-bridge-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const saved = { ...process.env }; t.after(() => { process.env = saved; });
  for (const [name, folder] of Object.entries({ HOME: 'home', XDG_DATA_HOME: 'data', XDG_STATE_HOME: 'state', XDG_CONFIG_HOME: 'config', XDG_CACHE_HOME: 'cache', XDG_RUNTIME_DIR: 'runtime' })) process.env[name] = join(dir, folder);
  const paths = discoverPaths(), call = (operation: string, params: any) => respond({ protocol: 1, operation, params }, paths);
  const data = webpLossless(8, 8).toString('base64');
  const added = await call('image_add', { data });
  assert.equal(added.ok, true); const hash = added.result.hash;
  assert.deepEqual(added.result, { changed: true, hash, mime: 'image/webp', width: 8, height: 8 });
  assert.deepEqual((await call('image', { hash })).result, { found: true, mime: 'image/webp', data });
  for (const [op, params] of [['image_add', { data: Buffer.from('<svg/>').toString('base64') }], ['image_add', { data: 'QQ' }], ['image', { hash: 'A'.repeat(64) }], ['image_prune', { keep: ['x'] }], ['image', { hash, extra: 1 }]] as const)
    assert.equal((await call(op, params)).error?.code, 'invalid', `${op} ${JSON.stringify(params).slice(0, 80)}`);
  assert.deepEqual((await call('image_prune', { keep: [hash] })).result, { changed: false, removed: [] });
  assert.deepEqual((await call('image_prune', { keep: [] })).result, { changed: true, removed: [hash] });
  assert.deepEqual((await call('image', { hash })).result, { found: false });
});
