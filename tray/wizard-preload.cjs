'use strict';
/**
 * 向导窗口的 preload。
 *
 * 窗口本身是普通网页（contextIsolation + sandbox），能碰的东西只有这里暴露的四个方法。
 * 目录选择交给主进程去做——网页里没有文件系统权限，
 * 而「选文件夹」用的是系统的原生气泡框，在主进程里调才有。
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('workhubSetup', {
  /** 取初值：默认数据目录、当前的开机自启动状态 */
  init: () => ipcRenderer.invoke('wizard:init'),
  /** 弹系统的文件夹选择框；用户取消则返回 null */
  chooseDir: (current) => ipcRenderer.invoke('wizard:choose-dir', current),
  /** 提交选择。useDefault=true 表示「先用默认的」 */
  submit: (choice) => ipcRenderer.invoke('wizard:submit', choice),
  /** 关闭窗口（当作取消） */
  cancel: () => ipcRenderer.invoke('wizard:cancel'),
});
