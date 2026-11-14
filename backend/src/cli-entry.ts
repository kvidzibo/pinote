import { main } from './cli.ts';
import { installCancellation } from './runtime.ts';
installCancellation();
process.exitCode = await main();
