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
    let menus = 0;
    const draft = 'Keep my unfinished prompt';
    const ctx = { mode: 'tui', isIdle: () => true, ui: {
      getEditorText: () => draft,
      setEditorText: () => assert.fail('Selection must not change the draft'),
      select: () => assert.fail('Selection must not ask for confirmation'),
      notify: (message: string) => assert.fail(message),
      custom: async (factory: any) => new Promise((resolve) => {
        assert.equal(++menus, 1, 'Selection must close the menu without another screen');
        const tui = { terminal: { rows: 36, columns: 100 }, requestRender() {} };
        const theme = { fg: (_color: string, text: string) => text };
        const component = factory(tui, theme, getKeybindings(), resolve);
        try {
          component.render(100);
          component.handleInput('Task selection target');
          component.render(100);
          component.handleInput('\r');
        } finally { component.dispose(); }
      }),
    } } as any;
    const ui = new RemoteUI({} as any, session);
    const task = cli('agent', 'add', '--text=Task selection target');
    for (const expectedState of ['active', 'in_progress']) {
      assert.equal(cli('agent', 'get', String(task.id)).state, expectedState);
      menus = 0;
      await ui.open(ctx);
      assert.equal(menus, 1);
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
