/**
 * 仓库（项目）的数据访问层。
 *
 * 仓库要解决的核心问题是「按项目切分差异」：
 * 不同项目留存的格式不同、检索范围不同、迁移边界不同。
 * 把这些差异收在仓库里，而不是散落在全局配置与各处特判中。
 *
 * 这里覆盖的动作对应真实场景：
 * - 归入（moveDocsToRepo）：文档跨项目搬家；
 * - 改设置（updateRepo）：收紧允许格式、关掉检索等；
 * - 整块搬运（见 server/repoTransfer.ts）：导出到另一个实例。
 *
 * v2 的两个前提：
 *   - 没有回收站：删仓库就是删（连同里面的文档与文件）；
 *   - 没有「未归档」：每个文档都有归属，跨仓库只能搬，不能「取消归属」。
 */
import { randomUUID } from 'node:crypto';
import { db, moveNodesToRepo } from './db.ts';
import { logger } from './logger.ts';
import { removeRepoDir, slugify } from './storage/v2/vault.ts';
import type { Repo, RepoStat } from '../shared/types.ts';

/* ------------------------------ 行映射 ------------------------------ */

interface RepoRow {
  id: string;
  slug: string;
  name: string;
  description: string;
  color: string;
  allowed_exts: string;
  max_file_size: number;
  rag_enabled: number;
  acl: string;
  created_at: number;
  updated_at: number;
  created_by: string;
}

function rowToRepo(r: RepoRow): Repo {
  let allowedExts: string[] = [];
  try {
    const parsed = JSON.parse(r.allowed_exts || '[]');
    if (Array.isArray(parsed)) {
      allowedExts = parsed
        .filter((e): e is string => typeof e === 'string')
        .map((e) => e.toLowerCase().trim())
        .filter(Boolean);
    }
  } catch {
    // 白名单存坏了就当没限制：宁可多收，不可把上传功能整个卡死。
    logger.warn('仓库允许格式白名单解析失败，按不限处理', r.id);
  }
  return {
    id: r.id,
    slug: r.slug,
    name: r.name,
    description: r.description,
    color: r.color,
    allowedExts,
    maxFileSize: r.max_file_size,
    ragEnabled: r.rag_enabled === 1,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    createdBy: r.created_by,
  };
}

/* ------------------------------ 查询 ------------------------------ */

/** 全部仓库 */
export function listRepos(): Repo[] {
  return (db.prepare('SELECT * FROM repos ORDER BY created_at ASC').all() as RepoRow[]).map(rowToRepo);
}

export function getRepo(id: string): Repo | undefined {
  const row = db.prepare('SELECT * FROM repos WHERE id = ?').get(id) as RepoRow | undefined;
  return row ? rowToRepo(row) : undefined;
}

/** 按名字查仓库 */
export function findRepoByName(name: string): Repo | undefined {
  const row = db.prepare('SELECT * FROM repos WHERE name = ?').get(name) as RepoRow | undefined;
  return row ? rowToRepo(row) : undefined;
}

/* ------------------------------ 增删改 ------------------------------ */

export interface CreateRepoInput {
  name: string;
  description?: string;
  color?: string;
  allowedExts?: string[];
  maxFileSize?: number;
  ragEnabled?: boolean;
  createdBy: string;
}

export function createRepo(input: CreateRepoInput): Repo {
  const now = Date.now();
  const id = `r-${randomUUID().slice(0, 8)}`;
  const repo: Repo = {
    id,
    slug: slugify(input.name, id),
    name: input.name,
    description: input.description ?? '',
    color: input.color ?? '#6366f1',
    allowedExts: input.allowedExts ?? [],
    maxFileSize: input.maxFileSize ?? 25 * 1024 * 1024,
    ragEnabled: input.ragEnabled ?? true,
    createdAt: now,
    updatedAt: now,
    createdBy: input.createdBy,
  };
  db.prepare(
    `INSERT INTO repos (id, slug, name, description, color, allowed_exts, max_file_size, rag_enabled, acl, created_at, updated_at, created_by)
     VALUES (@id, @slug, @name, @description, @color, @allowedExts, @maxFileSize, @ragEnabled, '{}', @createdAt, @updatedAt, @createdBy)`,
  ).run({
    id: repo.id,
    slug: repo.slug,
    name: repo.name,
    description: repo.description,
    color: repo.color,
    allowedExts: JSON.stringify(repo.allowedExts),
    maxFileSize: repo.maxFileSize,
    ragEnabled: repo.ragEnabled ? 1 : 0,
    createdAt: repo.createdAt,
    updatedAt: repo.updatedAt,
    createdBy: repo.createdBy,
  });
  return repo;
}

export interface UpdateRepoInput {
  name?: string;
  description?: string;
  color?: string;
  allowedExts?: string[];
  maxFileSize?: number;
  ragEnabled?: boolean;
}

export function updateRepo(id: string, patch: UpdateRepoInput): Repo | undefined {
  const current = getRepo(id);
  if (!current) return undefined;

  const next: Repo = {
    ...current,
    name: patch.name ?? current.name,
    description: patch.description ?? current.description,
    color: patch.color ?? current.color,
    allowedExts: patch.allowedExts ?? current.allowedExts,
    maxFileSize: patch.maxFileSize ?? current.maxFileSize,
    ragEnabled: patch.ragEnabled ?? current.ragEnabled,
    updatedAt: Date.now(),
  };

  // slug 不改：它是目录名，改了等于把仓库搬了个家，
  // 里面所有文档的路径都会失效。改名只改名字。
  db.prepare(
    `UPDATE repos SET name = @name, description = @description, color = @color,
       allowed_exts = @allowedExts, max_file_size = @maxFileSize, rag_enabled = @ragEnabled,
       updated_at = @updatedAt
     WHERE id = @id`,
  ).run({
    id,
    name: next.name,
    description: next.description,
    color: next.color,
    allowedExts: JSON.stringify(next.allowedExts),
    maxFileSize: next.maxFileSize,
    ragEnabled: next.ragEnabled ? 1 : 0,
    updatedAt: next.updatedAt,
  });

  return next;
}

/**
 * 删仓库。
 *
 * 没有回收站，删除就是删除：仓库目录整个删掉，里面的文档与附件一并消失。
 * 这比「先标记后删除」更干脆，但代价是没有后悔药——
 * 所以删之前应当确认仓库内容已经导出或转移。
 */
export interface DeleteRepoResult {
  removed: boolean;
  /** 连带删掉的文档数 */
  docs: number;
  /** 连带删掉的附件数 */
  attachments: number;
}

export function deleteRepo(id: string): DeleteRepoResult {
  const repo = getRepo(id);
  if (!repo) return { removed: false, docs: 0, attachments: 0 };

  const docCount = listDocIdsInRepo(id).length;
  const attachmentCount = (
    db
      .prepare(
        'SELECT COUNT(*) AS n FROM attachments a JOIN nodes d ON d.id = a.doc_id WHERE d.repo_id = ?',
      )
      .get(id) as { n: number }
  ).n;

  // 先删目录，再删索引与行。
  //
  // 顺序反过来会停在最糟的状态：仓库行没了、目录还在，
  // 那一整个仓库的文件就成了没人认领的孤儿——既查不到归属，也没法重试。
  // 现在目录删不掉就直接失败，仓库还在列表里，用户看得见、还能再试一次。
  removeRepoDir(repo.slug);

  // 索引行会随外键级联一起消失，但 FTS 是虚表，不吃外键，得自己清
  db.prepare('delete from node_fts where repo_id = ?').run(id);
  db.prepare('delete from attachment_fts where repo_id = ?').run(id);
  db.prepare('DELETE FROM repos WHERE id = ?').run(id);
  return { removed: true, docs: docCount, attachments: attachmentCount };
}

/* ------------------------------ 文档归属 ------------------------------ */

/** 仓库内的文档 id */
export function listDocIdsInRepo(repoId: string): string[] {
  return (db.prepare('SELECT id FROM nodes WHERE repo_id = ?').all(repoId) as Array<{ id: string }>).map(
    (r) => r.id,
  );
}

/**
 * 把文档归入仓库（跨仓库迁移）。
 *
 * 搬的是整棵子树：孩子跟着爹走。
 * 若只搬爹不搬孩子，就会出现「孩子在 A 仓库、爹在 B 仓库」的错位——
 * 那样按仓库过滤文件树时，爹出现了孩子没出现，或者反过来。
 *
 * 正文文件也跟着搬：仓库换了，目录名就换了，
 * 文件不挪位置的话，索引说它在，磁盘上却读不出来。
 */
export function moveDocsToRepo(docIds: string[], targetRepoId: string): number {
  return moveNodesToRepo(docIds, targetRepoId);
}

/* ------------------------------ 统计 ------------------------------ */

/** 各仓库的规模统计 */
export function repoStats(): RepoStat[] {
  const rows = db
    .prepare(
      `SELECT repo_id AS repoId,
              COUNT(DISTINCT d.id) AS docCount,
              COALESCE(SUM(d.size), 0) AS docSize
         FROM nodes d
        GROUP BY d.repo_id`,
    )
    .all() as Array<{ repoId: string; docCount: number; docSize: number }>;

  const attRows = db
    .prepare(
      `SELECT d.repo_id AS repoId, COUNT(a.id) AS attachmentCount, COALESCE(SUM(a.size), 0) AS attachmentSize
         FROM attachments a
         JOIN nodes d ON d.id = a.doc_id
        GROUP BY d.repo_id`,
    )
    .all() as Array<{ repoId: string; attachmentCount: number; attachmentSize: number }>;

  const attMap = new Map(attRows.map((r) => [r.repoId, r]));
  return rows.map((r) => {
    const att = attMap.get(r.repoId);
    return {
      repoId: r.repoId,
      docCount: r.docCount,
      attachmentCount: att?.attachmentCount ?? 0,
      totalSize: (r.docSize ?? 0) + (att?.attachmentSize ?? 0),
    };
  });
}
