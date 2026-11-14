import { main } from './bridge.ts';
import { installCancellation } from './runtime.ts';
installCancellation();
process.exitCode = await main();
