/**
 * 日常日志落点：把小结追加进「<文件夹>/<YYYY-MM-DD>.md」。
 *
 * 结构是「仓库 → 一个固定文件夹 → 按天一篇」：
 * 同一天多篇会话往同一篇文档追加小节，打开一天就能看到全天的工作流。
 * 文件夹不存在就建，文档不存在就建——采集器不挑环境，
 * 空仓库装上也能直接用。
 */
import {
  getDoc,
  insertDoc,
  listAllDocs,
  updateDocRow,
} from '../db.ts';
import { logger } from '../logger.ts';
import type { DocNode } from '../../shared/types.ts';

/** 写入者署名：节点表的 updated_by 是普通文本，不挂用户表 */
const ACTOR = 'collector';

function newDocId(): string {
  return `d-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 找（或建）日志文件夹与当天的日志文档，返回文档 id。
 */
export function ensureDailyDoc(repoId: string, folderName: string, dateKey: string): string {
  const all = listAllDocs();
  const folder =
    all.find((d) => d.type === 'folder' && d.repoId === repoId && d.name === folderName && !d.parentId) ??
    insertDoc({
      id: newDocId(),
      name: folderName,
      type: 'folder',
      parentId: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      createdBy: ACTOR,
      updatedBy: ACTOR,
      repoId,
    });

  const docName = `${dateKey}.md`;
  const existing = all.find(
    (d) => d.type === 'file' && d.repoId === repoId && d.parentId === folder.id && d.name === docName,
  );
  if (existing) return existing.id;

  const ts = Date.now();
  const doc = insertDoc({
    id: newDocId(),
    name: docName,
    type: 'file',
    parentId: folder.id,
    content: `# 工作日志 ${dateKey}\n`,
    createdAt: ts,
    updatedAt: ts,
    createdBy: ACTOR,
    updatedBy: ACTOR,
    repoId,
  });
  logger.info(`采集器：已创建日志文档 ${folderName}/${docName}`);
  return doc.id;
}

/**
 * 追加一节会话小结。
 *
 * 追加前重读正文：调度是串行的（一轮一个会话），但管理员可能
 * 同时在网页上编辑这篇日志——把整篇盖回去会吃掉别人的改动。
 * 追加只成功一次，失败交给调用方记日志重试。
 */
export function appendSessionEntry(
  docId: string,
  entry: { time: number; conversationId: string; summary: string },
): boolean {
  const doc: DocNode | undefined = getDoc(docId);
  if (!doc) return false;
  const time = new Date(entry.time).toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' });
  const section = `\n\n## ${time} 会话 ${entry.conversationId.slice(0, 8)}\n\n${entry.summary.trim()}\n`;
  return updateDocRow(docId, { content: `${(doc.content ?? '').replace(/\s*$/, '')}${section}` }, ACTOR);
}
