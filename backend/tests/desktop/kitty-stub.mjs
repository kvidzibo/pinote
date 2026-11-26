// Stand-in for the Kitty remote-control subset Pinote uses. Hosted macOS runners lack the
// OpenGL 3.3 Kitty needs, so CI installs this as /Applications/kitty.app instead:
//   node kitty-stub.mjs --install /Applications/kitty.app
// Server: kitty [--listen-on=unix:PATH] [--directory=DIR] [--title=T] [options] [program...]
// Client: kitty @ --to unix:PATH ls|launch|set-tab-title|focus-window ...
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { createConnection, createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const option = (list, name) => list.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);

if (args[0] === '--install') {
  // Never overwrite an installed Kitty.
  mkdirSync(args[1]);
  const contents = join(args[1], 'Contents');
  mkdirSync(join(contents, 'MacOS'), { recursive: true });
  writeFileSync(join(contents, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>CFBundleExecutable</key><string>kitty</string>
<key>CFBundleIdentifier</key><string>net.kovidgoyal.kitty</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>\n`);
  // Absolute paths: Launch Services starts apps with launchd's minimal PATH.
  writeFileSync(join(contents, 'MacOS/kitty'), `#!/bin/sh\nexec '${process.execPath}' '${fileURLToPath(import.meta.url)}' "$@"\n`);
  chmodSync(join(contents, 'MacOS/kitty'), 0o755);
} else if (args[0] === '@') {
  const address = args[1] === '--to' ? args[2] : '';
  const socket = createConnection(address.replace(/^unix:/, ''));
  let reply = '';
  socket.on('connect', () => socket.end(JSON.stringify(args.slice(3))));
  socket.on('data', chunk => { reply += chunk; });
  socket.on('end', () => {
    const { output, error } = JSON.parse(reply);
    if (error) { process.stderr.write(`Error: ${error}\n`); process.exitCode = 1; } else process.stdout.write(output);
  });
  socket.on('error', error => { process.stderr.write(`Error: Failed to connect to ${address}: ${error.code}\n`); process.exitCode = 1; });
} else {
  const tabs = [], children = [];
  const run = (program, cwd, env, title) => {
    if (program.length) children.push(spawn(program[0], program.slice(1), { cwd, env, stdio: 'ignore' }));
    tabs.push({ id: tabs.length + 1, title });
    return tabs.length;
  };
  // Like Kitty: options precede the program; a relative socket path lives in TMPDIR.
  const first = args.findIndex((arg, i) => !arg.startsWith('-') && args[i - 1] !== '-o');
  const options = first < 0 ? args : args.slice(0, first);
  const start = () => run(first < 0 ? [] : args.slice(first), option(options, 'directory') || process.cwd(), process.env, option(options, 'title') || 'kitty');
  const listen = option(options, 'listen-on')?.replace(/^unix:/, '').replaceAll('{kitty_pid}', String(process.pid));
  // Only the forms Pinote sends; anything else fails as it would mislead the tests.
  const tab = id => tabs.find(tab => tab.id === Number(id)) ?? fail(`No matching window: ${id}`);
  const fail = message => { throw new Error(message); };
  const commands = {
    ls: () => JSON.stringify([{ id: 1, tabs: tabs.map(({ id, title }) => ({ id, title, windows: [{ id, title }] })) }]),
    launch: rest => {
      if (option(rest, 'type') !== 'tab' || rest.some(arg => arg.startsWith('--') && !/^--(type|cwd|env)=/.test(arg))) fail(`Unsupported launch: ${rest}`);
      const env = { ...process.env };
      for (const pair of rest.filter(arg => arg.startsWith('--env=')).map(arg => arg.slice(6))) env[pair.slice(0, pair.indexOf('='))] = pair.slice(pair.indexOf('=') + 1);
      return `${run(rest.filter(arg => !arg.startsWith('--')), option(rest, 'cwd') || process.cwd(), env, 'kitty')}\n`;
    },
    'set-tab-title': rest => {
      const match = rest.length === 3 ? /^--match=window_id:(\d+)$/.exec(rest[0])?.[1] : rest.length === 2 ? tabs.length : undefined;
      if (match === undefined || rest.at(-2) !== '--') fail(`Unsupported set-tab-title: ${rest}`);
      tab(match).title = rest.at(-1); return '';
    },
    'focus-window': rest => { tab(rest.length === 1 ? /^--match=id:(\d+)$/.exec(rest[0])?.[1] : undefined); return ''; },
  };
  if (listen) {
    const server = createServer({ allowHalfOpen: true }, connection => {
      let request = '';
      connection.on('data', chunk => { request += chunk; });
      connection.on('end', () => {
        const [command, ...rest] = JSON.parse(request);
        try { connection.end(JSON.stringify(commands[command] ? { output: commands[command](rest) } : { error: `Unknown command: ${command}` })); }
        catch (error) { connection.end(JSON.stringify({ error: error.message })); }
      });
    });
    server.on('error', error => { process.stderr.write(`${error}\n`); process.exit(1); });
    // Start the program only once Pinote can reach it, so a failed start leaves no child.
    server.listen(isAbsolute(listen) ? listen : join(process.env.TMPDIR || '/tmp', listen), start);
    process.on('SIGTERM', () => { for (const child of children) child.kill(); server.close(() => process.exit(0)); });
  } else start();
}
