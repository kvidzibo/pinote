import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execGuardedService } from './backend-switch.ts';

try { await execGuardedService(dirname(fileURLToPath(import.meta.url))); }
catch { console.error('Pinote database guard could not verify the original database and service profile; HTTP not started.'); process.exitCode = 1; }
