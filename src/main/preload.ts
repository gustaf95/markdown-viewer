import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { AppCommand, EncodingChoice, FileErrorPayload, FileOpenedPayload, MdvApi, SaveResult } from '../common/types';

// contextIsolation: true 환경에서 renderer에 노출하는 유일한 통로.
// fs 등 Node API는 절대 노출하지 않고, main 프로세스 IPC 래퍼만 제공한다. (NF-204)
const api: MdvApi = {
  openFileDialog: () => ipcRenderer.invoke('dialog:open'),
  openPath: (filePath: string) => ipcRenderer.invoke('file:openPath', filePath),
  reload: (encoding?: EncodingChoice) => ipcRenderer.invoke('file:reload', encoding),
  getRecentFiles: () => ipcRenderer.invoke('recent:get'),
  openExternal: (url: string) => ipcRenderer.invoke('shell:openExternal', url),
  getPathForFile: (file: File) => webUtils.getPathForFile(file),
  saveFile: (content: string): Promise<SaveResult> => ipcRenderer.invoke('file:save', content),
  notifyDirty: (dirty: boolean) => ipcRenderer.send('doc:dirty', dirty),
  resolveClose: (action: 'close' | 'cancel') => ipcRenderer.send('app:resolve-close', action),
  onFileOpened: (cb: (payload: FileOpenedPayload) => void) => {
    ipcRenderer.on('file:opened', (_e, payload: FileOpenedPayload) => cb(payload));
  },
  onFileError: (cb: (payload: FileErrorPayload) => void) => {
    ipcRenderer.on('file:error', (_e, payload: FileErrorPayload) => cb(payload));
  },
  onCommand: (cb: (cmd: AppCommand) => void) => {
    ipcRenderer.on('app:command', (_e, cmd: AppCommand) => cb(cmd));
  },
};

contextBridge.exposeInMainWorld('mdv', api);
