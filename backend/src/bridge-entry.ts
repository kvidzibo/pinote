import { main, MAX_REQUEST } from './bridge.ts';
import { launch } from './launcher.ts';
process.exitCode = await launch(input => main(undefined, input), import.meta.url, process.argv.length > 2 ? undefined : MAX_REQUEST);
