/**
 * 迁移器：旧库（server/db.ts）→ 新库（v2）+ vault 文件。
 *
 * 设计原则：**旧库只读**。
 * 迁移全程不写旧库，也不删旧库的任何文件；跑完之后旧库原样躺在那里，
 * 万一新库有问题，改一行配置切回去就能继续用。
 *
 * 迁移要做四件事：
 *   1. 内容搬家：docs 的正文从 TEXT 列落到 vault 文件，docs 行变成 nodes 索引行；
 *   2. 归属归位：新模型里文档必须属于仓库，旧库里 repo_id 为空的
 *      全部并入自动创建的「默认仓库」，否则它们在新模型里无处安放；
 *   3. 结构升级：repos 补 slug 与 acl，attachments 变成 blobs；
 *   4. 索引重建：用搬过来的正文建 FTS5 索引（这一步不能省，
 *      否则切换后搜索会静默地什么都不返回）。
 *
 * 账号、授权、配置、审计那批表原样搬过来——它们与内容存储无关。
 */
import Database from 'better-sqlite3';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openV2Db, type V2Database } from './schema.ts';
import { toSearchText } from './search.ts';
import {
  VAULT_ROOT,
  assertInsideVault,
  bodyPath,
  cleanVault,
  contentHash,
  copyIntoVault,
  slugify,
  writeFileAtomic,
} from './vault.ts';

/** 与内容存储无关、原样搬过去的表 */
const PASSTHROUGH_TABLES = [
  'users',
  'guest_sessions',
  'access_requests',
  'access_grants',
  'agent_config',
  'agent_usage',
  'dingtalk_config',
  'reminders',
];

/** 旧库里那些没有仓库的文档，统一并入这个仓库 */
const DEFAULT_REPO_ID = 'r-default';
const DEFAULT_REPO_NAME = '默认仓库';

export interface MigrationReport {
  repos: number;
  /** 由默认仓库接管的旧文档数 */
  adoptedIntoDefault: number;
  nodes: number;
  blobs: number;
  passthroughRows: Record<string, number>;
  /** 未能迁移、需要人工看一眼的条目 */
  warnings: string[];
}

/** 旧库里的 docs 行 */
interface OldDocRow {
  id: string;
  name: string;
  type: 'file' | 'folder';
  parent_id: string | null;
  content: string | null;
  size: number | null;
  created_at: number;
  updated_at: number;
  created_by: string;
  updated_by: string;
  encrypted: number;
  enc_cipher: string | null;
  enc_master_dek: string | null;
  deleted_at: number | null;
  repo_id: string | null;
}

interface OldRepoRow {
  id: string;
  name: string;
  description: string;
  color: string;
  allowed_exts: string;
  max_file_size: number;
  rag_enabled: number;
  created_at: number;
  updated_at: number;
  created_by: string;
  deleted_at: number | null;
}

interface OldAttachmentRow {
  id: string;
  doc_id: string;
  name: string;
  ext: string;
  mime: string;
  size: number;
  sha256: string;
  storage_key: string;
  text_status: string;
  text_content: string | null;
  text_chars: number;
  created_at: number;
  updated_at: number;
  created_by: string;
  deleted_at: number | null;
}

/** 把正文切成检索用的 token 串：中文二元组 + 英文词，与 shared/retrieval.ts 同源 */
export { toSearchText, toMatchQuery } from './search.ts';

export function migrate(
  oldDbPath: string,
  newDbPath?: string,
  oldBlobRoot?: string,
): MigrationReport {
  const warnings: string[] = [];
  // vault 是派生数据，全量重建：先推倒，避免上一轮的残骸混进来
  cleanVault();

  const oldDb = new Database(oldDbPath, { readonly: true });
  const newDb: V2Database = openV2Db(newDbPath);

  const hasOld = oldDb
    .prepare("select name from sqlite_master where type='table' and name='docs'")
    .get();
  if (!hasOld) {
    oldDb.close();
    newDb.close();
    throw new Error(`旧库里没有 docs 表，不是 WorkHub 库：${oldDbPath}`);
  }

  // 迁移要能重跑：先把目标库里的内容表清空。
  // 顺序有讲究——nodes 引用 repos，必须先删子表再删父表。
  newDb.exec(`
    delete from node_fts;
    delete from attachments;
    delete from nodes;
    delete from repos;
  `);

  // ---- 1. 仓库：补 slug 与 acl ----
  const oldRepos = oldDb.prepare('select * from repos').all() as OldRepoRow[];
  const repoSlug = new Map<string, string>();
  const insertRepo = newDb.prepare(`
    insert into repos (id, slug, name, description, color, allowed_exts, max_file_size, rag_enabled, acl, created_at, updated_at, created_by)
    values (@id, @slug, @name, @description, @color, @allowed_exts, @max_file_size, @rag_enabled, @acl, @created_at, @updated_at, @created_by)
  `);
  for (const r of oldRepos) {
    const slug = slugify(r.name, r.id);
    repoSlug.set(r.id, slug);
    insertRepo.run({
      id: r.id,
      slug,
      name: r.name,
      description: r.description ?? '',
      color: r.color ?? '#6366f1',
      allowed_exts: r.allowed_exts ?? '[]',
      max_file_size: r.max_file_size ?? 26214400,
      rag_enabled: r.rag_enabled ?? 1,
      acl: '{}',
      created_at: r.created_at,
      updated_at: r.updated_at,
      created_by: r.created_by ?? 'u-admin',
    });
  }

  // ---- 2. 文档 → 节点（正文落文件）----
  const oldDocs = oldDb.prepare('select * from docs').all() as OldDocRow[];
  const hasUnassigned = oldDocs.some((d) => !d.repo_id);
  if (hasUnassigned) {
    // 新模型没有「未归档」：没有归属的文档必须落到某个仓库，
    // 否则它在新模型里是没有物理位置的幽灵。这里建一个默认仓库接住它们。
    const slug = slugify(DEFAULT_REPO_NAME, DEFAULT_REPO_ID);
    repoSlug.set(DEFAULT_REPO_ID, slug);
    insertRepo.run({
      id: DEFAULT_REPO_ID,
      slug,
      name: DEFAULT_REPO_NAME,
      description: '由旧库迁移而来：原先没有归属仓库的文档都收在这里。',
      color: '#6366f1',
      allowed_exts: '[]',
      max_file_size: 26214400,
      rag_enabled: 1,
      acl: '{}',
      created_at: Date.now(),
      updated_at: Date.now(),
      created_by: 'u-admin',
    });
  }

  const nodePath = new Map<string, string>();
  const usedPaths = new Map<string, Set<string>>();

  // 先按父子关系排出处理顺序：父节点必须先于子节点
  const byId = new Map(oldDocs.map((d) => [d.id, d]));
  const ordered: OldDocRow[] = [];
  const visited = new Set<string>();
  const visit = (d: OldDocRow) => {
    if (visited.has(d.id)) return;
    visited.add(d.id);
    if (d.parent_id && byId.has(d.parent_id)) visit(byId.get(d.parent_id)!);
    ordered.push(d);
  };
  for (const d of oldDocs) visit(d);

  const insertNode = newDb.prepare(`
    insert into nodes (id, repo_id, name, type, parent_id, path, size, content_hash, encrypted, enc_master_dek, acl, created_at, updated_at, created_by, updated_by)
    values (@id, @repo_id, @name, @type, @parent_id, @path, @size, @content_hash, @encrypted, @enc_master_dek, @acl, @created_at, @updated_at, @created_by, @updated_by)
  `);
  const insertFts = newDb.prepare(
    'insert into node_fts (repo_id, node_id, name, body) values (?, ?, ?, ?)',
  );

  let adoptedIntoDefault = 0;
  for (const d of ordered) {
    const repoId = d.repo_id ?? DEFAULT_REPO_ID;
    if (!d.repo_id) adoptedIntoDefault += 1;
    const slug = repoSlug.get(repoId) ?? repoSlug.get(DEFAULT_REPO_ID)!;

    // 路径 = 父路径 + 名称；同名冲突时补 id 前缀，绝不覆盖
    const parentPath = d.parent_id ? nodePath.get(d.parent_id) : undefined;
    let rel = parentPath ? `${parentPath}/${d.name}` : d.name;
    const bucket = usedPaths.get(slug) ?? new Set<string>();
    usedPaths.set(slug, bucket);
    if (bucket.has(rel)) {
      rel = `${rel}~${d.id.replace(/^d-/, '').slice(0, 6)}`;
      if (bucket.has(rel)) {
        warnings.push(`路径冲突未解决：${d.name} (${d.id})`);
      }
    }
    bucket.add(rel);
    nodePath.set(d.id, rel);

    const encrypted = d.encrypted === 1;
    let size = d.size ?? 0;
    let hash: string | null = null;

    if (d.type === 'file') {
      if (encrypted) {
        // 加密文档：正文列是空的，真正的内容在 enc_cipher（密文字符串）
        const cipher = d.enc_cipher ?? '';
        if (!cipher) {
          warnings.push(`加密文档缺少密文：${d.name} (${d.id})`);
        } else {
          writeFileAtomic(bodyPath(slug, rel, true), cipher);
          size = Buffer.byteLength(cipher, 'utf8');
          hash = contentHash(cipher);
        }
      } else {
        const content = d.content ?? '';
        writeFileAtomic(bodyPath(slug, rel, false), content);
        size = Buffer.byteLength(content, 'utf8');
        hash = contentHash(content);
      }
    }

    insertNode.run({
      id: d.id,
      repo_id: repoId,
      name: d.name,
      type: d.type,
      parent_id: d.parent_id,
      path: rel,
      size,
      content_hash: hash,
      encrypted: encrypted ? 1 : 0,
      enc_master_dek: d.enc_master_dek ?? null,
      acl: '{}',
      created_at: d.created_at,
      updated_at: d.updated_at,
      created_by: d.created_by ?? 'u-admin',
      updated_by: d.updated_by ?? 'u-admin',
    });

    // 只有明文文档进检索索引：密文进索引等于把密文喂给模型
    if (d.type === 'file' && !encrypted) {
      insertFts.run(repoId, d.id, toSearchText(d.name), toSearchText(d.content ?? ''));
    }
  }

  // ---- 3. 附件：二进制搬进仓库目录，库里只留元数据 ----
  const hasAttachments = oldDb
    .prepare("select name from sqlite_master where type='table' and name='attachments'")
    .get();
  const oldAttachments = hasAttachments
    ? (oldDb.prepare('select * from attachments').all() as OldAttachmentRow[])
    : [];
  const insertBlob = newDb.prepare(`
    insert into attachments (id, doc_id, name, ext, mime, size, sha256, storage_key, text_status, text_content, text_chars, created_at, updated_at, created_by)
    values (@id, @doc_id, @name, @ext, @mime, @size, @sha256, @storage_key, @text_status, @text_content, @text_chars, @created_at, @updated_at, @created_by)
  `);
  const blobRoot = oldBlobRoot ?? resolve(oldDbPath, '../blobs');
  for (const a of oldAttachments) {
    const slug = (() => {
      const node = newDb.prepare('select repo_id from nodes where id=?').get(a.doc_id) as
        | { repo_id: string }
        | undefined;
      return node ? repoSlug.get(node.repo_id) ?? repoSlug.get(DEFAULT_REPO_ID)! : repoSlug.get(DEFAULT_REPO_ID)!;
    })();
    const rel = nodePath.get(a.doc_id) ?? '未归位';
    const from = join(blobRoot, a.storage_key);
    const to = assertInsideVault(join(VAULT_ROOT, slug, 'assets', rel, a.name));
    let storagePath = '';
    if (existsSync(from)) {
      copyIntoVault(from, to);
      storagePath = to.slice(VAULT_ROOT.length + 1).split(/[\\/]/).join('/');
    } else {
      warnings.push(`附件二进制缺失：${a.name} (${a.id})，元数据已搬但文件没找到`);
    }
    insertBlob.run({
      id: a.id,
      doc_id: a.doc_id,
      name: a.name,
      ext: a.ext ?? '',
      mime: a.mime ?? '',
      size: a.size ?? 0,
      sha256: a.sha256,
      storage_key: storagePath,
      text_status: a.text_status ?? 'none',
      text_content: a.text_content ?? null,
      text_chars: a.text_chars ?? 0,
      created_at: a.created_at,
      updated_at: a.updated_at,
      created_by: a.created_by ?? 'u-admin',
    });
  }

  // ---- 4. 原样搬过去的表 ----
  // 表结构由 schema.ts 统一负责，这里只搬数据：
  // 结构搬过来会和「运行时建的表」产生两套定义，改一处忘一处迟早出事。
  const passthroughRows: Record<string, number> = {};
  for (const table of PASSTHROUGH_TABLES) {
    const existsInOld = oldDb
      .prepare("select name from sqlite_master where type='table' and name=?")
      .get(table);
    if (!existsInOld) continue;

    // 迁移是「全量重建」语义：先清空目标表，免得上一轮的残留行混进来
    newDb.exec(`delete from ${table}`);

    const oldCols = (oldDb.prepare(`pragma table_info(${table})`).all() as Array<{ name: string }>).map(
      (c) => c.name,
    );
    const newCols = (newDb.prepare(`pragma table_info(${table})`).all() as Array<{ name: string }>).map(
      (c) => c.name,
    );
    // 只搬两库都有的列：旧库多出来的历史列（比如 deleted_at）就此退休
    const cols = oldCols.filter((c) => newCols.includes(c));
    if (cols.length === 0) continue;

    const rows = oldDb.prepare(`select ${cols.join(',')} from ${table}`).all() as Array<
      Record<string, unknown>
    >;
    if (rows.length === 0) {
      passthroughRows[table] = 0;
      continue;
    }
    const placeholders = cols.map(() => '?').join(',');
    const stmt = newDb.prepare(
      `insert or replace into ${table} (${cols.join(',')}) values (${placeholders})`,
    );
    const tx = newDb.transaction((list: Array<Record<string, unknown>>) => {
      for (const row of list) stmt.run(...cols.map((c) => row[c]));
    });
    tx(rows);
    passthroughRows[table] = rows.length;
  }

  const counts: MigrationReport = {
    repos: oldRepos.length + (hasUnassigned ? 1 : 0),
    adoptedIntoDefault,
    nodes: oldDocs.length,
    blobs: oldAttachments.length,
    passthroughRows,
    warnings,
  };

  oldDb.close();
  newDb.close();
  return counts;
}

/** 校验：逐篇比对新旧内容，确认迁移没有丢东西、没有串行 */
export function verify(oldDbPath: string, newDbPath?: string): {
  ok: boolean;
  checked: number;
  mismatches: string[];
} {
  const oldDb = new Database(oldDbPath, { readonly: true });
  const newDb = openV2Db(newDbPath);
  const mismatches: string[] = [];

  const oldDocs = oldDb.prepare('select * from docs').all() as OldDocRow[];
  const newRepos = newDb.prepare('select id, slug from repos').all() as Array<{
    id: string;
    slug: string;
  }>;
  const slugById = new Map(newRepos.map((r) => [r.id, r.slug]));

  let checked = 0;
  for (const d of oldDocs) {
    const node = newDb.prepare('select * from nodes where id=?').get(d.id) as
      | Record<string, unknown>
      | undefined;
    if (!node) {
      mismatches.push(`节点缺失：${d.name} (${d.id})`);
      continue;
    }
    if (node.name !== d.name || node.type !== d.type) {
      mismatches.push(`元数据不一致：${d.name} (${d.id})`);
    }
    // 每个节点都必须落在某个仓库里
    if (!node.repo_id) {
      mismatches.push(`节点没有仓库归属：${d.name} (${d.id})`);
    }
    if (d.type !== 'file') continue;

    const slug = slugById.get(node.repo_id as string);
    if (!slug) {
      mismatches.push(`节点指向不存在的仓库：${d.name} (${d.id})`);
      continue;
    }
    const encrypted = d.encrypted === 1;
    const rel = node.path as string;
    const target = bodyPath(slug, rel, encrypted);
    let actual: string | null = null;
    try {
      actual = readFileSync(target, 'utf8');
    } catch {
      actual = null;
    }
    if (actual === null) {
      mismatches.push(`正文文件缺失：${d.name} (${d.id}) -> ${target}`);
      continue;
    }
    const expected = encrypted ? d.enc_cipher ?? '' : d.content ?? '';
    if (actual !== expected) {
      mismatches.push(`正文不一致：${d.name} (${d.id})`);
    }
    checked += 1;
  }

  // 反向检查：新库里不能有正文没落盘的节点
  const orphan = newDb
    .prepare(
      "select id, name, path from nodes where type='file' and (content_hash is null or content_hash = '')",
    )
    .all() as Array<{ id: string; name: string; path: string }>;
  for (const o of orphan) {
    mismatches.push(`节点没有正文内容：${o.name} (${o.id})`);
  }

  oldDb.close();
  newDb.close();
  return { ok: mismatches.length === 0, checked, mismatches };
}

// 直接运行本文件时执行迁移
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const oldPath = process.argv[2] ?? resolve('data/mdhub.db');
  const report = migrate(oldPath);
  console.log('迁移完成：', report);
  const v = verify(oldPath);
  console.log('校验：', v.ok ? '通过' : '未通过', `比对 ${v.checked} 篇`);
  if (!v.ok) {
    for (const m of v.mismatches) console.log('  ✗', m);
    process.exitCode = 1;
  }
}
