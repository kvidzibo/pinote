import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chmod, cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
await rm('dist', { recursive: true, force: true });
await mkdir('dist', { recursive: true });
execFileSync(process.execPath, ['build.mjs'], { cwd: fileURLToPath(new URL('../backend/', import.meta.url)), stdio: 'inherit' });
await cp('../backend/dist', 'dist/pinote-backend', { recursive: true });
// The task service and its bundled watchers run from real files beside the backend.
// Watchers import pi's compiled output when published; bundle the sources instead.
const piSource = { name: 'pi-source', setup(build) {
  build.onResolve({ filter: /^\.\.\/dist-mcp\/.+\.js$/ }, args => ({ path: resolve(args.resolveDir, args.path.replace('dist-mcp/', '').replace(/\.js$/, '.ts')) }));
} };
const service = { bundle: true, platform: 'node', format: 'esm', target: 'node22', metafile: true, plugins: [piSource],
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" } };
const watchers = (await readdir('../pi/watchers')).filter(name => name.endsWith('.mjs'));
const [served, watched] = await Promise.all([
  build({ ...service, entryPoints: ['../pi/mcp/http.ts'], outfile: 'dist/pinote-backend/service/http.mjs' }),
  build({ ...service, banner: {}, entryPoints: watchers.map(name => `../pi/watchers/${name}`), outdir: 'dist/pinote-backend/service/watchers', outExtension: { '.js': '.mjs' } }),
  build({ entryPoints: ['src/backend-switch-guard.ts'], outfile: 'dist/pinote-backend/switch-guard.mjs', bundle: true, platform: 'node', format: 'esm', target: 'node22' }),
  build({ entryPoints: ['src/main.ts'], outfile: 'dist/main.cjs', bundle: true, platform: 'node', format: 'cjs', external: ['electron'], target: 'node22' }),
  build({ entryPoints: ['src/preload.ts'], outfile: 'dist/preload.cjs', bundle: true, platform: 'node', format: 'cjs', external: ['electron'], target: 'node22' }),
  build({ entryPoints: ['src/preview-preload.ts'], outfile: 'dist/preview-preload.cjs', bundle: true, platform: 'node', format: 'cjs', external: ['electron'], target: 'node22' }),
  build({ entryPoints: ['src/preview.ts'], outfile: 'dist/preview.js', bundle: true, platform: 'browser', target: 'chrome132' }),
  build({ entryPoints: ['src/renderer.ts'], outfile: 'dist/renderer.js', bundle: true, platform: 'browser', target: 'chrome132' }),
]);
await Promise.all(watchers.map(name => chmod(`dist/pinote-backend/service/watchers/${name}`, 0o755)));
await cp('../pi/icons', 'dist/pinote-backend/icons', { recursive: true });
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
const bundled = new Set([served, watched].flatMap(result => Object.keys(result.metafile.inputs).map(path => /^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//.exec(path)?.[1]).filter(Boolean)));
for (const path of [...bundled].sort()) {
  const { version, license, author, repository } = JSON.parse(await readFile(`${path}/package.json`, 'utf8'));
  const files = (await readdir(path)).filter(name => /^licen[cs]e(?:\.|$)/i.test(name));
  // Some packages declare a license without shipping its text.
  const texts = files.length ? await Promise.all(files.map(file => readFile(`${path}/${file}`, 'utf8')))
    : [`License: ${license}\nAuthor: ${author?.name ?? author}\nSource: ${repository?.url ?? repository}`];
  if (!files.length && !license) throw new Error(`Missing license for bundled ${path}`);
  for (const text of texts) notices.push(`${path.replace(/^.*node_modules\//, 'node_modules/')} ${version}\n${text}`);
}
await writeFile('dist/THIRD_PARTY_NOTICES.txt', notices.join('\n\n---\n\n'));
