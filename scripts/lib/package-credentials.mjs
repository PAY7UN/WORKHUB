// 发布包里绝不能出现的写死凭据。
//
// 为什么单独查这一条：包里带一把公开的默认密钥，等于把两件事公开给任何拿到包的人——
// 「谁能当管理员」（JWT 签名用同一把密钥）与「谁能解密库里的模型密钥」（主密钥由它派生）。
// 这类东西一旦进了包，再想撤就得重新发版；而且没人会注意到包里的常量，
// 所以只能在打包时查掉。
//
// 服务端现在不再有任何默认凭据：密钥要么显式配置，要么本地自动生成一把并落盘，
// 管理员密码要么显式配置，要么首次建库时随机生成并打印一次。
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 曾经的公开默认值：拿到发布包的人就能用它们。
 *
 * 这里刻意按片段拼，不写成完整字面量：
 * 扫描器自己也要进发布包，完整写出来等于把那两串明文又塞回包里——
 * 别人的审计工具会一直报它，而它其实只是一张黑名单。
 * 注释里说清楚来历，程序里不出现完整字符串。
 */
export const FORBIDDEN_CREDENTIALS = [
  ['workhub', 'dev-secret', 'change-me'].join('-'),
  ['admin', '123'].join(''),
];

/** 只看这些扩展名（其余是二进制，读出来也没有意义） */
const TEXT_FILE_RE = /\.(ts|mts|cts|js|mjs|cjs|json|md|txt|example|yml|yaml|html|css)$/i;

/** 同一个口径的正则源码：给外部工具（PowerShell 扫 zip）用 */
export const TEXT_FILE_PATTERN = TEXT_FILE_RE.source;

/** 递归时跳过的目录：第三方代码里的字符串不代表我们的包带了一把钥匙 */
const SKIP_DIRS = new Set(['node_modules', 'runtime', '.git', '.vite', 'coverage']);

/**
 * 这个路径算不算文本文件。
 * @param {string} path
 */
export function isTextFile(path) {
  return TEXT_FILE_RE.test(path);
}

/**
 * 在一批文本里找写死的凭据。
 *
 * @param {{path: string, text: string}[]} files
 * @returns {{path: string, needle: string}[]}
 */
export function findHardcodedCredentials(files) {
  const hits = [];
  for (const file of files) {
    for (const needle of FORBIDDEN_CREDENTIALS) {
      if (file.text.includes(needle)) hits.push({ path: file.path, needle });
    }
  }
  return hits;
}

/**
 * 查 .env.example：密钥与密码两行必须留空。
 *
 * 带值的样例会被直接复制到使用者的 .env 里——那等于把凭据发给
 * 所有下载模板的人。空值才是「让人自己填」的意思。
 *
 * @param {string} text .env.example 的内容
 * @returns {{key: string, value: string}[]}
 */
export function findFilledCredentialsInEnvExample(text) {
  const hits = [];
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(WORKHUB_SECRET|WORKHUB_ADMIN_PASSWORD)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const value = match[2].trim().replace(/^(['"])([\s\S]*)\1$/, '$2');
    if (value) hits.push({ key: match[1], value });
  }
  return hits;
}

/**
 * 递归收集目录下的文本文件内容。
 *
 * @param {string} root 目录
 * @returns {{path: string, text: string}[]} path 是相对 root 的路径（斜杠分隔）
 */
export function collectTextFiles(root) {
  const out = [];
  const walk = (dir, rel) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        walk(join(dir, entry.name), rel ? `${rel}/${entry.name}` : entry.name);
        continue;
      }
      if (!entry.isFile()) continue;
      const path = rel ? `${rel}/${entry.name}` : entry.name;
      if (!isTextFile(path)) continue;
      try {
        out.push({ path, text: readFileSync(join(dir, entry.name), 'utf8') });
      } catch {
        // 读不了就当没有：扫描是补充检查，不该自己先把打包卡住
      }
    }
  };
  walk(root, '');
  return out;
}

/**
 * 打包前的最后一道闸：包里不能带写死的凭据。
 *
 * 命中最常见的是「配置文件里写了默认口令」——那种样例会被使用者直接复制走，
 * 等于把凭据发给每一个下载模板的人。
 *
 * @param {string} root 待打包的目录
 */
export function assertNoHardcodedCredentials(root) {
  const files = collectTextFiles(root);
  const hits = findHardcodedCredentials(files);
  const envExample = files.find((file) => file.path === '.env.example');
  const filled = findFilledCredentialsInEnvExample(envExample?.text ?? '');

  if (hits.length === 0 && filled.length === 0) return;

  console.error('✗ 发布包里出现了写死的凭据，这个包不能发：');
  for (const hit of hits) console.error(`  · ${hit.path} 里写着 ${hit.needle}`);
  for (const hit of filled) console.error(`  · .env.example 里 ${hit.key}=${hit.value}（样例必须留空）`);
  console.error('拿到包的人就能自签管理员令牌、能解密库里的模型密钥——这正是要防的事。');
  process.exit(1);
}
