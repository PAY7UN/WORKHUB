'use strict';
/**
 * 安装器用的品牌位图。
 *
 * 图不作为二进制文件存进仓库，而是现场画出来（画法见 tray/icon.cjs）：
 * 改配色、改文案不用重开图，源码里改一行就行，diff 里也能看懂改了什么。
 *
 * 三张图各司其职：
 * - installerHeader.bmp    150×57   顶部横幅，所有页面都有
 * - installerSidebar.bmp   164×314  欢迎页 / 安装选项页左侧大图
 * - uninstallerSidebar.bmp 164×314  卸载器左侧大图
 *
 * 写进 electron-builder 的 buildResources 目录（由 afterPack 钩子调用），
 * electron-builder.yml 里用 installerHeader / installerSidebar / uninstallerSidebar 引用。
 */
const { mkdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { makeBrandBitmaps } = require('../../tray/icon.cjs');

/** 位图文件名 → makeBrandBitmaps() 返回值里的键 */
const ASSETS = [
  { file: 'installerHeader.bmp', key: 'header' },
  { file: 'installerSidebar.bmp', key: 'welcome' },
  // 卸载器也用欢迎页那张蓝底图：绿色对勾那张是「装完了」的意思，
  // 摆在卸载页上像是在说「卸载成功」，容易让人误会。
  { file: 'uninstallerSidebar.bmp', key: 'welcome' },
];

/**
 * 把三张位图写进目标目录（已存在的覆盖掉）。
 *
 * @param {string} dir 目标目录，一般是 buildResources
 * @returns {string[]} 写出的文件完整路径
 */
function prepareBrandAssets(dir) {
  if (!dir) throw new Error('prepareBrandAssets：目标目录不能为空');
  mkdirSync(dir, { recursive: true });
  const bitmaps = makeBrandBitmaps();
  const written = [];
  for (const { file, key } of ASSETS) {
    const target = join(dir, file);
    writeFileSync(target, bitmaps[key]);
    written.push(target);
  }
  return written;
}

module.exports = { ASSETS, prepareBrandAssets };
