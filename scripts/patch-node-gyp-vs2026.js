'use strict';

/**
 * @electron/node-gyp（随 @electron/rebuild 安装）在旧版本里不识别 Visual Studio 18.x，
 * 导致 electron-rebuild 无法编译 node-pty。此处为最小补丁：识别 VS2026 并加入工具集映射。
 * 若上游已支持，脚本会因检测到已有分支而跳过。
 */

const fs = require('fs');
const path = require('path');

function resolveFindVisualStudioPath(root) {
  const tries = [];
  try {
    tries.push(
      require.resolve('@electron/node-gyp/lib/find-visualstudio.js', { paths: [root] })
    );
  } catch {
    /* ignore */
  }
  try {
    const rebuildRoot = path.dirname(
      require.resolve('@electron/rebuild/package.json', { paths: [root] })
    );
    tries.push(
      path.join(rebuildRoot, 'node_modules', '@electron', 'node-gyp', 'lib', 'find-visualstudio.js')
    );
  } catch {
    /* ignore */
  }
  for (const p of tries) {
    if (p && fs.existsSync(p)) {
      return p;
    }
  }
  return null;
}

function main() {
  if (process.platform !== 'win32') {
    return;
  }

  const root = path.join(__dirname, '..');
  const target = resolveFindVisualStudioPath(root);
  if (!target) {
    console.warn('[patch-node-gyp-vs2026] 未找到 @electron/node-gyp，跳过');
    return;
  }

  let src = fs.readFileSync(target, 'utf8');
  if (src.includes('ret.versionMajor === 18')) {
    return;
  }

  let next = src;

  next = next.replace(
    /return this\.findVSFromSpecifiedLocation\(\[2019, 2022\]\)/g,
    'return this.findVSFromSpecifiedLocation([2019, 2022, 2026])'
  );
  next = next.replace(
    /return this\.findNewVSUsingSetupModule\(\[2019, 2022\]\)/g,
    'return this.findNewVSUsingSetupModule([2019, 2022, 2026])'
  );
  next = next.replace(
    /return this\.findNewVS\(\[2019, 2022\]\)/g,
    'return this.findNewVS([2019, 2022, 2026])'
  );

  const verNeedle = `    if (ret.versionMajor === 17) {
      ret.versionYear = 2022
      return ret
    }
    this.log.silly('- unsupported version:', ret.versionMajor)
    return {}`;
  const verInsert = `    if (ret.versionMajor === 17) {
      ret.versionYear = 2022
      return ret
    }
    if (ret.versionMajor === 18) {
      ret.versionYear = 2026
      return ret
    }
    this.log.silly('- unsupported version:', ret.versionMajor)
    return {}`;
  if (!next.includes(verNeedle)) {
    console.warn('[patch-node-gyp-vs2026] getVersionInfo 结构已变化，跳过（请检查 node-gyp 版本）');
    return;
  }
  next = next.replace(verNeedle, verInsert);

  const toolNeedle = `    } else if (versionYear === 2022) {
      return 'v143'
    }
    this.log.silly('- invalid versionYear:', versionYear)
    return null`;
  const toolInsert = `    } else if (versionYear === 2022) {
      return 'v143'
    } else if (versionYear === 2026) {
      return 'v145'
    }
    this.log.silly('- invalid versionYear:', versionYear)
    return null`;
  if (!next.includes(toolNeedle)) {
    console.warn('[patch-node-gyp-vs2026] getToolset 结构已变化，跳过');
    return;
  }
  next = next.replace(toolNeedle, toolInsert);

  fs.writeFileSync(target, next, 'utf8');
  console.log('[patch-node-gyp-vs2026] 已修补', target);
}

main();
