import { build } from 'esbuild';
import { mkdir, readdir, readFile, writeFile, rm } from 'node:fs/promises';
await rm('dist', { recursive: true, force: true });
await mkdir('dist', { recursive: true });
const builds = await Promise.all(['cli', 'bridge'].map(name => build({
  metafile: true,
  entryPoints: [`src/${name}-entry.ts`], outfile: `dist/${name}.mjs`, bundle: true,
  platform: 'node', format: 'esm', target: 'node22.19',
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
})));
const lock = JSON.parse(await readFile('package-lock.json', 'utf8'));
const bundled = new Set(builds.flatMap(result => Object.keys(result.metafile.inputs).map(path => /^(node_modules\/(?:@[^/]+\/)?[^/]+)\//.exec(path)?.[1]).filter(Boolean)));
const notices = [];
for (const [path, entry] of Object.entries(lock.packages)) {
  if (!bundled.has(path)) continue;
  for (const file of (await readdir(path)).filter(name => /^licen[cs]e(?:\.|$)/i.test(name))) {
    notices.push(`${path} ${entry.version}\n${await readFile(`${path}/${file}`, 'utf8')}`);
  }
}
await writeFile('dist/THIRD_PARTY_NOTICES.txt', notices.join('\n\n---\n\n'));
