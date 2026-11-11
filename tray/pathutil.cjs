'use strict';
/**
 * 路径语义的小工具：让「同一个目录」的判断在任何系统上都对。
 *
 * 托盘是 Windows 应用，路径是 Windows 形态（盘符 + 反斜杠）。
 * 但这组单测在 Linux 上也跑（CI 的 check job 跑在 ubuntu 上），那边是 POSIX 形态。
 * 一律用宿主的 path 解析，两边都会错：
 * - POSIX 上 path.resolve('D:\\WorkHub') 把它当成相对路径，拼到 cwd 后面；
 * - win32.resolve('/tmp/xxx') 又会变成 'C:\tmp\xxx'，和真实位置对不上。
 *
 * 所以按路径的形态选解析规则：带盘符或反斜杠的按 Windows 规则，其余按宿主规则。
 */
const path = require('node:path');

/**
 * 这条路径是不是 Windows 形态。
 *
 * @param {string} value
 * @returns {boolean}
 */
function isWindowsStyle(value) {
  const text = String(value ?? '');
  return /^[a-zA-Z]:[\\/]/.test(text) || text.includes('\\');
}

/**
 * 按形态选 path 实现。
 *
 * @param {string} value
 * @returns {typeof path}
 */
function apiFor(value) {
  return isWindowsStyle(value) ? path.win32 : path;
}

/**
 * 归一化成「拿来比较」的样子。
 *
 * Windows 上大小写不敏感（D:\Data 与 d:\data 是同一个地方），
 * POSIX 上大小写敏感，折起来就变成两个不同的目录了。
 *
 * @param {string} value
 * @returns {{ resolved: string, sep: string }}
 */
function normalizeForCompare(value) {
  const api = apiFor(value);
  let resolved = api.resolve(String(value ?? '')).replace(/[\\/]+$/, '');
  if (isWindowsStyle(value)) resolved = resolved.toLowerCase();
  return { resolved, sep: api.sep };
}

/**
 * 两个目录是不是同一个。
 *
 * 判重必须按解析后的绝对路径比：同一个目录写成 `D:\WorkHub` 与 `D:\WorkHub\.`
 * 是同一个，写成 `D:\workhub` 与 `D:\WorkHub` 在 Windows 上也是同一个。
 * 不判重就可能「把目录搬进它自己」——递归复制自己会把自己撑爆。
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function isSameDir(a, b) {
  if (!a || !b) return false;
  return normalizeForCompare(a).resolved === normalizeForCompare(b).resolved;
}

/**
 * 目录是不是另一个目录的子目录（含它自己）。
 *
 * @param {string} child
 * @param {string} parent
 * @returns {boolean}
 */
function isInsideDir(child, parent) {
  if (!child || !parent) return false;
  const c = normalizeForCompare(child);
  const p = normalizeForCompare(parent);
  if (c.resolved === p.resolved) return true;
  return c.resolved.startsWith(p.resolved + p.sep);
}

module.exports = {
  apiFor,
  isInsideDir,
  isSameDir,
  isWindowsStyle,
  normalizeForCompare,
};
