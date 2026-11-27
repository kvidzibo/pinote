import { app, BrowserWindow, screen, shell } from 'electron';
import { rmSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ImageView } from './protocol';

const extensions: Record<string, string> = { 'image/webp': 'webp', 'image/gif': 'gif', 'image/png': 'png', 'image/jpeg': 'jpg' };

/** Opens stored images as the Window settings choose: Pinote's image window, the asking window, or the system viewer. */
export function imageViewer(owner: BrowserWindow, load: (hash: string) => Promise<{ mime: string; bytes: Buffer } | null>, view: () => ImageView) {
  let current: BrowserWindow | undefined, returning = 0;
  // The system viewer reads private temporary copies, removed when Pinote quits.
  let folder: string | undefined;
  const close = () => current?.destroy();
  owner.on('closed', close); owner.on('hide', close); owner.on('minimize', close); owner.on('close', close);
  app.once('quit', () => { if (folder) try { rmSync(folder, { recursive: true, force: true }); } catch { /* Left for the system's temporary-file cleanup. */ } });
  return {
    /** True while the image window is open or focus is returning from it. */
    isOpen: () => !!current || returning > 0,
    /** Resolves true when the asking window should show the image itself. */
    async open(hash: unknown, from: BrowserWindow): Promise<boolean> {
      if (typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash)) throw new Error('Invalid image');
      const mode = view();
      if (mode === 'overlay') return true;
      const image = await load(hash), extension = image && extensions[image.mime];
      if (!image || !extension) throw new Error('This image was deleted or cannot be loaded.');
      if (mode === 'system') {
        folder ??= await mkdtemp(join(tmpdir(), 'pinote-images-'));
        const path = join(folder, `${hash}.${extension}`);
        await writeFile(path, image.bytes, { mode: 0o600 });
        const error = await shell.openPath(path);
        if (error) throw new Error(`Cannot open the system image viewer: ${error}`);
        return false;
      }
      close();
      if (from.isDestroyed()) return false;
      const at = from.getBounds(), area = screen.getDisplayNearestPoint({ x: Math.round(at.x + at.width / 2), y: Math.round(at.y + at.height / 2) }).workArea;
      const popup = new BrowserWindow({ width: 320, height: 240, parent: from, type: 'popup-menu', frame: false, resizable: false, show: false,
        skipTaskbar: true, alwaysOnTop: true, title: 'Image', backgroundColor: '#232832',
        webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, spellcheck: false, devTools: !app.isPackaged },
      });
      popup.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      popup.webContents.on('will-navigate', event => event.preventDefault());
      popup.webContents.on('will-attach-webview', event => event.preventDefault());
      popup.webContents.on('render-process-gone', () => popup.destroy());
      let left = false;
      current = popup;
      popup.on('closed', () => {
        if (current === popup) current = undefined;
        if (from.isDestroyed()) return;
        // Focus went elsewhere: a task preview closes as it does on losing focus.
        if (left) { if (from !== owner) from.destroy(); return; }
        // Dismissed here: back to the asking window, after the window manager has focused one of its own choice.
        returning++;
        setTimeout(() => { returning--; if (!from.isDestroyed()) from.focus(); }, 100);
      });
      try {
        await popup.loadURL(`pinote-app://ui/image.html#${hash}`);
        const size: unknown = await popup.webContents.executeJavaScript('pinoteImageSize');
        if (!Array.isArray(size) || size.length !== 2 || !size.every(side => Number.isSafeInteger(side) && side > 0)) throw new Error('This image was deleted or cannot be loaded.');
        // Natural size, scaled down to the screen; small images keep a usable window around them.
        const scale = Math.min(1, area.width / size[0], area.height / size[1]);
        const width = Math.min(area.width, Math.max(160, Math.round(size[0] * scale))), height = Math.min(area.height, Math.max(120, Math.round(size[1] * scale)));
        const bounds = { x: area.x + Math.round((area.width - width) / 2), y: area.y + Math.round((area.height - height) / 2), width, height };
        popup.setBounds(bounds); popup.show(); popup.focus();
        popup.on('blur', () => { left = true; popup.destroy(); });
        // X11 window managers can apply frame offsets after mapping (as for the task preview).
        setTimeout(() => { if (!popup.isDestroyed()) popup.setBounds(bounds); }, 100);
      } catch (error) {
        // Closed while loading, for example because Pinote was hidden.
        if (popup.isDestroyed()) return false;
        popup.destroy(); throw error;
      }
      return false;
    },
  };
}
