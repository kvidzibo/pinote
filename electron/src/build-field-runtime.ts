import { build, type BuildOptions } from 'esbuild';
import { chmod, copyFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

export async function buildFieldRuntime(bundles: string) {
  // Keep the ESM runner and its executable watchers on the real filesystem.
  // Bundle watcher imports so executing them does not require the checkout.
  const watchers = (await readdir('../watchers')).filter(name => name.endsWith('.mjs'));
  const runtimeBuild = { bundle: true, platform: 'node', format: 'esm', target: 'node22', tsconfig: 'tsconfig.json' } satisfies BuildOptions;
  await Promise.all([
    build({ ...runtimeBuild, entryPoints: ['src/field-runtime.ts'], outfile: join(bundles, 'field-events.mjs') }),
    build({ ...runtimeBuild, entryPoints: watchers.map(name => `../watchers/${name}`), outdir: join(bundles, 'watchers'), outExtension: { '.js': '.mjs' } }),
  ]);
  await Promise.all([
    copyFile('src/field-handler-guardian.mjs', join(bundles, 'field-handler-guardian.mjs')),
    ...watchers.map(name => chmod(join(bundles, 'watchers', name), 0o755)),
  ]);
}
