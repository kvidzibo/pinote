import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { initTheme } from '@earendil-works/pi-coding-agent';
import { getKeybindings } from '@earendil-works/pi-tui';
import { remoteConfig } from '../remote/client.ts';
import { RemoteSession } from '../remote/session.ts';
import { RemoteUI } from '../remote/ui.ts';
import type { startPinoteHttpServer } from '../mcp/http.ts';

test('selecting a task starts it with one menu activation and returns to the unchanged prompt', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'pinote-selection-'));
  const original = { ...process.env };
  delete process.env.KITTY_LISTEN_ON; // No live terminal controls in the mocked UI test.
  let service: Awaited<ReturnType<typeof startPinoteHttpServer>> | undefined;
  let session: RemoteSession | undefined;
  Object.assign(process.env, {
    PINOTE_TOKEN: 'isolated-task-selection-token-0123456789',
    PINOTE_NOTE_COMMAND: fileURLToPath(new URL('../../.venv/bin/note', import.meta.url)),
    PI_CODING_AGENT_DIR: join(temp, 'agent'), XDG_DATA_HOME: join(temp, 'data'), XDG_STATE_HOME: join(temp, 'state'),
  });
  const cli = (...args: string[]) => JSON.parse(execFileSync(process.env.PINOTE_NOTE_COMMAND!, ['--no-notify', ...args], { encoding: 'utf8' }));
  try {
    const { startPinoteHttpServer } = await import('../mcp/http.ts');
    service = await startPinoteHttpServer({ port: 0, logPath: join(temp, 'app.log') });
    session = new RemoteSession(remoteConfig({ ...process.env, PINOTE_URL: service.url }), () => {});
    await session.start([], 'task-selection-test');
    initTheme('dark', false);
    let homes = 0, selections = 0, searches = 0;
    const draft = 'Keep my unfinished prompt';
    const ctx = { mode: 'tui', isIdle: () => true, ui: {
      getEditorText: () => draft,
      setEditorText: () => assert.fail('Selection must not change the draft'),
      select: () => assert.fail('Selection must not ask for confirmation'),
      notify: (message: string) => assert.fail(message),
      custom: async (factory: any) => {
        let component: any;
        try { return await new Promise((resolve) => {
          const tui = { terminal: { rows: 36, columns: 100 }, requestRender() {} };
          const theme = { fg: (_color: string, text: string) => text };
          component = factory(tui, theme, getKeybindings(), resolve);
          if (!component.handleInput) { component.render(100); return; } // asynchronous native loader
          const rows = component.render(100).join(' ');
          if (!rows.includes('Search tasks ·')) {
            assert.equal(++homes, 1, 'Selection must not return to the home screen');
            assert.ok(!rows.includes('Type to filter'), 'Home has no filter');
            while (!component.render(100).some((row: string) => row.includes('→') && /Choose a task|Switch task/.test(row))) {
              component.handleInput('\x1b[B');
            }
            component.handleInput('\r');
          } else if (searches++ === 0) {
            component.handleInput('\x15');
            component.handleInput('Task selection target');
            component.render(100);
            component.handleInput('\r'); // Pending server search cannot activate old results.
          } else {
            assert.match(rows, /Task selection target/);
            selections++;
            component.handleInput('\r'); // One activation at the task row, never a confirmation.
          }
        }); } finally { component?.dispose(); }
      },
    } } as any;
    const ui = new RemoteUI({} as any, session);
    const task = cli('agent', 'add', '--text=Task selection target');
    for (const expectedState of ['active', 'in_progress']) {
      assert.equal(cli('agent', 'get', String(task.id)).state, expectedState);
      homes = selections = 0;
      searches = session.snapshot()?.state.search === 'Task selection target' ? 1 : 0;
      await ui.open(ctx);
      assert.equal(homes, 1);
      assert.equal(selections, 1);
      assert.equal(session.snapshot()?.state.selectedId, task.id);
      assert.equal(cli('agent', 'get', String(task.id)).state, 'in_progress');
      assert.equal(ctx.ui.getEditorText(), draft);
    }
  } finally {
    await session?.stop();
    await service?.close();
    for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key];
    Object.assign(process.env, original);
    rmSync(temp, { recursive: true, force: true });
  }
});
