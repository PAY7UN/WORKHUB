'use strict';
/**
 * 打包完应用、开始做安装器之前跑一下。
 *
 * 存在的理由只有一个：安装器要用的东西得在它开工之前就位。
 * afterPack 正好卡在这个位置上——应用已经打好，安装器还没开始做。
 *
 * 干两件事：
 *   1. 现画三张品牌位图（顶部横幅、欢迎页/选项页侧栏、卸载器侧栏）
 *   2. 把自定义安装器脚本连同 UTF-8 BOM 复制进 buildResources
 *
 * 都写进 packager.buildResourcesDir：electron-builder 就是从这儿找
 * nsis.include / installerHeader / installerSidebar / uninstallerSidebar 的。
 */
const { join } = require('node:path');
const { prepareBrandAssets } = require('../nsis/brand-assets.cjs');
const { stageInstallerInclude } = require('../nsis/installer-include.cjs');

/** 自定义安装器脚本的位置（仓库里的源文件，干净版本不带 BOM） */
const INSTALLER_SCRIPT = join(__dirname, '..', 'nsis', 'installer.nsh');

/**
 * @param {{ packager: { buildResourcesDir: string } }} context electron-builder 打包上下文
 */
exports.afterPack = async (context) => {
  const dir = context.packager.buildResourcesDir;
  const bitmaps = prepareBrandAssets(dir);
  const include = stageInstallerInclude(INSTALLER_SCRIPT, dir);
  console.log(`  • 安装器资源已就位：${bitmaps.length} 张品牌位图 + ${include}`);
};
