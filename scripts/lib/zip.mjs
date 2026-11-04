// 打包用的两件小工具：把目录打成 zip、给 zip 算校验值。
//
// 为什么单独放一个 lib：服务端升级包和托盘免安装包都要「打 zip + 写 sha256」，
// 两边各写一份的话，改一次压缩方式要记得改两处——这种「记得」迟早会忘。
//
// 产物名（workhub-server-<版本>.zip / workhub-tray-<版本>.zip）是自动升级的约定：
// 更新器按这个名字找包，名字对不上就等于没发，而且使用者那边看不出任何异常。
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** 跑一个外部命令，失败就抛错（带上 stderr） */
export function run(command, args, options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], ...options });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', (err) => rejectPromise(new Error(`${command} 启动失败：${err.message}`)));
    child.on('close', (code) => {
      if (code === 0) resolvePromise(stdout);
      else rejectPromise(new Error(`${command} 退出码 ${code}：${stderr.trim() || stdout.trim()}`));
    });
  });
}

/**
 * 把目录打成 zip。
 *
 * Windows 用 PowerShell 自带的 Compress-Archive，其它系统用 zip。
 * zip 里的结构是「目录里的顶层项」——不是「目录本身」：
 * 解压出来直接就是内容，不用再点进一层文件夹。
 */
export async function zipDirectory(stagingDir, zipPath) {
  if (process.platform === 'win32') {
    // 直接点名每个顶层项，不用通配符。
    // readdirSync 本来就把清单文件列出来了——再单独加一遍，
    // Compress-Archive 会因为「重复路径」整个失败。
    const items = readdirSync(stagingDir).map((name) => join(stagingDir, name));
    await run('powershell', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Compress-Archive -Path ${items.map((p) => `'${p}'`).join(',')} -DestinationPath '${zipPath}' -Force`,
    ]);
    return;
  }
  await run('zip', ['-q', '-r', zipPath, '.'], { cwd: stagingDir });
}

/**
 * 给 zip 写一份 .sha256。
 *
 * 更新器下载完要核对：传坏了、传了一半的文件不能直接用。
 * 格式是「<哈希>  <文件名>」，跟 sha256sum 的输出一样。
 */
export function writeSha256(zipPath, fileName) {
  const hash = createHash('sha256');
  hash.update(readFileSync(zipPath));
  const sha256 = hash.digest('hex');
  writeFileSync(`${zipPath}.sha256`, `${sha256}  ${fileName}\n`, 'utf8');
  return sha256;
}
