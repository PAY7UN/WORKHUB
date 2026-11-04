// 自带 Node 运行时：把一份 node.exe 塞进发布包，目标机连 Node 都不用装。
//
// 为什么值得背这几十兆：
// 目标机最常见的卡点就是「先装 Node、再 npm install、再起服务」——
// 每一步都是别人机器上不可控的变量（版本、镜像、编译工具链、代理）。
// 把运行时和依赖一起打包过去，交付就只剩「解压 → 起服务」。
//
// 运行时怎么选：
// - 默认跟打包机当前的 Node 同版本，better-sqlite3 的原生二进制一定对得上；
// - 也可以用 WORKHUB_NODE_DIR 指向本机已有的 Node 目录（离线打包）；
// - 也可以用 WORKHUB_NODE_VERSION 指定别的版本。
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { envValue } from '../../server/env.ts';

/** 首选国内镜像，nodejs.org 兜底 */
const MIRRORS = [
  'https://npmmirror.com/mirrors/node',
  'https://nodejs.org/dist',
];

/** 运行时目录里的文件名（升级器/部署脚本都按这个名字找） */
export const NODE_EXE = 'node.exe';

function run(command, args, options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], ...options });
    let stderr = '';
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', (err) => rejectPromise(new Error(`${command} 启动失败：${err.message}`)));
    child.on('close', (code) => {
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(`${command} 退出码 ${code}：${stderr.trim()}`));
    });
  });
}

/** 下载文件到本地 */
async function download(url, dest) {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  const { writeFileSync } = await import('node:fs');
  writeFileSync(dest, buffer);
  return dest;
}

/** 解压 zip：优先用系统自带的 tar，Windows 10+ 都带；不行再喊 PowerShell */
async function unzip(zipPath, destDir) {
  mkdirSync(destDir, { recursive: true });
  try {
    await run('tar', ['-xf', zipPath, '-C', destDir]);
    return;
  } catch {
    // 继续走 PowerShell
  }
  await run('powershell', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    `Expand-Archive -Path '${zipPath}' -DestinationPath '${destDir}' -Force`,
  ]);
}

/**
 * 准备一份 node.exe 到 target 目录。
 *
 * @param {{target: string, version?: string, log?: (msg: string) => void, required?: boolean}} opts
 * @returns {Promise<string|null>} node.exe 的路径；拿不到时返回 null
 */
export async function ensureNodeRuntime({
  target,
  version = envValue('NODE_VERSION') || process.versions.node,
  log = () => {},
  required = false,
}) {
  mkdirSync(target, { recursive: true });
  const dest = join(target, NODE_EXE);
  if (existsSync(dest)) {
    log(`复用已有的自带运行时：${dest}`);
    return dest;
  }

  // 离线打包：直接用本机已装的 Node
  const localDir = envValue('NODE_DIR');
  if (localDir) {
    const source = join(localDir, NODE_EXE);
    if (!existsSync(source)) throw new Error(`WORKHUB_NODE_DIR 里没有 ${NODE_EXE}：${localDir}`);
    cpSync(source, dest);
    log(`已从 ${localDir} 复制自带运行时`);
    return dest;
  }

  const fileName = `node-v${version}-win-x64.zip`;
  const work = join(tmpdir(), `workhub-node-${version}`);
  const zipPath = join(work, fileName);
  const extractDir = join(work, 'extract');

  try {
    rmSync(work, { recursive: true, force: true });
    mkdirSync(work, { recursive: true });

    let lastError = null;
    for (const mirror of MIRRORS) {
      const url = `${mirror}/v${version}/${fileName}`;
      try {
        log(`下载 Node 运行时：${url}`);
        await download(url, zipPath);
        lastError = null;
        break;
      } catch (err) {
        lastError = err;
        log(`! 下载失败（${err.message}），换下一个源`);
      }
    }
    if (lastError) throw lastError;

    await unzip(zipPath, extractDir);

    // 解出来是 node-v<版本>-win-x64/ 这一层
    let sourceDir = extractDir;
    const entries = readdirSync(extractDir, { withFileTypes: true });
    const inner = entries.find((entry) => entry.isDirectory());
    if (inner) sourceDir = join(extractDir, inner.name);

    const sourceExe = join(sourceDir, NODE_EXE);
    if (!existsSync(sourceExe)) throw new Error(`解压后没找到 ${NODE_EXE}：${sourceDir}`);
    cpSync(sourceExe, dest);
    // node.dll 一并带上：官方包里有，缺了某些嵌入场景会出问题
    const dll = join(sourceDir, 'node.dll');
    if (existsSync(dll)) cpSync(dll, join(target, 'node.dll'));

    const sizeMb = (statSync(dest).size / 1024 / 1024).toFixed(1);
    log(`自带运行时就绪：${dest}（Node ${version}，${sizeMb} MB）`);
    return dest;
  } catch (err) {
    if (required) throw err;
    log(`! 没能准备自带运行时：${err.message}`);
    log('  目标机将需要自行安装 Node（打包时可用 WORKHUB_NODE_DIR 指向本机 Node 目录）');
    return null;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
