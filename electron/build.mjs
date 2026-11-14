import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
await rm('dist', { recursive: true, force: true });
await mkdir('dist', { recursive: true });
execFileSync(process.execPath, ['build.mjs'], { cwd: fileURLToPath(new URL('../backend/', import.meta.url)), stdio: 'inherit' });
await cp('../backend/dist', 'dist/pinote-backend', { recursive: true });
await Promise.all([
  build({ entryPoints: ['src/main.ts'], outfile: 'dist/main.cjs', bundle: true, platform: 'node', format: 'cjs', external: ['electron'], target: 'node22' }),
  build({ entryPoints: ['src/preload.ts'], outfile: 'dist/preload.cjs', bundle: true, platform: 'node', format: 'cjs', external: ['electron'], target: 'node22' }),
  build({ entryPoints: ['src/preview-preload.ts'], outfile: 'dist/preview-preload.cjs', bundle: true, platform: 'node', format: 'cjs', external: ['electron'], target: 'node22' }),
  build({ entryPoints: ['src/preview.ts'], outfile: 'dist/preview.js', bundle: true, platform: 'browser', target: 'chrome132' }),
  build({ entryPoints: ['src/renderer.ts'], outfile: 'dist/renderer.js', bundle: true, platform: 'browser', target: 'chrome132' }),
]);
await cp('src/index.html', 'dist/index.html');
await cp('src/preview.html', 'dist/preview.html');
await cp('src/style.css', 'dist/style.css');
await cp('icons', 'dist/icons', { recursive: true });
const lock = JSON.parse(await readFile('package-lock.json', 'utf8'));
const notices = [];
for (const [path, entry] of Object.entries(lock.packages)) {
  if (!path || entry.dev) continue;
  const licenses = (await readdir(path)).filter(name => /^licen[cs]e(?:\.|$)/i.test(name));
  for (const file of licenses) notices.push(`${path} ${entry.version}\n${await readFile(`${path}/${file}`, 'utf8')}`);
}
await writeFile('dist/THIRD_PARTY_NOTICES.txt', notices.join('\n\n---\n\n'));
