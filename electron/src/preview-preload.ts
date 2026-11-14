import { contextBridge, ipcRenderer } from 'electron';
import type { PreviewApi } from './protocol';
const api: PreviewApi = {
  load: () => ipcRenderer.invoke('preview-load'),
  ready: height => ipcRenderer.invoke('preview-ready', height),
  action: action => ipcRenderer.invoke('preview-action', action),
  openLink: url => ipcRenderer.invoke('preview-link', url),
  onUpdate: callback => { ipcRenderer.removeAllListeners('preview-update'); ipcRenderer.on('preview-update', (_event, data) => callback(data)); },
};
contextBridge.exposeInMainWorld('pinotePreview', Object.freeze(api));
