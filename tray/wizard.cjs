'use strict';
/**
 * 首次运行向导：服务起来之前，先问清楚「数据放哪儿」「要不要开机自启动」。
 *
 * 为什么要有这一步：
 * - 数据目录默认落在 %LOCALAPPDATA%，但很多人会把数据放在另一块盘上；
 *   装完再改，得先去托盘菜单里翻「更改数据目录」——那时候服务已经在跑了，
 *   库里已经有一堆初始数据，再搬就是另一件事了。
 * - 开机自启动是「要不要」的问题，安装的时候没人问过，默认永远是不开，
 *   于是每个人都自己去任务管理器里加一遍。
 *
 * 向导只问一次（托盘配置里记着「问过了」），之后托盘菜单里随时能改。
 */
const path = require('node:path');
const { BrowserWindow, dialog, ipcMain } = require('electron');
const { checkDataDir, normalizeSetupChoice } = require('./setup.cjs');

const HTML_FILE = path.join(__dirname, 'wizard.html');
const PRELOAD_FILE = path.join(__dirname, 'wizard-preload.cjs');

/** 同时只允许一个向导窗口 */
let activeWindow = null;

/**
 * 打开向导，等用户选完。
 *
 * @param {object} options
 * @param {string} options.defaultDataDir 建议的数据目录（默认那个）
 * @param {string} options.exeDir 程序目录（用来挡「数据放在程序目录里」）
 * @param {boolean} options.autoStart 当前的开机自启动状态
 * @returns {Promise<{dataDir: string, autoStart: boolean}|null>} null 表示用户关了窗口
 */
function showSetupWizard(options = {}) {
  const { defaultDataDir = '', exeDir = '', autoStart = false } = options;

  if (activeWindow && !activeWindow.isDestroyed()) {
    activeWindow.focus();
    return Promise.resolve(null);
  }

  return new Promise((resolve) => {
    let settled = false;

    const window = new BrowserWindow({
      width: 560,
      height: 452,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      title: 'WorkHub 首次使用',
      autoHideMenuBar: true,
      webPreferences: {
        preload: PRELOAD_FILE,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    activeWindow = window;

    /** 收尾：解掉 Promise，摘掉 IPC，关闭窗口 */
    const finish = (result) => {
      if (settled) return;
      settled = true;
      ipcMain.removeHandler('wizard:init');
      ipcMain.removeHandler('wizard:choose-dir');
      ipcMain.removeHandler('wizard:submit');
      ipcMain.removeHandler('wizard:cancel');
      if (activeWindow === window) activeWindow = null;
      if (!window.isDestroyed()) window.destroy();
      resolve(result);
    };

    ipcMain.handle('wizard:init', () => ({ dataDir: defaultDataDir, autoStart }));

    ipcMain.handle('wizard:choose-dir', async (_event, current) => {
      const result = await dialog.showOpenDialog(window, {
        title: '选择数据存放位置',
        defaultPath: current || defaultDataDir || undefined,
        buttonLabel: '选择这个位置',
        properties: ['openDirectory', 'createDirectory'],
      });
      if (result.canceled || result.filePaths.length === 0) return null;
      return result.filePaths[0];
    });

    ipcMain.handle('wizard:submit', (_event, choice) => {
      if (choice?.useDefault) {
        finish({ dataDir: defaultDataDir, autoStart: Boolean(choice.autoStart) });
        return { ok: true };
      }

      const normalized = normalizeSetupChoice(choice);
      const check = checkDataDir(normalized.dataDir, { exeDir });
      if (!check.ok) return { ok: false, reason: check.reason };

      finish({ dataDir: normalized.dataDir, autoStart: normalized.autoStart });
      return { ok: true };
    });

    ipcMain.handle('wizard:cancel', () => {
      finish(null);
      return { ok: true };
    });

    window.on('closed', () => finish(null));

    window.loadFile(HTML_FILE).catch((err) => {
      // 界面都打不开就别拖着了：按「取消」处理，让程序用默认配置继续
      console.error('[tray] 向导窗口加载失败：', err?.message ?? err);
      finish(null);
    });
  });
}

module.exports = { showSetupWizard };
