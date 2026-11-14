import { main } from './cli.ts';
import { launch } from './launcher.ts';
process.exitCode = await launch(() => main(), import.meta.url);
