'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const installJs = path.join(root, 'node_modules', 'electron', 'install.js');

if (!fs.existsSync(installJs)) {
  console.warn('[TermiHub] electron 尚未就绪，跳过 ensure-electron');
  process.exit(0);
}

if (!process.env.ELECTRON_MIRROR) {
  process.env.ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/';
}

const r = spawnSync(process.execPath, [installJs], {
  stdio: 'inherit',
  env: process.env,
  cwd: root
});

process.exit(r.status === 0 ? 0 : r.status ?? 1);
