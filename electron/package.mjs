import { packager } from '@electron/packager';
import { flipFuses, FuseV1Options, FuseVersion } from '@electron/fuses';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
const { devDependencies } = JSON.parse(await readFile('package.json', 'utf8'));
const paths = await packager({ dir: '.', name: 'pinote-electron', executableName: 'pinote-electron', platform: 'linux', arch: process.arch, electronVersion: devDependencies.electron, out: 'out', overwrite: true, asar: true, ignore: /^\/(src|tests|out|node_modules|.*\.mjs|tsconfig\.json|package-lock\.json)(\/|$)/, prune: false });
for (const path of paths) {
  await flipFuses(join(path, 'pinote-electron'), { version: FuseVersion.V1, [FuseV1Options.RunAsNode]: false, [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false, [FuseV1Options.EnableNodeCliInspectArguments]: false });
  console.log(path);
}
