/**
 * 全文索引的写入与查询。
 *
 * 中文按二元组切分：把「真机调试」切成「真机 / 机调 / 调试」，
 * 好处是不用维护词典也能子串命中——搜「调试」能命中「真机调试」，
 * 而整词切分做不到这一点。
 *
 * **写入与查询必须用同一套切法**，否则切得不一样，一个字都搜不到。
 * 所以这两个函数放在一处，且都复用 shared/retrieval.ts 的 tokenize。
 */
import { tokenize } from '../../../shared/retrieval.ts';
import type { V2Database } from './schema.ts';

/** 供索引存储的文本：token 用空格隔开 */
export function toSearchText(text: string): string {
  return tokenize(text || '').join(' ');
}

/**
 * 供 FTS5 查询的表达式。
 *
 * 每个 token 都要加引号：不加的话像「c++」或「a-b」里的符号会被 FTS 当成
 * 运算符，整条查询直接报错。引号包起来就是字面匹配。
 */
export function toMatchQuery(query: string): string {
  return tokenize(query || '')
    .map((t) => `"${t.replace(/"/g, '""')}"`)
    .join(' ');
}

/**
 * 供 FTS5 召回用的表达式：token 之间取「或」。
 *
 * 与 toMatchQuery 的差别在语义，不在语法：
 * - toMatchQuery 用空格连接，等于「全部命中」，适合「找这句话」这种精确搜索；
 * - 召回要的是「宁可多召回一点，别漏」，所以用 OR。
 *
 * 中文按二元组切开后，OR 的效果是「命中任意一个二元组」：
 * 搜「真机调试」能召回只写了「调试」的那篇——整词匹配做不到这一点。
 */
export function toRecallQuery(query: string): string {
  return tokenize(query || '')
    .map((t) => `"${t.replace(/"/g, '""')}"`)
    .join(' OR ');
}

/** 查询的两种语义：精确匹配（全命中）与召回（任意命中） */
export type IndexQueryMode = 'match' | 'recall';

/**
 * 写一条索引。
 *
 * FTS5 虚表没有主键，同一个 node_id 重复写会得到多行。
 * 所以写之前先把该节点已有的行删掉——保证「一个节点一行索引」。
 */
export function indexNode(
  db: V2Database,
  nodeId: string,
  repoId: string,
  name: string,
  body: string,
): void {
  unindexNode(db, nodeId);
  db.prepare('insert into node_fts (repo_id, node_id, name, body) values (?, ?, ?, ?)').run(
    repoId,
    nodeId,
    toSearchText(name),
    toSearchText(body),
  );
}

/** 删掉某个节点的索引 */
export function unindexNode(db: V2Database, nodeId: string): void {
  db.prepare('delete from node_fts where node_id = ?').run(nodeId);
}

export interface IndexHit {
  node_id: string;
  repo_id: string;
  /** 匹配得分，越小越相关（FTS5 的 bm25 越小越靠前） */
  rank: number;
}

/**
 * 在索引里查。
 *
 * repoIds 传了就只在这些仓库里找——这是仓库化检索的关键：
 * 先按仓库圈定范围，再做匹配，不必把全站文档捞出来再筛。
 *
 * mode 决定 token 之间是「全命中」还是「任意命中」：
 * 搜索框用 match（精确），Agent 召回用 recall（宽松）。
 */
export function searchIndex(
  db: V2Database,
  query: string,
  limit = 50,
  repoIds?: string[],
  mode: IndexQueryMode = 'match',
): IndexHit[] {
  const match = mode === 'recall' ? toRecallQuery(query) : toMatchQuery(query);
  if (!match) return [];

  const scope = repoIds && repoIds.length > 0 ? repoIds : undefined;
  // 参数一律用位置占位符：better-sqlite3 里命名占位符得配对象传，
  // 混用会在运行时直接抛「参数个数不对」。
  const rows = db
    .prepare(
      `select node_id, repo_id, rank
         from node_fts
        where node_fts match ?
          ${scope ? 'and repo_id in (' + scope.map(() => '?').join(',') + ')' : ''}
        order by rank
        limit ?`,
    )
    .all(...(scope ? [match, ...scope, limit] : [match, limit])) as Array<{
    node_id: string;
    repo_id: string;
    rank: number;
  }>;
  return rows;
}

/* ------------------------------ 附件索引 ------------------------------ */

/**
 * 写一条附件索引。
 *
 * 与文档索引同样的道理：先删后写，保证「一个附件一行索引」。
 * 抽不出正文的附件不写索引——空文本进了索引也匹配不到什么，
 * 只会让索引白白变大。
 */
export function indexAttachment(
  db: V2Database,
  attId: string,
  repoId: string,
  name: string,
  body: string,
): void {
  unindexAttachment(db, attId);
  if (!body) return;
  db.prepare('insert into attachment_fts (repo_id, att_id, name, body) values (?, ?, ?, ?)').run(
    repoId,
    attId,
    toSearchText(name),
    toSearchText(body),
  );
}

/** 删掉某个附件的索引 */
export function unindexAttachment(db: V2Database, attId: string): void {
  db.prepare('delete from attachment_fts where att_id = ?').run(attId);
}

export interface AttachmentIndexHit {
  att_id: string;
  repo_id: string;
  /** 匹配得分，越小越相关（FTS5 的 bm25 越小越靠前） */
  rank: number;
}

/** 在附件索引里查。默认走召回语义——附件匹配宁多勿漏 */
export function searchAttachmentIndex(
  db: V2Database,
  query: string,
  limit = 50,
  repoIds?: string[],
  mode: IndexQueryMode = 'recall',
): AttachmentIndexHit[] {
  const match = mode === 'recall' ? toRecallQuery(query) : toMatchQuery(query);
  if (!match) return [];

  const scope = repoIds && repoIds.length > 0 ? repoIds : undefined;
  return db
    .prepare(
      `select att_id, repo_id, rank
         from attachment_fts
        where attachment_fts match ?
          ${scope ? 'and repo_id in (' + scope.map(() => '?').join(',') + ')' : ''}
        order by rank
        limit ?`,
    )
    .all(...(scope ? [match, ...scope, limit] : [match, limit])) as AttachmentIndexHit[];
}
