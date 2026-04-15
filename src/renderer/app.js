/* global termihub */

// xterm browser bundle exports:
// - window.Terminal: Terminal class
// - window.FitAddon: { FitAddon: class }
const TerminalCtor = /** @type {any} */ (window).Terminal;
const FitAddonCtor = /** @type {any} */ (/** @type {any} */ (window).FitAddon)?.FitAddon;
const WebLinksAddonCtor = /** @type {any} */ (/** @type {any} */ (window).WebLinksAddon)?.WebLinksAddon;

const QUICK_CMDS_KEY = 'termihub_quick_commands';

let rootPath = null;
/** 防止一次点击/连点触发多次选择文件夹 */
let openFolderBusy = false;
/** @type {{ name: string, run: string, script: string }[]} */
let packageScriptItems = [];
/** @type {string} */
let packageScriptsDir = '';
/** @type {'pnpm' | 'yarn' | 'npm'} */
let packageManager = 'npm';
/** @type {string} */
let packageJsonError = '';
let selectedFileEl = null;
/** @type {string | null} */
let selectedFilePath = null;
let term = null;
let fitAddon = null;
let pendingPtyCreateFromFolder = false;
let lastPtyOutputEndedWithNewline = true;
let rendererPtyDataSeen = 0;
/** 逻辑终端列表（共用一个实际 PTY），用于切换/重启 */
/** @type {{ id: string, name: string }[]} */
let terminals = [];
/** @type {string | null} */
let activeTerminalId = null;

function el(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

function renderTree(nodes, container, depth = 0) {
  for (const node of nodes) {
    if (node.type === 'dir') {
      const row = el(`
        <div class="tree-item dir-item" data-path="${escapeAttr(node.fullPath)}">
          <span class="chevron codicon codicon-chevron-right"></span>
          <span class="icon codicon codicon-folder"></span>
          <span class="label">${escapeHtml(node.name)}</span>
        </div>
      `);
      const childWrap = document.createElement('div');
      childWrap.className = 'tree-children';
      childWrap.style.display = 'none';
      renderTree(node.children || [], childWrap, depth + 1);
      container.appendChild(row);
      container.appendChild(childWrap);

      const chevron = row.querySelector('.chevron');
      row.addEventListener('click', (e) => {
        e.stopPropagation();
        const open = childWrap.style.display === 'none';
        childWrap.style.display = open ? 'block' : 'none';
        chevron.classList.toggle('codicon-chevron-right', !open);
        chevron.classList.toggle('codicon-chevron-down', open);
        row.querySelector('.icon').classList.toggle('codicon-folder', !open);
        row.querySelector('.icon').classList.toggle('codicon-folder-opened', open);
      });
    } else {
      const row = el(`
        <div class="tree-item file-item" data-full="${escapeAttr(node.fullPath)}" data-name="${escapeAttr(node.name)}">
          <span class="icon codicon codicon-file"></span>
          <span class="label">${escapeHtml(node.name)}</span>
        </div>
      `);
      row.addEventListener('click', (e) => {
        e.stopPropagation();
        if (selectedFileEl) selectedFileEl.classList.remove('selected');
        selectedFileEl = row;
        row.classList.add('selected');
        selectedFilePath = node.fullPath;
        updateTmStatusCwd();
      });
      row.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        openPathInOS(node.fullPath);
      });
      container.appendChild(row);
    }
  }
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeAttr(s) {
  return String(s).replace(/"/g, '&quot;');
}

function loadQuickCommands() {
  try {
    const raw = localStorage.getItem(QUICK_CMDS_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((x) => typeof x === 'string' && x.trim()) : [];
  } catch {
    return [];
  }
}

function saveQuickCommands(cmds) {
  localStorage.setItem(QUICK_CMDS_KEY, JSON.stringify(cmds));
}

async function refreshPackageScripts() {
  packageScriptItems = [];
  packageScriptsDir = '';
  packageManager = 'npm';
  packageJsonError = '';
  if (!rootPath) {
    renderQuickCommands();
    return;
  }
  try {
    if (typeof termihub.getPackageScriptCommands !== 'function') {
      renderQuickCommands();
      return;
    }
    const res = await termihub.getPackageScriptCommands(rootPath);
    packageScriptsDir = res && typeof res.packageDir === 'string' ? res.packageDir : '';
    if (
      res &&
      typeof res.packageManager === 'string' &&
      (res.packageManager === 'pnpm' || res.packageManager === 'yarn' || res.packageManager === 'npm')
    ) {
      packageManager = res.packageManager;
    }
    if (res && res.ok && Array.isArray(res.scripts)) {
      packageScriptItems = res.scripts;
    } else if (res && !res.ok && res.error) {
      packageJsonError = String(res.error);
    }
  } catch (e) {
    packageScriptItems = [];
    packageJsonError = e && e.message ? e.message : String(e);
  }
  renderQuickCommands();
}

function appendSectionTitle(list, text) {
  const hdr = document.createElement('div');
  hdr.className = 'quick-cmd-section-title';
  hdr.textContent = text;
  list.appendChild(hdr);
}

function renderQuickCommands() {
  const list = document.getElementById('quick-commands-list');
  if (!list) return;
  list.innerHTML = '';

  if (packageScriptItems.length > 0) {
    const title =
      packageScriptsDir && rootPath && packageScriptsDir !== rootPath
        ? `package.json（${packageScriptsDir}）`
        : 'package.json scripts';
    appendSectionTitle(list, title);
    for (const item of packageScriptItems) {
      const row = document.createElement('div');
      row.className = 'quick-cmd-item quick-cmd-item--pkg';
      row.addEventListener('click', () => sendCmdToPty(item.run));
      const title = document.createElement('div');
      title.className = 'quick-cmd-text';
      title.textContent = item.name;
      const sub = document.createElement('div');
      sub.className = 'quick-cmd-sub';
      sub.textContent = item.run;
      sub.title = item.script;
      row.appendChild(title);
      row.appendChild(sub);
      list.appendChild(row);
    }
  }

  const cmds = loadQuickCommands();
  if (cmds.length > 0) {
    if (packageScriptItems.length > 0) {
      appendSectionTitle(list, '已保存命令');
    }
    cmds.forEach((cmd, index) => {
      const row = document.createElement('div');
      row.className = 'quick-cmd-item';
      const text = document.createElement('span');
      text.className = 'quick-cmd-text';
      text.textContent = cmd;
      text.addEventListener('click', () => sendCmdToPty(cmd));
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'quick-cmd-del codicon codicon-close';
      del.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const next = loadQuickCommands();
        next.splice(index, 1);
        saveQuickCommands(next);
        renderQuickCommands();
      });
      row.appendChild(text);
      row.appendChild(del);
      list.appendChild(row);
    });
  }

  if (packageScriptItems.length === 0 && cmds.length === 0) {
    const hint = document.createElement('div');
    hint.className = 'empty-hint';
    if (packageJsonError) {
      hint.textContent = `读取 package.json 失败：${packageJsonError}`;
    } else {
      hint.textContent = rootPath
        ? '当前打开的路径下未找到 package.json（已包含一层子目录查找）或未配置 scripts。请用顶栏「打开文件夹」选到含 package.json 的目录（例如 TermiHub 项目根目录）。'
        : '用顶栏「打开文件夹」选择项目根目录后，会自动列出 scripts（如 pnpm start）；也可在下方手动添加命令。';
    }
    list.appendChild(hint);
  }
}

function addQuickCommand() {
  const input = document.getElementById('quick-cmd-input');
  if (!input) return;
  const v = input.value.trim();
  if (!v) return;
  const cmds = loadQuickCommands();
  cmds.push(v);
  saveQuickCommands(cmds);
  input.value = '';
  renderQuickCommands();
}

function focusTerminal() {
  try {
    term?.focus();
  } catch {
    /* ignore */
  }
}

/** @param {string} text */
async function writeTextToClipboard(text) {
  const val = String(text || '');
  if (!val) return false;
  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      await navigator.clipboard.writeText(val);
      return true;
    }
  } catch {
    /* fallback */
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = val;
    ta.setAttribute('readonly', 'true');
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    ta.style.top = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, ta.value.length);
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return !!ok;
  } catch {
    return false;
  }
}

async function copyTerminalSelection() {
  if (!term || !term.hasSelection()) return false;
  const selection = term.getSelection();
  const ok = await writeTextToClipboard(selection);
  if (ok) {
    setTmStatus('已复制终端选中内容', false);
  } else {
    setTmStatus('复制失败：系统剪贴板不可用', true);
  }
  return ok;
}

/** @param {string} cmd */
function sendCmdToPty(cmd) {
  if (!cmd) return;
  focusTerminal();
  const line = /\r|\n$/.test(cmd) ? cmd : `${cmd}\r`;
  termihub.ptyWrite(line);
}

function setTmStatus(text, isError = false) {
  const el = document.getElementById('tm-status');
  if (!el) return;
  el.textContent = text;
  el.classList.toggle('tm-status--error', isError);
}

function updateTmStatusCwd() {
  const cwdLine = rootPath ? `工作目录：${rootPath}` : '工作目录：未打开文件夹';
  const fileLine = selectedFilePath ? `\n选中：${selectedFilePath}` : '';
  setTmStatus(cwdLine + fileLine, false);
}

/** @param {string} fullPath */
async function openPathInOS(fullPath) {
  const res = await termihub.openPathInOS(fullPath);
  if (res.ok) return;
  setTmStatus(res.error || '无法打开', true);
}

function nudgePtyGeometry() {
  fitAddon.fit();
  const d = fitAddon.proposeDimensions();
  if (d && d.cols > 0 && d.rows > 0) {
    termihub.ptyResize(d.cols, d.rows);
  }
}

/** 连续两帧后再执行，避免首帧 flex 未结算时终端容器为 0×0、xterm 不绘制 */
function afterLayoutStable(fn) {
  requestAnimationFrame(() => {
    requestAnimationFrame(fn);
  });
}

function restartShell() {
  afterLayoutStable(() => {
    fitAddon.fit();
    const d = fitAddon.proposeDimensions();
    term.reset();
    termihub.ptyCreate(d?.cols ?? 80, d?.rows ?? 24, rootPath || undefined);
    updateTmStatusCwd();
    focusTerminal();
    nudgePtyGeometry();
  });
}

function ensureTerminalEntryForRestart() {
  if (!rootPath) {
    return;
  }
  if (!activeTerminalId || !terminals.some((t) => t.id === activeTerminalId)) {
    const id = String(Date.now());
    const n = terminals.length + 1;
    const name = n === 1 ? 'PowerShell' : `PowerShell ${n}`;
    terminals.push({ id, name });
    activeTerminalId = id;
  }
  renderTerminalList();
}

function getInstallDepsCommand() {
  if (packageManager === 'pnpm') return 'pnpm install';
  if (packageManager === 'yarn') return 'yarn install';
  return 'npm install';
}

async function openFolder() {
  if (openFolderBusy) return;
  openFolderBusy = true;
  try {
    const picked = await termihub.openFolder();
    if (!picked) return;
    await openFolderByPath(picked);
  } finally {
    openFolderBusy = false;
  }
}

/** @param {string} picked */
async function openFolderByPath(picked) {
  const treeEl = document.getElementById('file-tree');
  treeEl.innerHTML = '<div class="empty-hint">正在加载目录…</div>';

  let tree;
  try {
    ({ tree } = await termihub.listFiles(picked));
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    treeEl.innerHTML = `<div class="empty-hint">无法读取该文件夹：${escapeHtml(msg)}</div>`;
    setTmStatus(`无法打开目录：${msg}`, true);
    return;
  }

  rootPath = picked;
  treeEl.innerHTML = '';
  renderTree(tree, treeEl);
  selectedFileEl = null;
  selectedFilePath = null;
  updateTmStatusCwd();

  // #region agent log
  fetch('http://127.0.0.1:7272/ingest/e38d1efe-850d-4350-9b18-f5229d1c0183',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'c6636d'},body:JSON.stringify({sessionId:'c6636d',runId:'pre-fix-ptycreate-missing',hypothesisId:'V1',location:'src/renderer/app.js:openFolderByPath:afterTree',message:'openFolderByPath reached afterTree',data:{picked,hasTerm:!!term,hasFit:!!fitAddon},timestamp:Date.now()})}).catch(()=>{});
  try { termihub?.debugLog?.('src/renderer/app.js:openFolderByPath:afterTree','V1 openFolderByPath reached afterTree',{picked,hasTerm:!!term,hasFit:!!fitAddon}); } catch {}
  // #endregion

  await refreshPackageScripts();

  afterLayoutStable(() => {
    try {
      // #region agent log
      fetch('http://127.0.0.1:7272/ingest/e38d1efe-850d-4350-9b18-f5229d1c0183',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'c6636d'},body:JSON.stringify({sessionId:'c6636d',runId:'pre-fix-ptycreate-missing',hypothesisId:'V2',location:'src/renderer/app.js:openFolderByPath:afterLayoutStable',message:'afterLayoutStable callback entered',data:{picked,hasTerm:!!term,hasFit:!!fitAddon},timestamp:Date.now()})}).catch(()=>{});
      try { termihub?.debugLog?.('src/renderer/app.js:openFolderByPath:afterLayoutStable','V2 afterLayoutStable callback entered',{picked,hasTerm:!!term,hasFit:!!fitAddon}); } catch {}
      // #endregion

      fitAddon.fit();
      const d = fitAddon.proposeDimensions();
      term.reset();

      // #region agent log
      fetch('http://127.0.0.1:7272/ingest/e38d1efe-850d-4350-9b18-f5229d1c0183',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'c6636d'},body:JSON.stringify({sessionId:'c6636d',runId:'pre-fix-ptycreate-missing',hypothesisId:'V3',location:'src/renderer/app.js:openFolderByPath:beforePtyCreate',message:'about to call ptyCreate',data:{picked,cols:d?.cols??null,rows:d?.rows??null},timestamp:Date.now()})}).catch(()=>{});
      try { termihub?.debugLog?.('src/renderer/app.js:openFolderByPath:beforePtyCreate','V3 about to call ptyCreate',{picked,cols:d?.cols??null,rows:d?.rows??null}); } catch {}
      // #endregion

      try { termihub?.debugLog?.('src/renderer/app.js:openFolderByPath:afterV3','V3x after V3 marker',{picked}); } catch {}

      // #region agent log
    fetch('http://127.0.0.1:7272/ingest/e38d1efe-850d-4350-9b18-f5229d1c0183',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'c6636d'},body:JSON.stringify({sessionId:'c6636d',runId:'pre-fix-renderer-frozen',hypothesisId:'T4',location:'src/renderer/app.js:openFolderByPath:beforePtyCreate',message:'renderer preparing pty create from folder',data:{picked,lastPtyOutputEndedWithNewline},timestamp:Date.now()})}).catch(()=>{});
      // #endregion

      pendingPtyCreateFromFolder = true;
      try { termihub?.debugLog?.('src/renderer/app.js:openFolderByPath:invokePtyCreate','V3b invoking ptyCreate',{picked,ptyCreateType:typeof termihub?.ptyCreate}); } catch {}
      termihub.ptyCreate(d?.cols ?? 80, d?.rows ?? 24, picked);
      // #region agent log
      fetch('http://127.0.0.1:7272/ingest/e38d1efe-850d-4350-9b18-f5229d1c0183',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'c6636d'},body:JSON.stringify({sessionId:'c6636d',runId:'pre-fix-ptycreate-missing',hypothesisId:'V4',location:'src/renderer/app.js:openFolderByPath:afterPtyCreate',message:'ptyCreate invoked in renderer',data:{picked},timestamp:Date.now()})}).catch(()=>{});
      try { termihub?.debugLog?.('src/renderer/app.js:openFolderByPath:afterPtyCreate','V4 ptyCreate invoked in renderer',{picked}); } catch {}
      // #endregion

      focusTerminal();
      nudgePtyGeometry();
    } catch (err) {
      try { termihub?.debugLog?.('src/renderer/app.js:openFolderByPath:afterLayoutStableError','Verr afterLayoutStable callback threw',{picked,error:err instanceof Error?err.message:String(err)}); } catch {}
    }
  });
}

function initFolderDragOpen() {
  window.addEventListener('dragover', (ev) => {
    ev.preventDefault();
  });
  window.addEventListener('drop', async (ev) => {
    ev.preventDefault();
    if (openFolderBusy) return;
    const files = ev.dataTransfer?.files;
    if (!files || files.length === 0) return;
    const first = files[0];
    const droppedPath =
      first && typeof first.path === 'string' && first.path.trim() ? first.path.trim() : '';
    if (!droppedPath) return;
    openFolderBusy = true;
    try {
      await openFolderByPath(droppedPath);
    } finally {
      openFolderBusy = false;
    }
  });
}

function initAppOpenFolderPath() {
  if (typeof termihub.onAppOpenFolderPath !== 'function') return;
  termihub.onAppOpenFolderPath(async (folderPath) => {
    if (!folderPath || typeof folderPath !== 'string') return;
    if (openFolderBusy) return;
    openFolderBusy = true;
    try {
      await openFolderByPath(folderPath);
    } finally {
      openFolderBusy = false;
    }
  });
  if (typeof termihub.notifyRendererReadyForOpenPath === 'function') {
    termihub.notifyRendererReadyForOpenPath();
  }
}

function initTerminal() {
  const container = document.getElementById('terminal-container');
  if (!TerminalCtor || !FitAddonCtor) {
    return;
  }

  term = new TerminalCtor({
    cursorBlink: true,
    fontFamily: 'Cascadia Mono, Consolas, monospace',
    fontSize: 13,
    theme: {
      background: '#1e1e1e',
      foreground: '#cccccc',
      cursor: '#aeafad',
      selectionBackground: '#264f78'
    }
  });
  fitAddon = new FitAddonCtor();
  term.loadAddon(fitAddon);
  if (WebLinksAddonCtor) {
    const webLinksAddon = new WebLinksAddonCtor(async (event, uri) => {
      const e = /** @type {MouseEvent | undefined} */ (event);
      if (!e || e.button !== 0 || !e.ctrlKey) return;
      e.preventDefault();
      if (typeof termihub.openExternalUrl !== 'function') return;
      const ret = await termihub.openExternalUrl(uri);
      if (!ret?.ok) {
        setTmStatus(ret?.error || '打开链接失败', true);
      }
    });
    term.loadAddon(webLinksAddon);
  }
  term.open(container);
  fitAddon.fit();
  focusTerminal();
  fitAddon.fit();
  term.attachCustomKeyEventHandler((ev) => {
    if (!ev || ev.type !== 'keydown') return true;
    const key = typeof ev.key === 'string' ? ev.key.toLowerCase() : '';
    if (key !== 'c') return true;
    const primaryMod = ev.ctrlKey || ev.metaKey;
    if (!primaryMod || ev.altKey) return true;
    const hasSelection = term?.hasSelection?.() === true;
    const shouldCopy = ev.shiftKey || hasSelection;
    if (!shouldCopy) return true;
    ev.preventDefault();
    void copyTerminalSelection();
    return false;
  });

  container.addEventListener('mousedown', () => focusTerminal());
  container.addEventListener('click', () => focusTerminal());
  container.addEventListener('contextmenu', (ev) => {
    if (!term || !term.hasSelection()) return;
    ev.preventDefault();
    void copyTerminalSelection();
  });

  termihub.onPtyData((data) => {
    if (data == null) return;
    try {
      rendererPtyDataSeen += 1;
      const text = typeof data === 'string' ? data : data instanceof Uint8Array ? String.fromCharCode(...data) : String(data);
      if (rendererPtyDataSeen <= 3) {
        // #region agent log
        fetch('http://127.0.0.1:7272/ingest/e38d1efe-850d-4350-9b18-f5229d1c0183',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'c6636d'},body:JSON.stringify({sessionId:'c6636d',runId:'pre-fix-renderer-frozen',hypothesisId:'T1',location:'src/renderer/app.js:onPtyData:entry',message:'renderer received pty data',data:{rendererPtyDataSeen,len:text.length,preview:text.slice(0,120).replace(/\r/g,'\\r').replace(/\n/g,'\\n')},timestamp:Date.now()})}).catch(()=>{});
        // #endregion
      }
      if (pendingPtyCreateFromFolder) {
        // #region agent log
        fetch('http://127.0.0.1:7272/ingest/e38d1efe-850d-4350-9b18-f5229d1c0183',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'c6636d'},body:JSON.stringify({sessionId:'c6636d',runId:'pre-fix-renderer-frozen',hypothesisId:'T2',location:'src/renderer/app.js:onPtyData:firstAfterFolderCreate',message:'first renderer pty chunk after folder create',data:{preview:text.slice(0,160).replace(/\r/g,'\\r').replace(/\n/g,'\\n'),startsWithPrompt:/^PS\\s/i.test(text),lastPtyOutputEndedWithNewline},timestamp:Date.now()})}).catch(()=>{});
        // #endregion
        pendingPtyCreateFromFolder = false;
      }
      if (typeof data === 'string') {
        term.write(data);
      } else if (data instanceof Uint8Array) {
        term.write(data);
      } else {
        term.write(String(data));
      }
      lastPtyOutputEndedWithNewline = /\r?\n$/.test(text);
    } catch (err) {
      // #region agent log
      fetch('http://127.0.0.1:7272/ingest/e38d1efe-850d-4350-9b18-f5229d1c0183',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'c6636d'},body:JSON.stringify({sessionId:'c6636d',runId:'pre-fix-renderer-frozen',hypothesisId:'T3',location:'src/renderer/app.js:onPtyData:catch',message:'renderer onPtyData threw',data:{error:err instanceof Error?err.message:String(err),rendererPtyDataSeen},timestamp:Date.now()})}).catch(()=>{});
      // #endregion
    }
  });
  termihub.onPtyExit(() => {
    term.write('\r\n\x1b[33m[进程已结束]\x1b[0m\r\n');
  });
  if (typeof termihub.onPtyError === 'function') {
    termihub.onPtyError((msg) => {
      const m = msg ? String(msg) : '未知错误';
      term.writeln(`\r\n\x1b[31m[终端启动失败] ${m}\x1b[0m\r\n`);
      term.writeln('\x1b[33m请确认系统 PowerShell/cmd 可正常启动，并检查工作目录权限。\x1b[0m\r\n');
    });
  }
  if (typeof termihub.onPtyStall === 'function') {
    termihub.onPtyStall((msg) => {
      const m = msg ? String(msg) : '终端无输出';
      term.writeln(`\r\n\x1b[33m[终端无输出] ${m}\x1b[0m\r\n`);
    });
  }

  term.onData((data) => {
    termihub.ptyWrite(data);
  });

  afterLayoutStable(() => {
    const runInitialPty = () => {
      fitAddon.fit();
      const dims = fitAddon.proposeDimensions();
      if (dims) {
        termihub.ptyCreate(dims.cols, dims.rows, undefined);
      } else {
        termihub.ptyCreate(80, 24, undefined);
      }
      focusTerminal();
      nudgePtyGeometry();
    };
    /**
     * Windows 上首次 pty.spawn 可能数秒内同步占满主进程；推迟首连可在阻塞前响应点击与系统对话框。
     */
    setTimeout(runInitialPty, 160);
  });

  window.addEventListener('resize', () => {
    fitAddon.fit();
    const d = fitAddon.proposeDimensions();
    if (d) termihub.ptyResize(d.cols, d.rows);
  });

  /** @type {number | null} */
  let resizeRoRaf = null;
  const ro = new ResizeObserver(() => {
    if (resizeRoRaf != null) cancelAnimationFrame(resizeRoRaf);
    resizeRoRaf = requestAnimationFrame(() => {
      resizeRoRaf = null;
      if (!fitAddon || !term) return;
      fitAddon.fit();
      const d = fitAddon.proposeDimensions();
      if (d) termihub.ptyResize(d.cols, d.rows);
    });
  });
  ro.observe(container);
}

function renderTerminalList() {
  const wrap = document.getElementById('tm-terminal-list');
  if (!wrap) return;
  wrap.innerHTML = '';
  if (!rootPath) {
    const hint = document.createElement('div');
    hint.className = 'empty-hint';
    hint.textContent = '请先通过顶栏「打开文件夹」选择工作目录';
    wrap.appendChild(hint);
    return;
  }
  if (!terminals.length) {
    const hint = document.createElement('div');
    hint.className = 'empty-hint';
    hint.textContent = '暂无终端，点击右侧 + 按钮新建';
    wrap.appendChild(hint);
    return;
  }
  for (const t of terminals) {
    const row = document.createElement('div');
    row.className = 'tm-terminal-item';
    if (t.id === activeTerminalId) {
      row.classList.add('tm-terminal-item--active');
    }
    const ico = document.createElement('span');
    ico.className = 'codicon codicon-terminal tm-terminal-ico';
    const nameEl = document.createElement('div');
    nameEl.className = 'tm-terminal-name';
    nameEl.textContent = t.name;
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'tm-terminal-close codicon codicon-close';
    closeBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      terminals = terminals.filter((x) => x.id !== t.id);
      if (activeTerminalId === t.id) {
        activeTerminalId = terminals.length ? terminals[0].id : null;
        if (activeTerminalId) {
          restartShell();
        } else {
          term?.clear();
          setTmStatus('当前无活动终端', false);
        }
      }
      renderTerminalList();
    });
    row.addEventListener('click', () => {
      if (activeTerminalId === t.id) return;
      activeTerminalId = t.id;
      restartShell();
      renderTerminalList();
    });
    row.appendChild(ico);
    row.appendChild(nameEl);
    row.appendChild(closeBtn);
    wrap.appendChild(row);
  }
}

function initSplitter() {
  const splitter = document.getElementById('splitter');
  const sidebar = document.getElementById('sidebar');
  let dragging = false;

  splitter.addEventListener('mousedown', (e) => {
    dragging = true;
    splitter.classList.add('dragging');
    e.preventDefault();
  });

  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const layout = document.querySelector('.layout');
    const rect = layout.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const pct = (x / rect.width) * 100;
    const clamped = Math.min(60, Math.max(18, pct));
    sidebar.style.flex = `0 0 ${clamped}%`;
  });

  window.addEventListener('mouseup', () => {
    if (dragging) {
      dragging = false;
      splitter.classList.remove('dragging');
      window.dispatchEvent(new Event('resize'));
    }
  });
}

function initSplitterV() {
  const splitter = document.getElementById('splitter-v');
  const bottom = document.getElementById('sidebar-bottom');
  const left = document.getElementById('zone-commands');
  const right = document.getElementById('zone-terminal');
  if (!splitter || !bottom || !left || !right) return;

  let dragging = false;

  splitter.addEventListener('mousedown', (e) => {
    dragging = true;
    splitter.classList.add('dragging');
    e.preventDefault();
  });

  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const rect = bottom.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const pct = (x / rect.width) * 100;
    const clamped = Math.min(72, Math.max(28, pct));
    left.style.flex = `1 1 ${clamped}%`;
    right.style.flex = `1 1 ${100 - clamped}%`;
  });

  window.addEventListener('mouseup', () => {
    if (dragging) {
      dragging = false;
      splitter.classList.remove('dragging');
      window.dispatchEvent(new Event('resize'));
    }
  });
}

function initQuickCommandsPanel() {
  document.getElementById('quick-cmd-add')?.addEventListener('click', addQuickCommand);
  document.getElementById('quick-cmd-input')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      addQuickCommand();
    }
  });
  if (typeof termihub.onPackageScriptsChanged === 'function') {
    termihub.onPackageScriptsChanged(() => {
      if (rootPath) refreshPackageScripts();
    });
  }
  renderQuickCommands();
}

function initTerminalManagePanel() {
  document.getElementById('tm-clear')?.addEventListener('click', () => {
    term?.clear();
  });
  document.getElementById('tm-restart')?.addEventListener('click', () => {
    ensureTerminalEntryForRestart();
    restartShell();
  });
  document.getElementById('tm-install')?.addEventListener('click', () => {
    if (!rootPath) {
      setTmStatus('请先通过顶栏「打开文件夹」选择工作目录', true);
      return;
    }
    const cmd = getInstallDepsCommand();
    sendCmdToPty(cmd);
    setTmStatus(`已执行：${cmd}`, false);
  });
  document.getElementById('tm-clean-deps')?.addEventListener('click', async () => {
    if (!rootPath) {
      setTmStatus('请先通过顶栏「打开文件夹」选择工作目录', true);
      return;
    }
    const ok = window.confirm('确认删除当前项目的 node_modules 吗？此操作不可撤销。');
    if (!ok) return;
    setTmStatus('正在清理依赖（删除 node_modules）…', false);
    try {
      if (typeof termihub.clearDependencies !== 'function') {
        setTmStatus('当前版本不支持清理依赖', true);
        return;
      }
      const res = await termihub.clearDependencies(rootPath);
      if (!res?.ok) {
        setTmStatus(res?.error || '清理依赖失败', true);
        return;
      }
      if (res.removed) {
        setTmStatus('已清理依赖：node_modules 已删除', false);
      } else {
        setTmStatus('未找到 node_modules，无需清理', false);
      }
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      setTmStatus(`清理依赖失败：${msg}`, true);
    }
  });
  document.getElementById('tm-open-cwd')?.addEventListener('click', async () => {
    if (!rootPath) {
      setTmStatus('请先通过顶栏「打开文件夹」选择工作目录', true);
      return;
    }
    const r = await termihub.openPathInOS(rootPath);
    if (!r.ok) setTmStatus(r.error || '无法打开目录', true);
    else updateTmStatusCwd();
  });
  updateTmStatusCwd();

  const newBtn = document.getElementById('tm-new-terminal');
  if (newBtn) {
    newBtn.addEventListener('click', () => {
      if (!rootPath) {
        setTmStatus('请先通过顶栏「打开文件夹」选择工作目录', true);
        return;
      }
      const id = String(Date.now());
      const n = terminals.length + 1;
      const name = n === 1 ? 'PowerShell' : `PowerShell ${n}`;
      terminals.push({ id, name });
      activeTerminalId = id;
      restartShell();
      renderTerminalList();
    });
  }

  renderTerminalList();
}

function syncMaximizeIcon(maximized) {
  const icon = document.getElementById('icon-win-max');
  if (!icon) return;
  icon.classList.toggle('codicon-chrome-maximize', !maximized);
  icon.classList.toggle('codicon-chrome-restore', maximized);
}

function initWindowControls() {
  document.getElementById('btn-win-min')?.addEventListener('click', () => {
    termihub.windowMinimize();
  });
  document.getElementById('btn-win-max')?.addEventListener('click', () => {
    termihub.windowMaximize();
  });
  document.getElementById('btn-win-close')?.addEventListener('click', () => {
    termihub.windowClose();
  });
  termihub.onWindowState((state) => {
    if (state && typeof state.maximized === 'boolean') {
      syncMaximizeIcon(state.maximized);
    }
  });
}

document.getElementById('btn-open-folder').addEventListener('click', openFolder);

initWindowControls();
initTerminal();
initSplitter();
initSplitterV();
initQuickCommandsPanel();
initTerminalManagePanel();
initFolderDragOpen();
initAppOpenFolderPath();
