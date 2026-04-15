const { contextBridge, ipcRenderer } = require('electron');
const { Terminal } = require('@xterm/xterm');
const { FitAddon } = require('@xterm/addon-fit');

contextBridge.exposeInMainWorld('xtermApi', {
  // 保留字段以兼容旧代码；当前改为渲染进程直接加载 xterm bundle
  createTerminal: (options) => new Terminal(options),
  createFitAddon: () => new FitAddon()
});

contextBridge.exposeInMainWorld('termihub', {
  windowMinimize: () => ipcRenderer.send('window:minimize'),
  windowMaximize: () => ipcRenderer.send('window:maximize'),
  windowClose: () => ipcRenderer.send('window:close'),
  onWindowState: (cb) => {
    ipcRenderer.on('window:state', (_e, state) => cb(state));
  },

  openFolder: () => ipcRenderer.invoke('dialog:openFolder'),
  openPathInOS: (targetPath) => ipcRenderer.invoke('shell:openPath', targetPath),
  openExternalUrl: (url) => ipcRenderer.invoke('shell:openExternalUrl', url),
  showItemInFolder: (targetPath) => ipcRenderer.invoke('shell:showItemInFolder', targetPath),
  listFiles: (rootPath) => ipcRenderer.invoke('fs:list', rootPath),
  readFile: (filePath) => ipcRenderer.invoke('fs:readFile', filePath),
  getPackageScriptCommands: (rootPath) => ipcRenderer.invoke('pkg:scriptCommands', rootPath),
  clearDependencies: (rootPath) => ipcRenderer.invoke('pkg:clearDependencies', rootPath),
  onPackageScriptsChanged: (cb) => {
    ipcRenderer.on('pkg:scriptsChanged', () => cb());
  },
  notifyRendererReadyForOpenPath: () => ipcRenderer.send('app:rendererReadyForOpenPath'),
  onAppOpenFolderPath: (cb) => {
    ipcRenderer.on('app:openFolderPath', (_e, folderPath) => cb(folderPath));
  },
  debugLog: (location, message, data) => ipcRenderer.send('debug:log', { location, message, data }),

  ptyCreate: (cols, rows, cwd) =>
    ipcRenderer.send('pty:create', { cols, rows, cwd }),
  ptyWrite: (data) => ipcRenderer.send('pty:write', data),
  ptyResize: (cols, rows) => ipcRenderer.send('pty:resize', { cols, rows }),
  onPtyData: (cb) => {
    ipcRenderer.on('pty:data', (_e, data) => cb(data));
  },
  onPtyExit: (cb) => {
    ipcRenderer.on('pty:exit', () => cb());
  },
  onPtyError: (cb) => {
    ipcRenderer.on('pty:error', (_e, message) => cb(message));
  },
  onPtyStall: (cb) => {
    ipcRenderer.on('pty:stall', (_e, message) => cb(message));
  }
});
