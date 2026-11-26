import { contextBridge, ipcRenderer } from 'electron';
import type { BackendApi, PinoteApi } from './protocol.ts';

const backend = Object.fromEntries(['snapshot','add','edit','transition','tag','agent','schedule','create_tag','rename_tag','delete_tag','tag_folder','completions','kitty'].map(operation => [operation, (params: unknown) => ipcRenderer.invoke('backend', operation, params)])) as BackendApi;
const api: PinoteApi = {
  ...backend,
  agentFields: () => ipcRenderer.invoke('agent-fields'),
  backendSettings: () => ipcRenderer.invoke('backend-settings'),
  switchBackend: () => ipcRenderer.invoke('switch-backend'),
  onBackendSwitchProgress: callback => { ipcRenderer.removeAllListeners('backend-switch-progress'); ipcRenderer.on('backend-switch-progress', (_event, text) => callback(text)); },
  openPreview: request => ipcRenderer.invoke('open-preview', request),
  updatePreview: (token, data) => ipcRenderer.invoke('update-preview', token, data),
  onPreviewClosed: callback => { ipcRenderer.removeAllListeners('preview-closed'); ipcRenderer.on('preview-closed', (_event, token, edit) => callback(token, edit)); },
  popupMenu: request => ipcRenderer.invoke('popup-menu', request),
  loadState: () => ipcRenderer.invoke('load-state'),
  acknowledgeWarning: () => ipcRenderer.invoke('acknowledge-warning'),
  saveState: state => ipcRenderer.invoke('save-state', state),
  watcherSettings: () => ipcRenderer.invoke('watcher-settings'),
  chooseWatcher: () => ipcRenderer.invoke('choose-watcher'),
  saveWatchers: (watchers, raw) => ipcRenderer.invoke('save-watchers', watchers, raw),
  kittyTabSettings: () => ipcRenderer.invoke('kitty-tab-settings'),
  saveKittyTabSettings: (oneTaskPerTab, raw) => ipcRenderer.invoke('save-kitty-tab-settings', oneTaskPerTab, raw),
  windowSettings: () => ipcRenderer.invoke('window-settings'),
  saveWindowSettings: startup => ipcRenderer.invoke('save-window-settings', startup),
  chooseFolder: () => ipcRenderer.invoke('choose-folder'),
  copy: text => ipcRenderer.invoke('copy', text),
  openLink: url => ipcRenderer.invoke('open-link', url),
  collapse: collapsed => ipcRenderer.invoke('collapse', collapsed),
  fit: height => ipcRenderer.invoke('fit', height),
  onCloseRequested: callback => { ipcRenderer.removeAllListeners('close-requested'); ipcRenderer.on('close-requested', () => callback()); },
  finishClose: () => ipcRenderer.invoke('finish-close'),
  cancelClose: () => ipcRenderer.invoke('cancel-close'),
};
contextBridge.exposeInMainWorld('pinote', Object.freeze(api));
