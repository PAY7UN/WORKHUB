#!/usr/bin/env node
/**
 * workhub 文档库工具：查看 / 导出仓库里的文档。
 *
 * v2 之后正文不在库里，而在仓库目录里（data/vault/<仓库 slug>/docs/…），
 * 库里只有索引（路径、哈希、大小）。所以这个工具现在是「把仓库目录整理成
 * 一份可发布的文档树」——顺带把 front-matter 补上，方便在 GitHub 上直接看。
 *
 * 用法：
 *   node scripts/docs.mjs --list                  列出库里的文档（路径/大小）
 *   node scripts/docs.mjs --export                导出到 content/（默认目录）
 *   node scripts/docs.mjs --export docs-export    导出到指定目录
 *   node scripts/docs.mjs --export --no-clean     导出但不清理目标目录里的旧文件
 *
 * 环境变量：
 *   WORKHUB_DB_V2 / WORKHUB_DB  数据库路径，默认 <项目根>/data/workhub-v2.db
 *   WORKHUB_VAULT_DIR         仓库目录，默认 <项目根>/data/vault
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { resolveDbPath, resolveVaultDir } from '../server/paths.ts';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
// 库与 vault 的路径跟服务端用同一套规则（server/paths.ts）：
// 之前这里自己抄了一遍优先级，其中一处漏了 WORKHUB_DB，工具和服务端会指向不同的库。
// resolve() 保留：相对路径按当前工作目录解析，跟原来的行为一致。
const DB_PATH = resolve(resolveDbPath());
const VAULT_DIR = resolve(resolveVaultDir());
const DEFAULT_OUT = resolve(ROOT, 'content');

/* ------------------------------ 参数 ------------------------------ */

const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const valueOf = (flag, fallback) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};

const doList = has('--list');
const doExport = has('--export');
const clean = !has('--no-clean');

if (!doList && !doExport) {
  console.error('用法：node scripts/docs.mjs --list | --export [目录]');
  process.exit(1);
}

if (!existsSync(DB_PATH)) {
  console.error(`找不到数据库：${DB_PATH}`);
  console.error('先跑一次 npm run server 生成数据库，或用 WORKHUB_DB_V2 指定路径。');
  process.exit(1);
}

/* ------------------------------ 读取 ------------------------------ */

const db = new Database(DB_PATH, { readonly: true });

const rows = db
  .prepare(
    `SELECT n.id, n.repo_id, n.name, n.type, n.parent_id, n.path, n.size, n.tags, n.encrypted,
            n.created_at, n.updated_at, n.created_by,
            r.slug AS repo_slug, r.name AS repo_name
       FROM nodes n
       JOIN repos r ON r.id = n.repo_id
      ORDER BY n.path`,
  )
  .all();
db.close();

/** 解析标签：库里存的是 JSON 数组，脏数据一律当空数组处理 */
function parseTags(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

/**
 * 正文在仓库目录里：<vault>/<仓库 slug>/docs/<节点路径>
 *
 * 文件名跟仓库目录用同一套规则：节点名不带 .md 就补一个（带了就别补，
 * 否则磁盘上会出现「xx.md.md」）。规则得跟 vault 一致——
 * 两边各写一套，找文件的时候就会「索引有、正文没有」，而数据其实好好的。
 */
function bodyFileName(rel) {
  return /\.md$/i.test(rel) ? rel : `${rel}.md`;
}

function bodyFile(doc) {
  const base = bodyFileName(doc.path);
  return join(VAULT_DIR, doc.repoSlug, 'docs', doc.encrypted ? `${base}.enc` : base);
}

const byId = new Map();
for (const r of rows) {
  byId.set(r.id, {
    id: r.id,
    name: r.name,
    type: r.type,
    parentId: r.parent_id ?? null,
    path: r.path,
    size: r.size ?? 0,
    encrypted: r.encrypted === 1,
    tags: parseTags(r.tags),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    createdBy: r.created_by,
    repoSlug: r.repo_slug,
    repoName: r.repo_name,
  });
}

/** 挂在父节点下；父节点不在库里（理论上不会）时当作根节点 */
const roots = [];
const childrenOf = new Map();
for (const doc of byId.values()) {
  if (doc.parentId && byId.has(doc.parentId)) {
    if (!childrenOf.has(doc.parentId)) childrenOf.set(doc.parentId, []);
    childrenOf.get(doc.parentId).push(doc);
  } else {
    roots.push(doc);
  }
}
for (const list of childrenOf.values()) {
  list.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
}
roots.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));

/** 计算每个节点的完整路径（人看的） */
function pathOf(doc) {
  const parts = [];
  let cur = doc;
  const guard = new Set();
  while (cur && !guard.has(cur.id)) {
    guard.add(cur.id);
    parts.unshift(cur.name);
    cur = cur.parentId ? byId.get(cur.parentId) : null;
  }
  return parts.join(' / ');
}

/* ------------------------------ 列出 ------------------------------ */

if (doList) {
  const files = rows.filter((r) => r.type === 'file');
  const folders = rows.filter((r) => r.type === 'folder');
  console.log(`数据库：${DB_PATH}`);
  console.log(`仓库目录：${VAULT_DIR}`);
  console.log(
    `共 ${rows.length} 个节点（${folders.length} 个目录 / ${files.length} 篇文档），` +
      `正文合计 ${(files.reduce((s, r) => s + (r.size ?? 0), 0) / 1024).toFixed(1)} KB`,
  );
  console.log('');

  const walk = (doc, depth) => {
    const pad = '  '.repeat(depth);
    if (doc.type === 'folder') {
      console.log(`${pad}📁 ${doc.name}`);
      for (const child of childrenOf.get(doc.id) ?? []) walk(child, depth + 1);
      return;
    }
    const tags = doc.tags.length ? `  {${doc.tags.join(', ')}}` : '';
    // 加密文档库里没有明文，正文大小无从谈起，只标出加密状态
    if (doc.encrypted) {
      console.log(`${pad}📄 ${doc.name}  🔒 已加密${tags}`);
      return;
    }
    const kb = ((doc.size ?? 0) / 1024).toFixed(1);
    console.log(`${pad}📄 ${doc.name}  ${kb} KB${tags}`);
  };
  for (const r of roots) walk(r, 0);

  console.log('');
  console.log('导成文件：node scripts/docs.mjs --export');
}

/* ------------------------------ 导出 ------------------------------ */

if (doExport) {
  const outDir = resolve(ROOT, valueOf('--export', 'content'));

  // 保护：输出目录不能是仓库根，也不能盖住数据库或仓库目录本身
  if (outDir === ROOT || outDir === dirname(DB_PATH) || outDir === VAULT_DIR) {
    console.error(`拒绝导出到 ${outDir}：会覆盖项目自身。`);
    process.exit(1);
  }

  if (clean && existsSync(outDir)) {
    // 只清空这个目录里的内容，目录本身保留
    for (const entry of readdirSync(outDir)) {
      rmSync(join(outDir, entry), { recursive: true, force: true });
    }
  }
  mkdirSync(outDir, { recursive: true });

  const manifest = [];
  let fileCount = 0;
  const skippedEncrypted = [];
  const missingBody = [];

  /**
   * 导出路径直接照搬仓库目录里的相对路径：<输出目录>/<仓库 slug>/<节点路径>。
   *
   * 那个路径是入库时算好的（已处理非法字符、已避开重名），照搬它就等于
   * 「导出结果和仓库目录一一对应」——不必在这儿再猜一遍命名规则，
   * 两处规则各说各话的话，导出出来的树和真仓库对不上。
   */
  const writeDoc = (doc) => {
    const target = join(outDir, doc.repoSlug, bodyFileName(doc.path));

    if (doc.type === 'folder') {
      mkdirSync(join(outDir, doc.repoSlug, doc.path), { recursive: true });
      manifest.push({
        id: doc.id,
        type: 'folder',
        name: doc.name,
        repo: doc.repoName,
        path: relative(outDir, join(outDir, doc.repoSlug, doc.path)).replace(/\\/g, '/'),
      });
      return;
    }

    // 加密文档的正文只存密文，库里没有明文：导不出，也不该把明文落盘。
    // 静默导出一个空文件更糟——看起来导出成功，实际内容是空的。
    if (doc.encrypted) {
      skippedEncrypted.push(doc.name);
      return;
    }

    const src = bodyFile(doc);
    if (!existsSync(src)) {
      // 索引有、正文文件没有：说明这份数据本身就不完整。
      // 写个空文件出去只会被当成「导出成功」，不如把话说清楚。
      missingBody.push(doc.path);
      return;
    }

    const content = readFileSync(src, 'utf8');

    const frontMatter = [
      '---',
      `id: ${doc.id}`,
      `name: ${JSON.stringify(doc.name)}`,
      `type: file`,
      `tags: ${JSON.stringify(doc.tags)}`,
      `createdAt: ${new Date(doc.createdAt).toISOString()}`,
      `updatedAt: ${new Date(doc.updatedAt).toISOString()}`,
      `createdBy: ${doc.createdBy}`,
      '---',
      '',
    ].join('\n');

    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, frontMatter + content, 'utf8');
    fileCount += 1;
    manifest.push({
      id: doc.id,
      type: 'file',
      name: doc.name,
      repo: doc.repoName,
      path: relative(outDir, target).replace(/\\/g, '/'),
      bytes: Buffer.byteLength(content, 'utf8'),
    });
  };

  // 目录先建，再写文件：空目录也能在导出结果里保留下来
  for (const doc of byId.values()) {
    if (doc.type === 'folder') writeDoc(doc);
  }
  for (const doc of byId.values()) {
    if (doc.type !== 'folder') writeDoc(doc);
  }

  // 清单：记录 id ↔ 路径的对应关系，将来要导回 workhub 时靠它对号入座
  writeFileSync(
    join(outDir, 'manifest.json'),
    JSON.stringify({ exportedAt: new Date().toISOString(), docs: manifest }, null, 2),
    'utf8',
  );

  console.log(`已导出 ${fileCount} 篇文档 → ${outDir}`);
  console.log(`清单：${join(outDir, 'manifest.json')}`);
  if (skippedEncrypted.length) {
    console.log('');
    console.log(`已跳过 ${skippedEncrypted.length} 篇加密文档（正文只存密文，导不出明文）：`);
    for (const name of skippedEncrypted) console.log(`      - ${name}`);
  }
  if (missingBody.length) {
    console.log('');
    console.log(`⚠ 有 ${missingBody.length} 篇文档在仓库目录里找不到正文文件，已跳过：`);
    for (const p of missingBody) console.log(`      - ${p}`);
    console.log('    索引里有、正文文件却没有，说明这份数据本身就不完整，建议核对仓库目录。');
  }
  console.log('');
  console.log('提醒：导出的是文档正文，提交到 GitHub 等于公开这些内容。');
  console.log('      确认要上传的话，把 .gitignore 里的 /content/ 那行删掉；');
  console.log('      只想本地留档就保持忽略。');
}
