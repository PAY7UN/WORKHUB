'use strict';
/**
 * 安装选项：数据目录 + 开机自启动。
 *
 * 这两件事以前只有「托盘菜单里改数据目录」这一条路，
 * 而且要先把程序跑起来才能改——装机的人第一眼看到的是「服务已经在跑了」，
 * 想把数据放到别的盘上，得先知道托盘图标在哪儿。
 * 现在多了一条更靠前的路：首次运行向导（tray/wizard.cjs）在服务起来之前就问。
 *
 * 这里的函数都刻意做成「不碰 Electron 的纯逻辑」+「薄薄一层 Electron 调用」两截：
 * 纯逻辑能被单测盯住（开机自启动这种事，错了没人会立刻发现——它要等下次开机才现形），
 * Electron 调用只负责把结果落到系统上。
 */
const path = require('node:path');
const fs = require('node:fs');
const { isInsideDir, isSameDir, apiFor } = require('./pathutil.cjs');

/**
 * 开机自启动能不能设。
 *
 * 开发态一律不设：那时的 exe 是 node_modules 里的 electron.exe，
 * 写进注册表等于在别人机器上留一个「一开机就跑 Electron」的鬼影。
 */
function isAutoStartSupported(app) {
  return Boolean(app?.isPackaged);
}

/**
 * 现在是不是开机自启动。
 *
 * 读的是系统里真实的状态（Electron 问的是注册表 Run 项），
 * 不是「我们上次让用户勾了什么」——两者可能对不上：
 * 用户自己去任务管理器里把它禁掉了，我们记着的那个「已开启」就是假的。
 */
function isAutoStartEnabled(app) {
  if (!isAutoStartSupported(app)) return false;
  try {
    return Boolean(app.getLoginItemSettings?.().openAtLogin);
  } catch {
    // 问不到就当没开：宁可让人再勾一次，也别给一个说不准的状态
    return false;
  }
}

/**
 * 设置开机自启动。
 *
 * 用 Electron 的登录项：Windows 上它写的就是
 * HKCU\Software\Microsoft\Windows\CurrentVersion\Run\<程序名>，
 * 自己拼注册表键名的话，程序改名就会留下一个指向旧路径的死项。
 */
function setAutoStart(app, enabled) {
  if (!isAutoStartSupported(app)) {
    return { ok: false, enabled: false, reason: '开发态不设置开机自启动' };
  }
  try {
    app.setLoginItemSettings({
      openAtLogin: Boolean(enabled),
      path: process.execPath,
    });
    return { ok: true, enabled: Boolean(enabled) };
  } catch (err) {
    return { ok: false, enabled: false, reason: err?.message ?? String(err) };
  }
}

/**
 * 检查一个数据目录能不能用。
 *
 * 拦的是三类会让使用者后悔的选择：
 *
 * 1. **程序目录本身或它的子目录**。托盘自更新是整块替换程序目录的
 *    （见 tray/apply-update.cjs：备份 → 覆盖 → 清理旧文件），
 *    数据放在那儿，更新时会被一起带走——库没了，文档也就没了。
 * 2. **盘根目录**（D:\）。它不像「一个数据目录」，更像「随手一指」；
 *    往后清理临时文件时，一个手滑就是整个盘。
 * 3. **相对路径**。托盘的工作目录不固定，相对路径会落到意想不到的地方。
 *
 * 另外顺带看看能不能写：写不了的话 .env、数据库、日志都落不下去。
 *
 * @returns {{ok: boolean, reason: string}}
 */
function checkDataDir(dir, options = {}) {
  const { exeDir = '', probeWrite = true } = options;
  const value = String(dir ?? '').trim();
  if (!value) return { ok: false, reason: '还没选位置' };

  if (!path.isAbsolute(value)) {
    return { ok: false, reason: '要填完整的路径，不能是相对路径' };
  }

  const resolved = path.resolve(value);
  const root = path.parse(resolved).root;
  if (resolved === root) {
    return { ok: false, reason: '不能直接用盘根目录，选一个专门的文件夹' };
  }

  if (exeDir && isInsideDir(resolved, exeDir)) {
    return {
      ok: false,
      reason: '不能放在程序目录里——程序更新时会整块替换那里，数据会跟着没了',
    };
  }

  if (probeWrite) {
    try {
      fs.mkdirSync(resolved, { recursive: true });
      fs.accessSync(resolved, fs.constants.W_OK);
    } catch (err) {
      return { ok: false, reason: `这个位置写不进去：${err?.message ?? err}` };
    }
  }

  return { ok: true, reason: '' };
}

/**
 * 把向导/菜单收集到的选项整理成一份能存下来的结果。
 *
 * 目录会被规整成绝对路径（去掉尾部的斜杠），
 * 不然配置里会出现「D:\Data\」和「D:\Data」两种写法，
 * 下次比较的时候又得写一遍特判。
 */
function normalizeSetupChoice(choice = {}) {
  const dir = String(choice.dataDir ?? '').trim();
  if (!dir) return { dataDir: '', autoStart: Boolean(choice.autoStart) };
  const api = apiFor(dir);
  return {
    // 只规整写法，不折叠大小写：配置里存的是使用者填的原样路径，
    // 大小写折叠是「比较时」的事（见 normalizeForCompare）
    dataDir: api.resolve(dir).replace(/[\\/]+$/, ''),
    autoStart: Boolean(choice.autoStart),
  };
}

module.exports = {
  checkDataDir,
  isAutoStartEnabled,
  isAutoStartSupported,
  isSamePath: isSameDir,
  isInsideDir,
  normalizeSetupChoice,
  setAutoStart,
};
