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
import { basename, dirname } from 'node:path';

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
 * Windows 用系统自带的 tar（bsdtar），其它系统用 zip。
 *
 * 传了 baseName，zip 里就会有一层以它命名的顶层目录：
 * 解压出来是「一个文件夹」，而不是一堆文件摊在解压目录的根部。
 *
 * 为什么非要这一层：
 * 解压工具默认把包里的东西直接倒进当前目录。摊开的话，使用者面对的是
 * 十几个不知道是什么的目录（server、shared、dist、node_modules、runtime…），
 * 装到一半才发现认错了目录也说不清；升级时新旧两版混在一起更麻烦。
 * 收进一个文件夹之后，解压出来就是一个「WorkHub」，双击里面的东西就能用。
 *
 * baseName 必须等于目录自身的名字——条目名的顶层就是它，名字对不上就早点
 * 报错，别等打完包才发现结构不对。
 *
 * 为什么不用 PowerShell 的 Compress-Archive：
 * 它写在 Windows 上会把条目名里的分隔符写成反斜杠（workhub\server\index.js）。
 * zip 规范要求用正斜杠，Linux 上的 unzip 会把反斜杠当成文件名的一部分，
 * 解出来是一堆叫「workhub\server\index.js」的文件——服务器部署直接坏掉，
 * 而且这种包在 Windows 上看着完全正常，只有到了目标机器上才暴露。
 */
export async function zipDirectory(stagingDir, zipPath, options = {}) {
  const baseName = options.baseName ?? '';
  if (baseName && basename(stagingDir) !== baseName) {
    throw new Error(
      `压缩包顶层目录名对不上：目录叫 ${basename(stagingDir)}，要的是 ${baseName}`,
    );
  }
  if (process.platform === 'win32') {
    // Windows 10 自带 tar（bsdtar），-a 让它按扩展名选 zip 格式
    if (baseName) {
      // 在父目录里打包这个目录：条目名的顶层就是它
      await run('tar', ['-a', '-cf', zipPath, '-C', dirname(stagingDir), baseName]);
      return;
    }
    // 点名每个顶层项（不用 '.'，那样条目名会带一层 './'）
    const items = readdirSync(stagingDir);
    await run('tar', ['-a', '-cf', zipPath, '-C', stagingDir, '--', ...items]);
    return;
  }
  if (baseName) {
    // 在父目录里打包这个目录：条目名就带上了它
    await run('zip', ['-q', '-r', zipPath, baseName], { cwd: dirname(stagingDir) });
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
