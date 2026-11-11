'use strict';
/**
 * 清点这一次要发出去的东西：一个都不能少。
 *
 * 用法：node scripts/ci/check-release-assets.mjs [版本]
 * 不给版本就按仓库 package.json 里的版本算。
 *
 * 为什么要有这个脚本：
 * 资产名是自动升级的约定（服务端认 workhub-server-<版本>.zip，
 * 托盘认 workhub-tray-<版本>.zip）——名字对不上等于没发，
 * 而且使用者那边看不出任何异常：界面只说「没有新版本」，因为压根没找到包。
 *
 * 更要命的是「少挂一个」这件事本身是静默的：
 * 上传那一步的通配符匹配不上就当没这回事，流水线照样绿，
 * 结果发出去的包缺了自动更新要用的 .sha256，
 * 要等到使用者点升级被拒绝时才暴露——那时候旧版本已经被换掉了。
 *
 * 所以在上传之前就把清单点一遍：缺了就当场失败，别等发出去。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
// 可以指到别的目录：单测要在临时目录里摆「缺件」的样子，
// 真实发布时用的还是仓库里的 release/。
const RELEASE = process.env.WORKHUB_RELEASE_DIR ?? join(ROOT, 'release');

function readVersion() {
  return JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
}

/**
 * 这一版该有的资产。
 *
 * 服务端与托盘各一对「包 + 校验值」：更新器下载完要核对，
 * 传坏了、传了一半的包不能拿去升级。
 */
function expectedAssets(version) {
  return [
    { name: `workhub-server-${version}.zip`, why: '服务端升级包（自动升级的原料）' },
    { name: `workhub-server-${version}.zip.sha256`, why: '服务端升级包的校验值' },
    { name: `workhub-tray-${version}.zip`, why: '托盘免安装包（托盘自更新的原料）' },
    { name: `workhub-tray-${version}.zip.sha256`, why: '托盘免安装包的校验值' },
    { name: `WorkHub-Setup-${version}.exe`, why: '托盘安装程序' },
  ];
}

/** 把失败写进 GitHub 注解：注解在 API 里公开可读，不用翻几百 MB 的日志 */
function annotate(title, message) {
  const encoded = String(message)
    .replaceAll('%', '%25')
    .replaceAll('\r', '%0D')
    .replaceAll('\n', '%0A')
    .slice(0, 60_000);
  console.log(`::error title=${title}::${encoded}`);
}

function main() {
  const version = process.argv[2] ?? readVersion();
  console.log(`清点发布资产：版本 ${version}`);

  if (!existsSync(RELEASE)) {
    annotate('发布资产缺失', `找不到目录：${RELEASE}`);
    process.exit(1);
  }

  const present = readdirSync(RELEASE).sort();
  console.log(`release/ 里现有 ${present.length} 个文件：`);
  for (const name of present) {
    const size = statSync(join(RELEASE, name)).size;
    console.log(`  - ${name}（${(size / 1024 / 1024).toFixed(1)} MB）`);
  }

  const missing = [];
  for (const asset of expectedAssets(version)) {
    const path = join(RELEASE, asset.name);
    if (!existsSync(path)) {
      missing.push(`${asset.name}（${asset.why}）`);
      console.error(`✗ 少了 ${asset.name} —— ${asset.why}`);
      continue;
    }
    const size = statSync(path).size;
    if (size === 0) {
      missing.push(`${asset.name}（${asset.why}）—— 文件是空的`);
      console.error(`✗ ${asset.name} 是空文件`);
      continue;
    }
    console.log(`✓ 有 ${asset.name}（${asset.why}）`);
  }

  if (missing.length > 0) {
    annotate(
      '发布资产不完整',
      `版本 ${version} 的发布包里少了 ${missing.length} 项：\n${missing.join('\n')}\n` +
        '这些文件是自动更新的原料，缺了就不能发。',
    );
    console.error('\n资产不全：别发。');
    process.exit(1);
  }

  console.log('\n资产齐全：可以发。');
}

main();
