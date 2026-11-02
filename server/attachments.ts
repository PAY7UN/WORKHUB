/**
 * 附件的数据访问层。
 *
 * 附件是「挂在文档上的留存文件」，生命周期与文档绑在一起：
 * 文档没了，附件跟着没；文档还在，附件单独删掉就是删掉了。
 *
 * 两个和 v2 之前不同的决定：
 *
 * 1. **没有回收站**。附件删了就是删了——文档都没法进回收站，
 *    给附件留一条后路只会造成「文档在、附件不在」这种半吊子状态。
 *
 * 2. **二进制住在仓库目录里**，不再用全局内容寻址池。
 *    仓库是边界：导出一个仓库就带着它的附件一起走，
 *    删一个仓库也不会误伤别的仓库的同内容文件。
 *    代价是同一份内容存两份——对「留存型附件」来说，这个代价比边界清晰更划算。
 */
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { db } from './db.ts';
import { extractText } from './extract.ts';
import {
  VAULT_ROOT,
  assertInsideVault,
  pruneEmptyDirs,
  writeFileAtomic,
} from './storage/v2/vault.ts';
import { indexAttachment, unindexAttachment } from './storage/v2/search.ts';
import { extOf } from '../shared/attachments.ts';
import type { Attachment, Repo } from '../shared/types.ts';

/** 单个附件的体积上限（字节）。服务端硬限，与前端提示无关 */
export const HARD_MAX_FILE_SIZE = 64 * 1024 * 1024;

/* ------------------------------ 行映射 ------------------------------ */

interface AttachmentRow {
  id: string;
  doc_id: string;
  name: string;
  ext: string;
  mime: string;
  size: number;
  sha256: string;
  storage_key: string;
  text_status: Attachment['textStatus'];
  text_content: string | null;
  text_chars: number;
  created_at: number;
  updated_at: number;
  created_by: string;
}

/** 对外的附件对象：不含正文，也不含存储键——这两样都不该出现在 API 响应里 */
function rowToAttachment(r: AttachmentRow): Attachment {
  return {
    id: r.id,
    docId: r.doc_id,
    name: r.name,
    ext: r.ext,
    mime: r.mime,
    size: r.size,
    sha256: r.sha256,
    textStatus: r.text_status,
    textChars: r.text_chars,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    createdBy: r.created_by,
  };
}

/* ------------------------------ 存储位置 ------------------------------ */

/**
 * 附件在 vault 里的位置：<仓库目录>/assets/<宿主文档路径>/<文件名>。
 *
 * 跟着宿主文档走，删文档时附件的位置是确定的——
 * 不用维护一张「附件属于哪篇文档」的额外映射（数据库里已经有 doc_id 了）。
 */
function assetLocation(docId: string, filename: string): { abs: string; rel: string } | undefined {
  const node = db
    .prepare(
      `SELECT n.path AS path, r.slug AS slug
         FROM nodes n JOIN repos r ON r.id = n.repo_id
        WHERE n.id = ?`,
    )
    .get(docId) as { path: string; slug: string } | undefined;
  if (!node) return undefined;
  const rel = join(node.slug, 'assets', node.path, filename);
  return { abs: assertInsideVault(join(VAULT_ROOT, rel)), rel };
}

/* ------------------------------ 查询 ------------------------------ */

/** 宿主文档所在仓库。附件的检索范围跟着宿主走，所以要问到它的仓库 */
function hostRepoId(docId: string): string | undefined {
  const row = db.prepare('SELECT repo_id FROM nodes WHERE id = ?').get(docId) as
    | { repo_id: string }
    | undefined;
  return row?.repo_id;
}

/**
 * 重建某个附件的索引。
 *
 * 改名、换宿主、宿主换仓库之后都要重建：索引里存着名字与仓库归属，
 * 两者都变了还留着旧索引，就成了「搜得到但点不开」的幽灵条目。
 */
function reindexAttachment(row: AttachmentRow): void {
  const repoId = hostRepoId(row.doc_id);
  const text = row.text_status === 'ok' ? row.text_content ?? '' : '';
  if (!repoId || !text) {
    unindexAttachment(db, row.id);
    return;
  }
  indexAttachment(db, row.id, repoId, row.name, text);
}

/** 某篇文档下的附件 */
export function listAttachments(docId: string): Attachment[] {
  return (
    db
      .prepare('SELECT * FROM attachments WHERE doc_id = ? ORDER BY created_at ASC')
      .all(docId) as AttachmentRow[]
  ).map(rowToAttachment);
}

/**
 * 按 id 取若干附件，连同抽出的正文。
 *
 * 只取召回命中的那几个，不把全站附件正文都读进内存——
 * 那正是「每次提问都把整库读一遍」的老毛病。
 *
 * 返回顺序与传入的 ids 一致：ids 是索引给出的相关度序，
 * 顺序丢了就等于把召回结果又打乱一遍。
 */
export function loadAttachmentsWithText(ids: string[]): SearchableAttachment[] {
  if (!ids.length) return [];
  const rows = db
    .prepare(
      `SELECT * FROM attachments
        WHERE id IN (${ids.map(() => '?').join(',')})
          AND text_status = 'ok' AND text_chars > 0`,
    )
    .all(...ids) as AttachmentRow[];
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids
    .map((id) => byId.get(id))
    .filter((r): r is AttachmentRow => !!r)
    .map((r) => ({ attachment: rowToAttachment(r), text: r.text_content ?? '' }));
}

/** 带正文的附件，供检索侧使用 */
export interface SearchableAttachment {
  attachment: Attachment;
  /** 抽出的纯文本 */
  text: string;
}

export function getAttachment(id: string): Attachment | undefined {
  const row = db.prepare('SELECT * FROM attachments WHERE id = ?').get(id) as AttachmentRow | undefined;
  return row ? rowToAttachment(row) : undefined;
}

/** 取出附件的二进制内容 */
export function readAttachmentContent(id: string): { attachment: Attachment; data: Buffer } | undefined {
  const row = db.prepare('SELECT * FROM attachments WHERE id = ?').get(id) as AttachmentRow | undefined;
  if (!row) return undefined;
  const abs = assertInsideVault(join(VAULT_ROOT, row.storage_key));
  if (!existsSync(abs)) return undefined;
  return { attachment: rowToAttachment(row), data: readFileSync(abs) };
}

/* ------------------------------ 写入 ------------------------------ */

export interface AddAttachmentInput {
  docId: string;
  name: string;
  mime?: string;
  data: Buffer;
  createdBy: string;
}

/**
 * 存一个附件。
 *
 * 三件事：落二进制（进宿主文档所在的仓库目录）、抽文本（供检索）、登记元数据。
 * 抽文本失败不影响这次上传——附件的价值首先在「留存」，
 * 检索是加分项，不能因为抽不出文本就把用户的文件退回去。
 */
export async function addAttachment(input: AddAttachmentInput): Promise<Attachment> {
  const now = Date.now();
  const ext = extOf(input.name);
  const sha256 = createHash('sha256').update(input.data).digest('hex');
  const extracted = await extractText(input.data, input.name);

  const loc = assetLocation(input.docId, input.name);
  if (!loc) throw new Error('宿主文档不存在');
  writeFileAtomic(loc.abs, input.data);

  const id = `a-${randomUUID().slice(0, 8)}`;
  db.prepare(
    `INSERT INTO attachments (id, doc_id, name, ext, mime, size, sha256, storage_key,
                              text_status, text_content, text_chars, created_at, updated_at, created_by)
     VALUES (@id, @docId, @name, @ext, @mime, @size, @sha256, @storageKey,
             @textStatus, @textContent, @textChars, @createdAt, @updatedAt, @createdBy)`,
  ).run({
    id,
    docId: input.docId,
    name: input.name,
    ext,
    mime: input.mime || 'application/octet-stream',
    size: input.data.length,
    sha256,
    storageKey: loc.rel.split(/[\\/]/).join('/'),
    textStatus: extracted.status,
    textContent: extracted.text || null,
    textChars: extracted.text.length,
    createdAt: now,
    updatedAt: now,
    createdBy: input.createdBy,
  });

  const row = db.prepare('SELECT * FROM attachments WHERE id = ?').get(id) as AttachmentRow;
  reindexAttachment(row);

  return getAttachment(id)!;
}

/** 改名 */
export function renameAttachment(id: string, name: string): Attachment | undefined {
  const row = db.prepare('SELECT * FROM attachments WHERE id = ?').get(id) as AttachmentRow | undefined;
  if (!row) return undefined;
  // 文件名变了，磁盘上的文件名也要跟着变
  const loc = assetLocation(row.doc_id, name);
  const oldAbs = assertInsideVault(join(VAULT_ROOT, row.storage_key));
  if (loc && existsSync(oldAbs) && oldAbs !== loc.abs) {
    writeFileAtomic(loc.abs, readFileSync(oldAbs));
    try {
      unlinkSync(oldAbs);
    } catch {
      // 旧文件删不掉就留着：新文件已经写好，不影响使用
    }
  }
  const changed = db
    .prepare('UPDATE attachments SET name = ?, ext = ?, storage_key = ?, updated_at = ? WHERE id = ?')
    .run(
      name,
      extOf(name),
      loc ? loc.rel.split(/[\\/]/).join('/') : row.storage_key,
      Date.now(),
      id,
    ).changes;
  if (changed) {
    const updated = db.prepare('SELECT * FROM attachments WHERE id = ?').get(id) as AttachmentRow;
    reindexAttachment(updated);
  }
  return changed ? getAttachment(id) : undefined;
}

/**
 * 把附件挂到另一篇文档下（移动文件）。
 *
 * 二进制要跟着搬：附件的位置带着宿主文档的路径，
 * 换个宿主就换了个目录，不搬的话文件就留在了旧目录里。
 */
export function moveAttachment(id: string, targetDocId: string): Attachment | undefined {
  const row = db.prepare('SELECT * FROM attachments WHERE id = ?').get(id) as AttachmentRow | undefined;
  if (!row) return undefined;
  const target = db.prepare('SELECT id FROM nodes WHERE id = ?').get(targetDocId) as
    | { id: string }
    | undefined;
  if (!target) return undefined;

  const loc = assetLocation(targetDocId, row.name);
  if (!loc) return undefined;
  const oldAbs = assertInsideVault(join(VAULT_ROOT, row.storage_key));
  if (existsSync(oldAbs)) {
    writeFileAtomic(loc.abs, readFileSync(oldAbs));
    try {
      unlinkSync(oldAbs);
      pruneEmptyDirs(join(oldAbs, '..'));
    } catch {
      // 旧文件删不掉就留着
    }
  }

  const changed = db
    .prepare('UPDATE attachments SET doc_id = ?, storage_key = ?, updated_at = ? WHERE id = ?')
    .run(targetDocId, loc.rel.split(/[\\/]/).join('/'), Date.now(), id).changes;
  if (changed) {
    const updated = db.prepare('SELECT * FROM attachments WHERE id = ?').get(id) as AttachmentRow;
    reindexAttachment(updated);
  }
  return changed ? getAttachment(id) : undefined;
}

/* ------------------------------ 删除 ------------------------------ */

/**
 * 删除附件：行删掉，磁盘上的文件也删掉。
 *
 * 没有回收站，所以这是终态操作。
 */
export function removeAttachment(id: string): boolean {
  const row = db.prepare('SELECT * FROM attachments WHERE id = ?').get(id) as AttachmentRow | undefined;
  if (!row) return false;
  const changed = db.prepare('DELETE FROM attachments WHERE id = ?').run(id).changes > 0;
  if (changed) {
    unindexAttachment(db, id);
    const abs = assertInsideVault(join(VAULT_ROOT, row.storage_key));
    try {
      if (existsSync(abs)) unlinkSync(abs);
      pruneEmptyDirs(join(abs, '..'));
    } catch {
      // 删不掉就留着孤儿文件，不影响功能
    }
  }
  return changed;
}

/* ------------------------------ 规则校验 ------------------------------ */

export interface AttachmentCheck {
  ok: boolean;
  reason?: string;
}

/**
 * 校验一个文件能不能挂到该仓库的文档上。
 *
 * 仓库自带「允许格式」与「体积上限」，不同项目的要求本就不同，
 * 所以规则按仓库走而不是全局统一。仓库没有则放行——
 * 找不到规则时一律放行，比把上传功能卡死要好。
 */
export function checkAttachmentAllowed(repo: Repo | undefined, filename: string, size: number): AttachmentCheck {
  if (size <= 0) return { ok: false, reason: '文件内容为空' };

  const ext = extOf(filename);
  if (repo) {
    if (repo.allowedExts.length > 0 && !repo.allowedExts.includes(ext)) {
      const allowed = repo.allowedExts.join('、');
      return {
        ok: false,
        reason: `仓库「${repo.name}」只允许上传 ${allowed} 格式的文件，这个文件（${ext || '无扩展名'}）不在其中`,
      };
    }
    if (size > repo.maxFileSize) {
      return {
        ok: false,
        reason: `文件超过仓库「${repo.name}」的体积上限（${Math.round(repo.maxFileSize / 1024 / 1024)}MB）`,
      };
    }
  }
  return { ok: true };
}
