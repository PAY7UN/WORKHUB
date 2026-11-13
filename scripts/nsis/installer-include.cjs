'use strict';
/**
 * 把自定义安装器脚本放进 electron-builder 的 buildResources 目录。
 *
 * 为什么不是直接在 electron-builder.yml 里写 `include: scripts/nsis/installer.nsh`？
 * 因为 NSIS 3.0 的 !include 不认 -INPUTCHARSET：被包含的文件里有非 ASCII 字符
 * （中文文案）时，文件开头必须带 UTF-8 BOM，否则编译直接报
 * 「Bad text encoding: installer.nsh:2」。
 *
 * 仓库里的源文件不带 BOM（diff 干净、编辑器不添乱），BOM 在这里补。
 * 顺便把脚本复制进 buildResources，也是 electron-builder 官方推荐的自定义方式：
 * nsis.include 默认值就是 build/installer.nsh。
 */
const { readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

/** 放进 buildResources 后的文件名（electron-builder 通过 nsis.include 引用） */
const INCLUDE_NAME = 'installer.nsh';

/**
 * @param {string} source 源脚本路径（scripts/nsis/installer.nsh）
 * @param {string} targetDir 目标目录（buildResources）
 * @returns {string} 写出的文件完整路径
 */
function stageInstallerInclude(source, targetDir) {
  const text = readFileSync(source, 'utf8');
  const target = join(targetDir, INCLUDE_NAME);
  writeFileSync(target, `\uFEFF${text.replace(/^\uFEFF/, '')}`, 'utf8');
  return target;
}

module.exports = { INCLUDE_NAME, stageInstallerInclude };
