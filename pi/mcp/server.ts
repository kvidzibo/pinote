import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createPinoteServer } from './core.ts';
export { createPinoteServer } from './core.ts';

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await createPinoteServer().connect(new StdioServerTransport());
}
