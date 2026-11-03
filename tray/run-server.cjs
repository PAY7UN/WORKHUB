'use strict';
/**
 * 托盘拉起服务进程时用的包装脚本。
 *
 * 它只多干一件事：盯着父进程。
 *
 * 为什么需要：Windows 不会替父进程收拾孤儿。托盘被强杀（任务管理器里「结束任务」、
 * 断电前的强制结束）时，子进程会继续活着——服务还在跑、端口还占着，
 * 而使用者以为「托盘关了＝服务停了」。这个现象排查起来很费劲：
 * 界面没了，但 8789 端口还在监听。
 *
 * 这里轮询父进程 PID，发现父进程没了就主动退出，端口随之释放。
 * 判活用的是「信号 0」：它只检查进程还在不在，不会真的发信号
 * （libuv 在 Windows 上也支持这个用法，实测不存在时会抛 ESRCH）。
 */
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const parentPid = Number(process.env.WORKHUB_PARENT_PID || 0);

if (parentPid > 0) {
  setInterval(() => {
    try {
      process.kill(parentPid, 0);
    } catch {
      process.stdout.write('托盘已退出，服务随之退出\n');
      process.exit(0);
    }
  }, 3000).unref();
}

const entry = process.argv[2];
if (!entry) {
  process.stderr.write('用法: run-server.cjs <服务入口>\n');
  process.exit(2);
}

// 动态 import 而不是 require：服务入口是 .ts，靠 Node 的类型擦除加载
// （Electron 45 自带 Node 24，默认开启，不需要编译步骤）。
import(pathToFileURL(path.resolve(entry)).href).catch((err) => {
  process.stderr.write(`服务启动失败：${err?.stack || err}\n`);
  process.exit(1);
});
