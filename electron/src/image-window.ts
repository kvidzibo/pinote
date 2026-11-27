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
  let folder: Promise<string> | undefined, created: string | undefined;
  const close = () => current?.destroy();
  owner.on('closed', close); owner.on('hide', close); owner.on('minimize', close); owner.on('close', close);
  app.once('quit', () => { if (created) try { rmSync(created, { recursive: true, force: true }); } catch { /* Left for the system's temporary-file cleanup. */ } });
  return {
    /** True while the image window is open or focus is returning from it. */
    isOpen: () => !!current || returning > 0,
    /** Resolves true when the asking window should show the image itself. */
    async open(hash: unknown, from: BrowserWindow): Promise<boolean> {
      if (typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash)) throw new Error('Invalid image');
      const mode = view();
      if (mode === 'overlay') return true;
      // Sampled before anything is awaited: the click's window normally has focus.
      const asked = !from.isDestroyed() && from.isFocused();
      const image = await load(hash), extension = image && extensions[image.mime];
      if (!image || !extension) throw new Error('This image was deleted or cannot be loaded.');
      if (mode === 'system') {
        // Shared by overlapping requests, so quitting removes every copy.
        folder ??= mkdtemp(join(tmpdir(), 'pinote-images-')).then(path => created = path, error => { folder = undefined; throw error; });
        const path = join(await folder, `${hash}.${extension}`);
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
        if (from === owner) { if (!left) from.focus(); return; }
        // Opened from a task preview, which closes once focus has left it for anything but this window.
        const settled = () => { if (!from.isDestroyed() && !from.isFocused()) from.destroy(); };
        // Focus went elsewhere: the preview stays only if that was the preview itself.
        if (left) { setTimeout(settled, 100); return; }
        // Dismissed here: the window manager focuses the checklist first, then focus returns to the preview.
        returning++;
        const back = (focused: boolean) => { clearTimeout(timer); owner.off('focus', handBack); returning--; if (focused && !from.isDestroyed()) from.focus(); else settled(); };
        const handBack = () => back(true), timer = setTimeout(() => back(false), 100);
        owner.once('focus', handBack);
      });
      try {
        await popup.loadURL(`pinote-app://ui/image.html#${hash}`);
        const size: unknown = await popup.webContents.executeJavaScript('pinoteImageSize');
        if (!Array.isArray(size) || size.length !== 2 || !size.every(side => Number.isSafeInteger(side) && side > 0)) throw new Error('This image was deleted or cannot be loaded.');
        // Natural size, scaled down to the screen; small images keep a usable window around them.
        const scale = Math.min(1, area.width / size[0], area.height / size[1]);
        const width = Math.min(area.width, Math.max(160, Math.round(size[0] * scale))), height = Math.min(area.height, Math.max(120, Math.round(size[1] * scale)));
        const bounds = { x: area.x + Math.round((area.width - width) / 2), y: area.y + Math.round((area.height - height) / 2), width, height };
        // Focus moved on while the image loaded: do not take it back.
        if (asked && !from.isFocused()) { left = true; popup.destroy(); return false; }
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
