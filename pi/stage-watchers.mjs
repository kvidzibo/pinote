// Keep existing paths valid when publishing pi-note independently of Electron.
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
await mkdir('watchers', { recursive: true });
for (const name of ['github-pr.mjs', 'forgejo-pr.mjs']) {
  const source = await readFile(new URL('../watchers/' + name, import.meta.url), 'utf8');
  await writeFile('watchers/' + name, source.replaceAll("from '../pi/", "from '../"));
  await chmod('watchers/' + name, 0o755);
}
