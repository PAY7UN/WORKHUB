'use strict';
/**
 * 上传之后再核对一遍：Release 上到底挂了哪些资产。
 *
 * 用法：node scripts/ci/verify-release-assets.mjs <tag>
 *
 * 为什么要上传完还要再查一遍：
 * 上传那一步是「按通配符匹配文件」，匹配不上就当没这回事——
 * 流水线照样绿，可发出去的东西少了一个。
 * v0.3.0 就这么少挂了托盘的 .sha256（自动更新要用的校验值），
 * 打包、校验都通过了，只有把 Release 上真正的资产清单拉下来对一遍才发现。
 *
 * 所以这里不信流水线自己的结论，直接问 GitHub：这份 Release 上该有的文件都在吗？
 *
 * 需要 GITHUB_TOKEN（或 GH_TOKEN）；没令牌就跳过——本地跑没令牌是正常的。
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function readVersion() {
  return JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
}

/** 这一版该有的资产（与 check-release-assets.mjs 保持一致） */
function expectedAssets(version) {
  return [
    `workhub-server-${version}.zip`,
    `workhub-server-${version}.zip.sha256`,
    `workhub-tray-${version}.zip`,
    `workhub-tray-${version}.zip.sha256`,
    `WorkHub-Setup-${version}.exe`,
  ];
}

/** 把失败写进 GitHub 注解：注解在 API 里公开可读 */
function annotate(title, message) {
  const encoded = String(message)
    .replaceAll('%', '%25')
    .replaceAll('\r', '%0D')
    .replaceAll('\n', '%0A')
    .slice(0, 60_000);
  console.log(`::error title=${title}::${encoded}`);
}

async function main() {
  const tag = process.argv[2] ?? process.env.GITHUB_REF_NAME ?? '';
  const repo = process.env.GITHUB_REPOSITORY ?? '';
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? '';

  if (!tag || !repo) {
    console.log('没有 tag 或仓库信息，跳过核对。');
    return;
  }
  if (!token) {
    console.log('没有 GITHUB_TOKEN，跳过核对（本地跑没有令牌是正常的）。');
    return;
  }

  const url = `https://api.github.com/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`;
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'workhub-release-check',
    },
  });
  if (!response.ok) {
    annotate(
      '核对 Release 资产失败',
      `读 ${url} 失败：HTTP ${response.status} ${response.statusText}`,
    );
    process.exit(1);
  }

  const release = await response.json();
  const actual = (release.assets ?? []).map((asset) => asset.name);
  console.log(`Release ${tag} 上有 ${actual.length} 个资产：`);
  for (const name of actual) console.log(`  - ${name}`);

  const missing = expectedAssets(readVersion()).filter((name) => !actual.includes(name));
  if (missing.length > 0) {
    annotate(
      'Release 资产不完整',
      `Release ${tag} 上少了 ${missing.length} 项：\n${missing.join('\n')}\n` +
        '这些是自动更新的原料，缺一个使用者就更新不了。',
    );
    console.error('\nRelease 上的东西不全：这次发版不算完成。');
    process.exit(1);
  }

  console.log('\nRelease 上的资产齐全。');
}

await main();
