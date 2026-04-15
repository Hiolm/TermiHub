const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs/promises');
const fsSync = require('fs');
const { spawn } = require('child_process');

/** @type {import('electron').BrowserWindow | null} */
let mainWindow = null;
/** 防止连续点击触发多个「选择文件夹」系统对话框 */
let openFolderDialogBusy = false;
/** @type {string | null} */
let pendingOpenFolderPath = null;
let rendererReadyForOpenPath = false;

/**
 * 渲染侧调试日志转发（renderer 可能受 CSP 限制无法 fetch 到本地日志端点）
 * @param {string} location
 * @param {string} message
 * @param {any} data
 */
function ingestDebugLog(location, message, data) {
  // #region agent log
  fetch('http://127.0.0.1:7272/ingest/e38d1efe-850d-4350-9b18-f5229d1c0183',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'c6636d'},body:JSON.stringify({sessionId:'c6636d',runId:'pre-fix-renderer-proxy',hypothesisId:'P1',location,message,data,timestamp:Date.now()})}).catch(()=>{});
  // #endregion
}

/**
 * 从启动参数中提取可打开的目录路径（用于“拖到 exe/快捷方式 打开”）。
 * @param {string[]} argv
 * @returns {string | null}
 */
function pickFolderPathFromArgv(argv) {
  if (!Array.isArray(argv)) return null;
  for (const arg of argv) {
    if (typeof arg !== 'string') continue;
    const raw = arg.trim();
    if (!raw || raw.startsWith('-')) continue;
    const abs = path.resolve(raw);
    try {
      const st = fsSync.statSync(abs);
      if (st.isDirectory()) return abs;
    } catch {
      /* ignore */
    }
  }
  return null;
}

/** @param {string} folderPath */
function requestOpenFolderPath(folderPath) {
  if (!folderPath || typeof folderPath !== 'string') return;
  const abs = path.resolve(folderPath);
  let sent = false;
  if (rendererReadyForOpenPath) {
    sent = sendToRenderer('app:openFolderPath', abs);
  }
  if (!sent) pendingOpenFolderPath = abs;
}

function getTargetWebContents() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    return mainWindow.webContents;
  }
  const w = BrowserWindow.getAllWindows()[0];
  return w && !w.isDestroyed() ? w.webContents : null;
}

/**
 * @param {string} channel
 * @param {...unknown} args
 */
function sendToRenderer(channel, ...args) {
  const wc = getTargetWebContents();
  if (!wc) return false;
  try {
    wc.send(channel, ...args);
    return true;
  } catch {
    return false;
  }
}

/*
 * package.json → 快捷命令：完全事件驱动（fs.watch），不使用 setInterval / 轮询磁盘。
 * 下方 setTimeout 仅在「watch 已触发」后对密集回调做防抖，不会按固定周期主动读文件。
 */
/** @type {import('fs').FSWatcher | null} */
let packageJsonWatcher = null;
let packageWatchDebounceTimer = null;

function stopPackageJsonWatcher() {
  if (packageWatchDebounceTimer) {
    clearTimeout(packageWatchDebounceTimer);
    packageWatchDebounceTimer = null;
  }
  if (packageJsonWatcher) {
    try {
      packageJsonWatcher.close();
    } catch {
      /* ignore */
    }
    packageJsonWatcher = null;
  }
}

function emitPackageScriptsChanged() {
  sendToRenderer('pkg:scriptsChanged');
}

/** 防抖：一次保存可能触发多次 watch，非定时轮询。 */
function schedulePackageScriptsChanged() {
  if (packageWatchDebounceTimer) clearTimeout(packageWatchDebounceTimer);
  packageWatchDebounceTimer = setTimeout(() => {
    packageWatchDebounceTimer = null;
    emitPackageScriptsChanged();
  }, 280);
}

/**
 * 监听 package.json（或工作区根目录下新建该文件），变更后通知渲染进程刷新快捷命令。
 * @param {string} workspaceRoot
 * @param {string} pkgDir
 */
async function startPackageJsonWatcher(workspaceRoot, pkgDir) {
  stopPackageJsonWatcher();
  if (!workspaceRoot || !mainWindow || mainWindow.isDestroyed()) return;

  const ws = path.resolve(workspaceRoot);
  const pkgPath = path.join(pkgDir, 'package.json');

  let pkgExists = false;
  try {
    await fs.access(pkgPath);
    pkgExists = true;
  } catch {
    /* 尚无 package.json，监听工作区根目录 */
  }

  try {
    if (pkgExists) {
      packageJsonWatcher = fsSync.watch(pkgPath, { persistent: false }, () => {
        schedulePackageScriptsChanged();
      });
    } else {
      packageJsonWatcher = fsSync.watch(ws, { persistent: false }, (_evt, filename) => {
        if (filename === 'package.json' || filename == null) {
          schedulePackageScriptsChanged();
        }
      });
    }
    if (packageJsonWatcher && typeof packageJsonWatcher.on === 'function') {
      packageJsonWatcher.on('error', () => stopPackageJsonWatcher());
    }
  } catch {
    stopPackageJsonWatcher();
  }
}

/** @type {import('child_process').ChildProcessWithoutNullStreams | import('node-pty').IPty | null} */
let ptyProcess = null;
/** @type {ReturnType<typeof setTimeout> | null} */
let ptyStallTimer = null;
let ptyHasReceivedData = false;
/** @type {{ spawn: Function } | null} */
let ptyBackend = null;
let ptyStartSeq = 0;
/** @type {{ id: number, firstChunkLogged: boolean } | null} */
let activePtyMeta = null;

function resolveNodePtyBackend() {
  if (ptyBackend) return ptyBackend;
  try {
    ptyBackend = require('node-pty');
    return ptyBackend;
  } catch {
    /* continue */
  }
  try {
    const pnpmDir = path.join(__dirname, '..', 'node_modules', '.pnpm');
    const entries = fsSync.readdirSync(pnpmDir, { withFileTypes: true });
    const hit = entries
      .filter((e) => e.isDirectory() && /^node-pty@/i.test(e.name))
      .map((e) => e.name)
      .sort()
      .pop();
    if (!hit) return null;
    ptyBackend = require(path.join(pnpmDir, hit, 'node_modules', 'node-pty'));
    return ptyBackend;
  } catch {
    return null;
  }
}

function createWindow() {
  const appIcon = path.join(__dirname, '..', 'ico', '100.png');
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 500,
    title: 'TermiHub',
    frame: false,
    backgroundColor: '#1e1e1e',
    icon: appIcon,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow?.focus();
    mainWindow?.webContents.focus();
    rendererReadyForOpenPath = false;
  });

  mainWindow.on('maximize', () => {
    mainWindow?.webContents.send('window:state', { maximized: true });
  });
  mainWindow.on('unmaximize', () => {
    mainWindow?.webContents.send('window:state', { maximized: false });
  });

  mainWindow.on('closed', () => {
    stopPackageJsonWatcher();
    mainWindow = null;
    if (ptyProcess) {
      try {
        ptyProcess.kill();
      } catch {
        /* ignore */
      }
      ptyProcess = null;
    }
    rendererReadyForOpenPath = false;
  });
}

/**
 * Windows：优先 PowerShell 7（pwsh，与 VS Code 一致），否则 Windows PowerShell；再退回 cmd。
 * @param {string} [workDir] 已 resolve 的工作目录，供 -WorkingDirectory，保证提示符里 PWD 正确。
 */
function findWindowsPwsh() {
  const pf = process.env.ProgramFiles;
  const local = process.env.LOCALAPPDATA;
  const candidates = [];
  if (pf) {
    candidates.push(path.join(pf, 'PowerShell', '7', 'pwsh.exe'));
  }
  if (local) {
    candidates.push(path.join(local, 'Programs', 'PowerShell', 'pwsh.exe'));
  }
  for (const p of candidates) {
    if (p && fsSync.existsSync(p)) {
      return p;
    }
  }
  return null;
}

function getShellAndArgs(workDir) {
  if (process.platform === 'win32') {
    const systemRoot = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
    const winPs = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const pwsh = findWindowsPwsh();
    let shell = pwsh || null;
    if (!shell && fsSync.existsSync(winPs)) {
      shell = winPs;
    }
    if (!shell) {
      return { shell: process.env.COMSPEC || 'cmd.exe', args: [] };
    }
    const args = ['-NoLogo'];
    // 仅 PowerShell 7+ 支持 -WorkingDirectory；Windows PowerShell 5 会报错并直接退出
    if (workDir && typeof workDir === 'string' && /\\pwsh\.exe$/i.test(shell)) {
      args.push('-WorkingDirectory', workDir);
    }
    return { shell, args };
  }
  return { shell: process.env.SHELL || '/bin/bash', args: ['-l'] };
}

/** @param {unknown} data */
function ptyDataToUtf8String(data) {
  if (data == null) return '';
  if (typeof data === 'string') return data;
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (data instanceof Uint8Array) return Buffer.from(data).toString('utf8');
  if (typeof data === 'object' && data !== null && 'data' in data && Array.isArray(/** @type {{ data: number[] }} */ (data).data)) {
    return Buffer.from(/** @type {{ data: number[] }} */ (data).data).toString('utf8');
  }
  return String(data);
}

/**
 * child_process 管道模式下，PowerShell 有时会单独输出一个 "\r" 分片，
 * 这会让光标回到行首并覆盖提示符文本（如 v24.14.1ers...）。
 * 同时将裸 "\n" 规范为 "\r\n"，避免 xterm 在 LF-only 时保留列位置造成后续行右移错位。
 * 这是 pipe 后端补偿；真实 PTY 不需要该处理。
 * @param {string} text
 */
function normalizePipeShellOutput(text) {
  const s = String(text);
  if (!s) return s;
  let out = s;
  // 单独的 CR 分片会覆盖行首，改成正常换行
  if (out === '\r') return '\r\n';
  // 裸 LF 会导致下一行沿用当前列，统一转成 CRLF
  out = out.replace(/(^|[^\r])\n/g, '$1\r\n');
  // 仍兜底处理剩余裸 CR
  out = out.replace(/\r(?!\n)/g, '\r\n');
  return out;
}

function startPty(cols, rows, cwd) {
  const startId = ++ptyStartSeq;
  // #region agent log
  fetch('http://127.0.0.1:7272/ingest/e38d1efe-850d-4350-9b18-f5229d1c0183',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'c6636d'},body:JSON.stringify({sessionId:'c6636d',runId:'pre-fix-cwdstack',hypothesisId:'S1',location:'src/main.js:startPty:entry',message:'startPty called',data:{startId,cols,rows,cwdArg:cwd||null,hasExistingPty:!!ptyProcess},timestamp:Date.now()})}).catch(()=>{});
  // #endregion
  if (ptyStallTimer) {
    clearTimeout(ptyStallTimer);
    ptyStallTimer = null;
  }
  ptyHasReceivedData = false;

  if (ptyProcess) {
    // #region agent log
    fetch('http://127.0.0.1:7272/ingest/e38d1efe-850d-4350-9b18-f5229d1c0183',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'c6636d'},body:JSON.stringify({sessionId:'c6636d',runId:'pre-fix-cwdstack',hypothesisId:'S2',location:'src/main.js:startPty:kill-old',message:'killing previous pty before start',data:{startId},timestamp:Date.now()})}).catch(()=>{});
    // #endregion
    try {
      ptyProcess.kill();
    } catch {
      /* ignore */
    }
    ptyProcess = null;
  }

  const workDir =
    cwd && typeof cwd === 'string'
      ? path.resolve(cwd)
      : process.env.USERPROFILE || process.env.HOME || process.cwd();

  const { shell, args: shellArgs } = getShellAndArgs(workDir);
  const backend = resolveNodePtyBackend();
  /** @type {import('child_process').ChildProcessWithoutNullStreams | import('node-pty').IPty | null} */
  let ptyInstance = null;
  if (backend && typeof backend.spawn === 'function') {
    try {
      ptyInstance = backend.spawn(shell, shellArgs, {
        name: 'xterm-256color',
        cols: Number(cols) > 0 ? Number(cols) : 80,
        rows: Number(rows) > 0 ? Number(rows) : 24,
        cwd: workDir,
        env: {
          ...process.env,
          TERM: 'xterm-256color'
        }
      });
      activePtyMeta = { id: startId, firstChunkLogged: false };
      // #region agent log
      fetch('http://127.0.0.1:7272/ingest/e38d1efe-850d-4350-9b18-f5229d1c0183',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'c6636d'},body:JSON.stringify({sessionId:'c6636d',runId:'pre-fix-cwdstack',hypothesisId:'S3',location:'src/main.js:startPty:node-pty-spawn',message:'spawned node-pty',data:{startId,shell,args:shellArgs,workDir,cols:Number(cols)>0?Number(cols):80,rows:Number(rows)>0?Number(rows):24},timestamp:Date.now()})}).catch(()=>{});
      // #endregion
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      sendToRenderer('pty:error', `${msg}。node-pty 启动失败。`);
      return;
    }

    ptyProcess = ptyInstance;
    ptyInstance.onData((out) => {
      ptyHasReceivedData = true;
      if (ptyStallTimer) {
        clearTimeout(ptyStallTimer);
        ptyStallTimer = null;
      }
      if (activePtyMeta && activePtyMeta.id === startId && !activePtyMeta.firstChunkLogged) {
        activePtyMeta.firstChunkLogged = true;
        // #region agent log
        fetch('http://127.0.0.1:7272/ingest/e38d1efe-850d-4350-9b18-f5229d1c0183',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'c6636d'},body:JSON.stringify({sessionId:'c6636d',runId:'pre-fix-cwdstack',hypothesisId:'S4',location:'src/main.js:startPty:first-data',message:'first output chunk from pty',data:{startId,preview:out.slice(0,160).replace(/\r/g,'\\r').replace(/\n/g,'\\n')},timestamp:Date.now()})}).catch(()=>{});
        // #endregion
      }
      sendToRenderer('pty:data', out);
    });
    ptyInstance.onExit(() => {
      if (ptyStallTimer) {
        clearTimeout(ptyStallTimer);
        ptyStallTimer = null;
      }
      if (ptyProcess === ptyInstance) {
        ptyProcess = null;
        if (activePtyMeta && activePtyMeta.id === startId) {
          activePtyMeta = null;
        }
        // #region agent log
        fetch('http://127.0.0.1:7272/ingest/e38d1efe-850d-4350-9b18-f5229d1c0183',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'c6636d'},body:JSON.stringify({sessionId:'c6636d',runId:'pre-fix-cwdstack',hypothesisId:'S5',location:'src/main.js:startPty:on-exit',message:'active pty exited',data:{startId},timestamp:Date.now()})}).catch(()=>{});
        // #endregion
        sendToRenderer('pty:exit');
      }
    });
    ptyStallTimer = setTimeout(() => {
      ptyStallTimer = null;
      if (!ptyProcess || ptyProcess !== ptyInstance || ptyHasReceivedData) {
        return;
      }
      sendToRenderer('pty:stall', '终端进程已启动但 2.5s 内无任何输出，请检查 Shell 初始化脚本或当前工作目录权限。');
    }, 2500);
    return;
  }

  try {
    ptyInstance = spawn(shell, shellArgs, {
      cwd: workDir,
      env: {
        ...process.env,
        TERM: 'xterm-256color'
      },
      stdio: 'pipe',
      windowsHide: true
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    sendToRenderer('pty:error', `${msg}。当前使用 child_process 终端后端，请检查系统 Shell 是否可用。`);
    return;
  }

  ptyProcess = ptyInstance;

  ptyInstance.stdout.on('data', (data) => {
    ptyHasReceivedData = true;
    if (ptyStallTimer) {
      clearTimeout(ptyStallTimer);
      ptyStallTimer = null;
    }
    const rawOut = ptyDataToUtf8String(data);
    const out = normalizePipeShellOutput(rawOut);
    if (rawOut !== out) {
      // #region agent log
      fetch('http://127.0.0.1:7272/ingest/e38d1efe-850d-4350-9b18-f5229d1c0183',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'c6636d'},body:JSON.stringify({sessionId:'c6636d',runId:'post-fix-cr-normalize',hypothesisId:'C1',location:'src/main.js:child:stdout:normalize',message:'normalized standalone CR in stdout',data:{rawPreview:rawOut.slice(0,80).replace(/\r/g,'\\r').replace(/\n/g,'\\n'),normalizedPreview:out.slice(0,80).replace(/\r/g,'\\r').replace(/\n/g,'\\n')},timestamp:Date.now()})}).catch(()=>{});
      // #endregion
    }
    const isActive = ptyProcess === ptyInstance;
    // #region agent log
    fetch('http://127.0.0.1:7272/ingest/e38d1efe-850d-4350-9b18-f5229d1c0183',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'c6636d'},body:JSON.stringify({sessionId:'c6636d',runId:'pre-fix-cwdstack-2',hypothesisId:'S7',location:'src/main.js:child:stdout',message:'child stdout chunk',data:{isActive,len:out.length,preview:out.slice(0,120).replace(/\r/g,'\\r').replace(/\n/g,'\\n')},timestamp:Date.now()})}).catch(()=>{});
    // #endregion
    sendToRenderer('pty:data', out);
  });
  ptyInstance.stderr.on('data', (data) => {
    ptyHasReceivedData = true;
    if (ptyStallTimer) {
      clearTimeout(ptyStallTimer);
      ptyStallTimer = null;
    }
    const rawOut = ptyDataToUtf8String(data);
    const out = normalizePipeShellOutput(rawOut);
    if (rawOut !== out) {
      // #region agent log
      fetch('http://127.0.0.1:7272/ingest/e38d1efe-850d-4350-9b18-f5229d1c0183',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'c6636d'},body:JSON.stringify({sessionId:'c6636d',runId:'post-fix-cr-normalize',hypothesisId:'C2',location:'src/main.js:child:stderr:normalize',message:'normalized standalone CR in stderr',data:{rawPreview:rawOut.slice(0,80).replace(/\r/g,'\\r').replace(/\n/g,'\\n'),normalizedPreview:out.slice(0,80).replace(/\r/g,'\\r').replace(/\n/g,'\\n')},timestamp:Date.now()})}).catch(()=>{});
      // #endregion
    }
    const isActive = ptyProcess === ptyInstance;
    // #region agent log
    fetch('http://127.0.0.1:7272/ingest/e38d1efe-850d-4350-9b18-f5229d1c0183',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'c6636d'},body:JSON.stringify({sessionId:'c6636d',runId:'pre-fix-cwdstack-2',hypothesisId:'S8',location:'src/main.js:child:stderr',message:'child stderr chunk',data:{isActive,len:out.length,preview:out.slice(0,120).replace(/\r/g,'\\r').replace(/\n/g,'\\n')},timestamp:Date.now()})}).catch(()=>{});
    // #endregion
    sendToRenderer('pty:data', out);
  });

  ptyStallTimer = setTimeout(() => {
    ptyStallTimer = null;
    if (!ptyProcess || ptyProcess !== ptyInstance || ptyHasReceivedData) {
      return;
    }
    const stallMsg = '终端进程已启动但 2.5s 内无任何输出，请检查 Shell 初始化脚本或当前工作目录权限。';
    sendToRenderer('pty:stall', stallMsg);
  }, 2500);

  ptyInstance.on('error', (err) => {
    const msg = err instanceof Error ? err.message : String(err);
    sendToRenderer('pty:error', msg);
  });

  ptyInstance.on('exit', () => {
    if (ptyStallTimer) {
      clearTimeout(ptyStallTimer);
      ptyStallTimer = null;
    }
    // 替换 shell 时会 kill 旧进程；旧进程的 onExit 晚到，不能清空已指向新 PTY 的 ptyProcess
    // #region agent log
    fetch('http://127.0.0.1:7272/ingest/e38d1efe-850d-4350-9b18-f5229d1c0183',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'c6636d'},body:JSON.stringify({sessionId:'c6636d',runId:'pre-fix-cwdstack-2',hypothesisId:'S9',location:'src/main.js:child:on-exit',message:'child pty exited',data:{isActive:ptyProcess===ptyInstance},timestamp:Date.now()})}).catch(()=>{});
    // #endregion
    if (ptyProcess === ptyInstance) {
      ptyProcess = null;
      sendToRenderer('pty:exit');
    }
  });
}

ipcMain.on('window:minimize', () => {
  mainWindow?.minimize();
});

ipcMain.on('window:maximize', () => {
  if (!mainWindow) return;
  if (mainWindow.isMaximized()) {
    mainWindow.unmaximize();
  } else {
    mainWindow.maximize();
  }
});

ipcMain.on('window:close', () => {
  mainWindow?.close();
});

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
    const folderPath = pickFolderPathFromArgv(argv);
    if (folderPath) {
      requestOpenFolderPath(folderPath);
    }
  });
}

app.whenReady().then(() => {
  createWindow();
  const startupFolderPath = pickFolderPathFromArgv(process.argv);
  if (startupFolderPath) {
    requestOpenFolderPath(startupFolderPath);
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

ipcMain.on('app:rendererReadyForOpenPath', () => {
  rendererReadyForOpenPath = true;
  if (pendingOpenFolderPath) {
    sendToRenderer('app:openFolderPath', pendingOpenFolderPath);
    pendingOpenFolderPath = null;
  }
});

ipcMain.on('debug:log', (_e, payload) => {
  if (!payload || typeof payload !== 'object') return;
  const location = typeof payload.location === 'string' ? payload.location : 'renderer';
  const message = typeof payload.message === 'string' ? payload.message : 'debug';
  const data = payload.data;
  ingestDebugLog(location, message, data);
});

ipcMain.handle('dialog:openFolder', async () => {
  if (!mainWindow) return null;
  if (openFolderDialogBusy) return null;
  openFolderDialogBusy = true;
  try {
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory'],
      title: '选择文件夹'
    });
    // #region agent log
    fetch('http://127.0.0.1:7272/ingest/e38d1efe-850d-4350-9b18-f5229d1c0183',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'c6636d'},body:JSON.stringify({sessionId:'c6636d',runId:'pre-fix-folder-switch',hypothesisId:'U1',location:'src/main.js:dialog:openFolder',message:'dialog openFolder result',data:{canceled:!!canceled,firstPath:filePaths&&filePaths[0]?String(filePaths[0]):null,count:Array.isArray(filePaths)?filePaths.length:0},timestamp:Date.now()})}).catch(()=>{});
    // #endregion
    if (canceled || !filePaths[0]) return null;
    return path.resolve(filePaths[0]);
  } finally {
    openFolderDialogBusy = false;
  }
});

ipcMain.handle('shell:showItemInFolder', async (_e, targetPath) => {
  if (!targetPath || typeof targetPath !== 'string') {
    return { ok: false, error: '无效路径' };
  }
  const abs = path.resolve(targetPath);
  try {
    await fs.stat(abs);
  } catch {
    return { ok: false, error: '路径不存在或无法访问' };
  }
  shell.showItemInFolder(abs);
  return { ok: true };
});

ipcMain.handle('shell:openPath', async (_e, targetPath) => {
  if (!targetPath || typeof targetPath !== 'string') {
    return { ok: false, error: '无效路径' };
  }
  const abs = path.resolve(targetPath);
  try {
    const stat = await fs.stat(abs);
    if (!stat.isFile() && !stat.isDirectory()) {
      return { ok: false, error: '路径不是文件或文件夹' };
    }
  } catch {
    return { ok: false, error: '路径不存在或无法访问' };
  }
  const errMsg = await shell.openPath(abs);
  if (errMsg) {
    return { ok: false, error: errMsg };
  }
  return { ok: true };
});

ipcMain.handle('shell:openExternalUrl', async (_e, url) => {
  if (!url || typeof url !== 'string') {
    return { ok: false, error: '无效链接' };
  }
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, error: '链接格式无效' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, error: '仅支持 http/https 链接' };
  }
  const errMsg = await shell.openExternal(parsed.toString());
  if (errMsg) {
    return { ok: false, error: errMsg };
  }
  return { ok: true };
});

/**
 * @param {string} dir
 * @param {string} base
 */
async function readDirTree(dir, base) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const nodes = [];
  entries.sort((a, b) => {
    if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    const rel = path.relative(base, full);
    if (ent.isDirectory()) {
      const children = await readDirTree(full, base);
      nodes.push({ type: 'dir', name: ent.name, path: rel, fullPath: full, children });
    } else {
      nodes.push({ type: 'file', name: ent.name, path: rel, fullPath: full });
    }
  }
  return nodes;
}

ipcMain.handle('fs:list', async (_e, rootPath) => {
  // #region agent log
  fetch('http://127.0.0.1:7272/ingest/e38d1efe-850d-4350-9b18-f5229d1c0183',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'c6636d'},body:JSON.stringify({sessionId:'c6636d',runId:'pre-fix-folder-switch',hypothesisId:'U2',location:'src/main.js:fs:list',message:'fs:list called',data:{rootPath:rootPath?String(rootPath):null},timestamp:Date.now()})}).catch(()=>{});
  // #endregion
  const abs = path.resolve(rootPath);
  const tree = await readDirTree(abs, abs);
  return { root: abs, tree };
});

ipcMain.handle('fs:readFile', async (_e, filePath) => {
  const buf = await fs.readFile(filePath);
  const text = buf.toString('utf8');
  const looksBinary = /[\x00-\x08\x0e-\x1f]/.test(text.slice(0, 4096));
  if (looksBinary) {
    return { ok: false, binary: true };
  }
  return { ok: true, content: text };
});

/**
 * @param {string} dir
 * @returns {Promise<'pnpm' | 'yarn' | 'npm'>}
 */
async function detectPackageManager(dir) {
  try {
    await fs.access(path.join(dir, 'pnpm-lock.yaml'));
    return 'pnpm';
  } catch {
    /* no pnpm lock */
  }
  try {
    await fs.access(path.join(dir, 'yarn.lock'));
    return 'yarn';
  } catch {
    /* no yarn lock */
  }
  return 'npm';
}

/**
 * 优先使用 root 下 package.json；没有则在一层子目录中查找（例如打开了仓库父目录）。
 * @param {string} rootPath
 * @returns {Promise<string>}
 */
async function resolvePackageRoot(rootPath) {
  const abs = path.resolve(rootPath);
  const direct = path.join(abs, 'package.json');
  try {
    await fs.access(direct);
    return abs;
  } catch {
    /* continue */
  }
  let entries;
  try {
    entries = await fs.readdir(abs, { withFileTypes: true });
  } catch {
    return abs;
  }
  const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
  for (const name of dirs) {
    const nested = path.join(abs, name, 'package.json');
    try {
      await fs.access(nested);
      return path.join(abs, name);
    } catch {
      /* continue */
    }
  }
  return abs;
}

/** @param {string} text */
function stripJsonBom(text) {
  return String(text).replace(/^\uFEFF/, '').trim();
}

/**
 * pnpm 常用脚本可直接 pnpm start；其余用 pnpm run，避免与 pnpm 内置子命令冲突。
 * @param {'pnpm' | 'yarn' | 'npm'} pm
 * @param {string} name
 */
function formatRunScript(pm, name) {
  if (pm === 'pnpm') {
    const direct = new Set(['start', 'test', 'stop', 'restart', 'publish']);
    if (direct.has(name)) return `pnpm ${name}`;
    return `pnpm run ${name}`;
  }
  if (pm === 'yarn') {
    const direct = new Set(['start', 'test']);
    if (direct.has(name)) return `yarn ${name}`;
    return `yarn run ${name}`;
  }
  if (name === 'start' || name === 'test') return `npm ${name}`;
  return `npm run ${name}`;
}

ipcMain.handle('pkg:scriptCommands', async (_e, rootPath) => {
  if (!rootPath || typeof rootPath !== 'string') {
    stopPackageJsonWatcher();
    return { ok: true, scripts: [], packageName: '', packageManager: 'npm', packageDir: '' };
  }

  const pkgDir = await resolvePackageRoot(rootPath);
  const pkgPath = path.join(pkgDir, 'package.json');

  /** @type {{ ok: boolean, scripts: object[], packageName: string, packageManager: string, packageDir: string, error?: string }} */
  let result;

  try {
    const text = stripJsonBom(await fs.readFile(pkgPath, 'utf8'));
    const raw = JSON.parse(text);
    const scriptsObj =
      raw.scripts && typeof raw.scripts === 'object' && !Array.isArray(raw.scripts) ? raw.scripts : {};
    const pm = await detectPackageManager(pkgDir);
    const scripts = [];
    for (const name of Object.keys(scriptsObj).sort((a, b) => a.localeCompare(b))) {
      const def = scriptsObj[name];
      const script = typeof def === 'string' ? def : String(def);
      const run = formatRunScript(pm, name);
      scripts.push({ name, run, script });
    }
    result = {
      ok: true,
      scripts,
      packageName: typeof raw.name === 'string' ? raw.name : '',
      packageManager: pm,
      packageDir: pkgDir
    };
  } catch (err) {
    const code = err && typeof err === 'object' && 'code' in err ? err.code : undefined;
    if (code === 'ENOENT') {
      result = { ok: true, scripts: [], packageName: '', packageManager: 'npm', packageDir: pkgDir };
    } else {
      result = {
        ok: false,
        scripts: [],
        packageName: '',
        packageManager: 'npm',
        packageDir: pkgDir,
        error: err instanceof Error ? err.message : String(err)
      };
    }
  }

  await startPackageJsonWatcher(rootPath, pkgDir);
  return result;
});

ipcMain.handle('pkg:clearDependencies', async (_e, rootPath) => {
  if (!rootPath || typeof rootPath !== 'string') {
    return { ok: false, error: '无效路径' };
  }
  const pkgDir = await resolvePackageRoot(rootPath);
  const nodeModulesPath = path.join(pkgDir, 'node_modules');
  let stat;
  try {
    stat = await fs.stat(nodeModulesPath);
  } catch (err) {
    const code = err && typeof err === 'object' && 'code' in err ? err.code : undefined;
    if (code === 'ENOENT') {
      return { ok: true, removed: false, path: nodeModulesPath };
    }
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  if (!stat.isDirectory()) {
    return { ok: false, error: 'node_modules 不是目录' };
  }
  try {
    await fs.rm(nodeModulesPath, { recursive: true, force: true });
    return { ok: true, removed: true, path: nodeModulesPath };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
});

ipcMain.on('pty:create', (_e, payload) => {
  const cols = payload?.cols ?? 80;
  const rows = payload?.rows ?? 24;
  const cwd = payload?.cwd;
  // #region agent log
  fetch('http://127.0.0.1:7272/ingest/e38d1efe-850d-4350-9b18-f5229d1c0183',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'c6636d'},body:JSON.stringify({sessionId:'c6636d',runId:'pre-fix-cwdstack',hypothesisId:'S6',location:'src/main.js:ipc:pty-create',message:'received pty:create ipc',data:{cols,rows,cwd:cwd||null},timestamp:Date.now()})}).catch(()=>{});
  // #endregion
  // 立即重建 PTY，避免切换目录时旧会话输出与新提示符叠加
  startPty(cols, rows, cwd);
});

ipcMain.on('pty:write', (_e, data) => {
  if (!ptyProcess) return;
  try {
    const text = ptyDataToUtf8String(data);
    if (typeof ptyProcess.write === 'function') {
      ptyProcess.write(text);
    } else {
      ptyProcess.stdin.write(text);
    }
  } catch {
    /* ignore */
  }
});

ipcMain.on('pty:resize', (_e, payload) => {
  if (!ptyProcess || !payload) return;
  const { cols, rows } = payload;
  if (!(cols > 0 && rows > 0)) return;
  if (typeof ptyProcess.resize === 'function') {
    try {
      ptyProcess.resize(cols, rows);
    } catch {
      /* ignore */
    }
  }
});
