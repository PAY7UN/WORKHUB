/**
 * 打包前重建前端产物。
 *
 * 为什么必须在这里重建，而不是靠「打包的人记得先跑 npm run build」：
 * dist/ 是**拷贝**进包的，不是现场构建的。只要漏跑一次，打出来的包里
 * 前端就是上一版的——包能打、校验和能算、升级能成功、所有检查都绿，
 * 唯独用户拿到的是旧页面。这种错没有任何机制能发现，只能靠流程纪律，
 * 而流程纪律一定会被打破。
 *
 * 怎么跑：直接用 node 执行 tsc 和 vite 的 JS 入口，不经过 npm。
 * - 不走 npm.cmd：Windows 上 .cmd 必须配 shell 才能 spawn，而带 shell
 *   的命令拼接有注入面；
 * - 不用 shell：参数是写死的常量，没有可注入的东西；
 * - 与 npm run build 完全等价（build 脚本就是 tsc -b && vite build），
 *   但不依赖 npm 在 PATH 里，也不受 .cmd 包装脚本的转发规则影响。
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** 跑一个子进程，失败就把 stderr 抛出来（而不是静默带过） */
function run(command, args, options) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { stdio: ['ignore', 'inherit', 'inherit'], ...options });
    child.on('error', (err) => rejectPromise(new Error(`${command} 启动失败：${err.message}`)));
    child.on('close', (code) => {
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(`${command} 退出码 ${code}`));
    });
  });
}

/**
 * 重建前端产物（dist/）。
 *
 * @param {object} options
 * @param {string} options.root 项目根目录
 * @param {boolean} [options.skip] 显式跳过（给已经构建过的流水线用）
 * @param {(msg: string) => void} [options.log] 进度输出
 * @returns {Promise<boolean>} 是否真的构建了
 */
export async function ensureFrontendBuilt({ root, skip = false, log = () => {} }) {
  if (skip) {
    log('  跳过前端构建（--skip-build）');
    return false;
  }

  const tsc = join(root, 'node_modules', 'typescript', 'bin', 'tsc');
  const vite = join(root, 'node_modules', 'vite', 'bin', 'vite.js');
  const hasTools = existsSync(tsc) && existsSync(vite);

  if (!hasTools) {
    // 部署目录：没有开发依赖，只有已经构建好的 dist/。
    // 这不是打升级包的地方（该在开发机或 CI 上打），但有人在部署机上
    // 手工打时不该直接崩掉——给他一条明确的路：按现有 dist/ 打，并说清楚
    // 前端没重建。想要最新的前端，去开发目录跑 npm run build。
    if (existsSync(join(root, 'dist', 'index.html'))) {
      log('  ! 这里没有构建工具（不是开发目录），按现有 dist/ 打包');
      log('    前端不会重新构建；要最新的前端请在开发目录执行 npm run build');
      return false;
    }
    throw new Error(
      `既没有构建工具（${tsc}），也没有现成的 dist/。先跑 npm install && npm run build`,
    );
  }

  log('  构建前端（tsc -b && vite build）…');
  // 类型检查也在这条链上：类型不过就不让出包，免得把跑不起来的包发出去
  await run(process.execPath, [tsc, '-b'], { cwd: root });
  await run(process.execPath, [vite, 'build'], { cwd: root });
  return true;
}
