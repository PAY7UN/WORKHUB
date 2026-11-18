/**
 * 内置文档：记录区里那几份「系统自带」的资料（当前是协议说明书）。
 *
 * 它要同时满足三件事，缺一件就不好办：
 *
 * 1. **跟代码走版本管理**：仓库 `docs/protocols/<协议 id>.md`（或插件包自带的
 *    那份）是内置版，改它等于改协议说明，要走代码评审。记录区里放的是现场版。
 * 2. **不能删**：内置文档删了，下次启动又会长回来——删的人只会觉得
 *    「删了又冒出来」。所以内置目录与其中的文档都拒绝删除。
 * 3. **能改**：现场拿到厂家 PDF 后要能就地修订，不能只能读。
 *
 * 「本地改过」怎么认：记住上次同步时的内置版哈希（builtin_docs 表）。
 *   现场版哈希 == 内置版哈希 → 没人动过，代码更新时直接覆盖
 *   现场版哈希 != 内置版哈希 → 本地改过，代码更新不覆盖，只提示有新版
 *
 * 为什么不用一个 is_builtin 列：nodes 表结构一旦对不上就会拒绝启动，
 * 要求所有人重建库。加一个保留路径段是零成本的替代，见 storage/v2/builtin.ts。
 */
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { db, insertDoc, updateDocRow, type NodeRow } from './db.ts';
import { logger } from './logger.ts';
import {
  BUILTIN_ROOT_SEGMENT,
  BUILTIN_TOOLS_DIR_ID,
  BUILTIN_TOOLS_DIR_NAME,
  builtinDocNodeId,
  protocolIdOfBuiltinNode as builtinNodeProtocolId,
} from './storage/v2/builtin.ts';
import { contentHash } from './storage/v2/vault.ts';
import {
  BUILTIN_PROTOCOL_DOCS_DIR,
  DEFAULT_PROTOCOL_DOCS_DIR,
} from './channels/protocolDocs.ts';
import { findTemplate } from '../shared/tools.ts';

/** 写入者署名：内置文档不是谁「上传」的，是系统安顿的 */
const SYSTEM_ACTOR = 'system';

/** 内置版的来源：仓库自带，还是插件包里带的 */
export type BuiltinDocSource = 'repo' | 'plugin';

/** 协议说明书的引用：工具区只拿这个，正文由记录区自己读 */
export interface BuiltinDocRef {
  /** 协议 id */
  protocolId: string;
  /** 记录区里这篇文档的节点 id */
  nodeId: string;
  /** 文档标题（文件名） */
  title: string;
  /** 内置版还是现场改过的 */
  origin: 'builtin' | 'local';
  /** 代码里的说明书有更新，且现场也改过——要人来定怎么合 */
  hasUpdate: boolean;
}

/** 同步结果 */
export type SyncStatus = 'created' | 'updated' | 'unchanged' | 'local-modified';

/** 一份内置版的内容 */
interface BuiltinSource {
  /** 正文 */
  markdown: string;
  /** 显示名（文件名） */
  title: string;
  /** 来源 */
  kind: BuiltinDocSource;
  /** 来源文件在哪（恢复内置版时照它读回来） */
  path: string;
}

/* ------------------------------ 仓库里的内置版 ------------------------------ */

/** 仓库里有说明书的协议 id */
export function listBuiltinProtocolIds(): string[] {
  if (!existsSync(BUILTIN_PROTOCOL_DOCS_DIR)) return [];
  try {
    return readdirSync(BUILTIN_PROTOCOL_DOCS_DIR)
      .filter((name) => name.endsWith('.md'))
      .map((name) => name.slice(0, -3))
      .sort();
  } catch {
    return [];
  }
}

/** 仓库里那份说明书的正文 */
export function readBuiltinSource(protocolId: string): string | null {
  const file = join(BUILTIN_PROTOCOL_DOCS_DIR, `${protocolId}.md`);
  if (!existsSync(file)) return null;
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/** 说明书的显示名：协议名（认不出来就用协议 id） */
function builtinDocName(protocolId: string): string {
  const template = findTemplate(protocolId);
  return template ? `${template.name}.md` : `${protocolId}.md`;
}

/* ------------------------------ 节点与基线 ------------------------------ */

/** 某个内置文档的索引行 */
function builtinRow(protocolId: string): NodeRow | undefined {
  return db
    .prepare('SELECT * FROM nodes WHERE id = ?')
    .get(builtinDocNodeId(protocolId)) as NodeRow | undefined;
}

/** 基线记录 */
interface BaselineRow {
  node_id: string;
  protocol_id: string;
  source: BuiltinDocSource;
  source_path: string;
  baseline_hash: string;
  source_hash: string;
}

function baselineRow(protocolId: string): BaselineRow | undefined {
  return db
    .prepare('SELECT * FROM builtin_docs WHERE protocol_id = ?')
    .get(protocolId) as BaselineRow | undefined;
}

function saveBaseline(
  protocolId: string,
  nodeId: string,
  source: BuiltinSource,
  baselineHash: string,
): void {
  db.prepare(
    `INSERT INTO builtin_docs (node_id, protocol_id, source, source_path, baseline_hash, source_hash, updated_at)
     VALUES (@nodeId, @protocolId, @source, @sourcePath, @baselineHash, @sourceHash, @updatedAt)
     ON CONFLICT(node_id) DO UPDATE SET
       source = @source, source_path = @sourcePath,
       baseline_hash = @baselineHash, source_hash = @sourceHash,
       updated_at = @updatedAt`,
  ).run({
    nodeId,
    protocolId,
    source: source.kind,
    sourcePath: source.path,
    baselineHash,
    sourceHash: contentHash(source.markdown),
    updatedAt: Date.now(),
  });
}

/* ------------------------------ 状态查询 ------------------------------ */

/**
 * 这份说明书此刻的状态。
 *
 * hasUpdate：代码里的内置版比上次同步时新了。
 * localModified：现场版比上次同步时新了（有人改过）。
 */
export function builtinDocState(protocolId: string): {
  hasUpdate: boolean;
  localModified: boolean;
} {
  const row = builtinRow(protocolId);
  const baseline = baselineRow(protocolId);
  if (!row || !baseline) return { hasUpdate: false, localModified: false };
  return {
    hasUpdate: baseline.source_hash !== baseline.baseline_hash,
    localModified: (row.content_hash ?? '') !== baseline.baseline_hash,
  };
}

/** 全部内置文档的引用（给工具目录用） */
export function listBuiltinDocRefs(): BuiltinDocRef[] {
  const ids = new Set(listBuiltinProtocolIds());
  const rows = db.prepare('SELECT protocol_id FROM builtin_docs').all() as Array<{
    protocol_id: string;
  }>;
  for (const row of rows) ids.add(row.protocol_id);

  const refs: BuiltinDocRef[] = [];
  for (const protocolId of [...ids].sort()) {
    const row = builtinRow(protocolId);
    if (!row) continue;
    const { hasUpdate, localModified } = builtinDocState(protocolId);
    refs.push({
      protocolId,
      nodeId: row.id,
      title: row.name,
      origin: localModified ? 'local' : 'builtin',
      hasUpdate,
    });
  }
  return refs;
}

/** 某个协议在记录区里的文档节点 id（没有则 undefined） */
export function builtinDocNodeIdFor(protocolId: string): string | undefined {
  return builtinRow(protocolId)?.id;
}

/** 从节点 id 反推协议 id（不是内置文档则 undefined） */
export function protocolIdOfBuiltinNode(nodeId: string): string | undefined {
  return builtinNodeProtocolId(nodeId) ?? undefined;
}

/* ------------------------------ 播种与同步 ------------------------------ */

/** 建内置目录（记录区里的「工具」） */
function ensureBuiltinDir(): void {
  const existing = db.prepare('SELECT id FROM nodes WHERE id = ?').get(BUILTIN_TOOLS_DIR_ID);
  if (existing) return;
  const now = Date.now();
  insertDoc(
    {
      id: BUILTIN_TOOLS_DIR_ID,
      name: BUILTIN_TOOLS_DIR_NAME,
      type: 'folder',
      parentId: null,
      createdAt: now,
      updatedAt: now,
      createdBy: SYSTEM_ACTOR,
      updatedBy: SYSTEM_ACTOR,
    },
    { path: BUILTIN_ROOT_SEGMENT },
  );
}

/**
 * 把一份内置版同步到记录区。
 *
 * 覆盖只在「没人动过」时发生：现场版被改过就原样留着，
 * 由界面提示「代码里有新版」——该合还是该换，由人决定。
 */
function applySource(protocolId: string, source: BuiltinSource): SyncStatus {
  const sourceHash = contentHash(source.markdown);
  const nodeId = builtinDocNodeId(protocolId);
  const row = builtinRow(protocolId);

  if (!row) {
    const now = Date.now();
    insertDoc(
      {
        id: nodeId,
        name: source.title,
        type: 'file',
        parentId: BUILTIN_TOOLS_DIR_ID,
        content: source.markdown,
        createdAt: now,
        updatedAt: now,
        createdBy: SYSTEM_ACTOR,
        updatedBy: SYSTEM_ACTOR,
      },
      { path: `${BUILTIN_ROOT_SEGMENT}/${source.title}` },
    );
    saveBaseline(protocolId, nodeId, source, sourceHash);
    return 'created';
  }

  const baseline = baselineRow(protocolId);
  const currentHash = row.content_hash ?? '';

  // 现场改过：代码里的更新不覆盖
  if (baseline && currentHash !== baseline.baseline_hash) {
    // 但要把「当前内置版的哈希」记下来——界面据此提示有新版
    saveBaseline(protocolId, nodeId, source, baseline.baseline_hash);
    return 'local-modified';
  }

  if (currentHash !== sourceHash) {
    updateDocRow(nodeId, { content: source.markdown }, SYSTEM_ACTOR);
    saveBaseline(protocolId, nodeId, source, sourceHash);
    return 'updated';
  }

  saveBaseline(protocolId, nodeId, source, sourceHash);
  return 'unchanged';
}

/** 同步一份仓库里的说明书 */
export function syncBuiltinDoc(protocolId: string): SyncStatus {
  const markdown = readBuiltinSource(protocolId);
  if (markdown === null) return 'unchanged';
  return applySource(protocolId, {
    markdown,
    title: builtinDocName(protocolId),
    kind: 'repo',
    path: join(BUILTIN_PROTOCOL_DOCS_DIR, `${protocolId}.md`),
  });
}

/**
 * 种一份插件包自带的说明书。
 *
 * 插件包也是跟着版本走的：插件升级时它那份说明书也换了。
 * 所以它跟仓库内置版用同一套基线——没人改过就跟着插件升级一起换。
 */
export function seedPluginDoc(protocolId: string, markdown: string, title: string): SyncStatus {
  return applySource(protocolId, {
    markdown,
    title: title.endsWith('.md') ? title : `${title}.md`,
    kind: 'plugin',
    path: '',
  });
}

/**
 * 把内置文档安顿好：建目录、播种、同步。
 *
 * 启动时做一次。失败不拦服务——内置文档只是资料，
 * 缺一份不该让整个站起不来。
 */
export function ensureBuiltinDocs(): void {
  try {
    ensureBuiltinDir();
    for (const protocolId of listBuiltinProtocolIds()) {
      try {
        syncBuiltinDoc(protocolId);
      } catch (err) {
        logger.warn('内置文档同步失败', protocolId, err);
      }
    }
    migrateLegacyImportedDocs();
  } catch (err) {
    logger.warn('内置文档初始化失败', err);
  }
}

/**
 * 旧版导入的说明书搬到记录区。
 *
 * 以前导入的文档落在 `data/protocol-docs/<协议 id>.md`。
 * 现在导入的内容直接写进记录区的内置文档节点，那个目录不再是数据源。
 * 搬一次就好：搬完删掉源文件，免得下次启动又搬一遍盖掉现场改动。
 */
function migrateLegacyImportedDocs(): void {
  if (!existsSync(DEFAULT_PROTOCOL_DOCS_DIR)) return;
  let names: string[];
  try {
    names = readdirSync(DEFAULT_PROTOCOL_DOCS_DIR);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.endsWith('.md')) continue;
    const protocolId = name.slice(0, -3);
    const file = join(DEFAULT_PROTOCOL_DOCS_DIR, name);
    let markdown: string;
    try {
      markdown = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    try {
      // 现场已经改过就别覆盖——搬家的目的是保住现场版本，不是抹掉它
      const { localModified } = builtinDocState(protocolId);
      if (!localModified) writeBuiltinDoc(protocolId, markdown);
      rmSync(file, { force: true });
    } catch (err) {
      logger.warn('旧导入文档迁移失败', protocolId, err);
    }
  }
}

/* ------------------------------ 写入与恢复 ------------------------------ */

/**
 * 写入一份说明书的正文（导入或现场修订都走这里）。
 *
 * 写进去之后它就与内置版「不一样」了——同步时会认成「本地改过」，
 * 以后代码更新不会把它覆盖掉。
 */
export function writeBuiltinDoc(protocolId: string, markdown: string, userId = SYSTEM_ACTOR): boolean {
  const nodeId = builtinDocNodeId(protocolId);
  const row = builtinRow(protocolId);

  if (!row) {
    // 没有内置版（协议是插件自带的，现场导入的那份），直接建节点。
    // 基线留空：这样它永远算「本地改过」，代码以后补上内置版也不会覆盖现场版。
    const now = Date.now();
    const title = builtinDocName(protocolId);
    insertDoc(
      {
        id: nodeId,
        name: title,
        type: 'file',
        parentId: BUILTIN_TOOLS_DIR_ID,
        content: markdown,
        createdAt: now,
        updatedAt: now,
        createdBy: userId,
        updatedBy: userId,
      },
      { path: `${BUILTIN_ROOT_SEGMENT}/${title}` },
    );
    saveBaseline(
      protocolId,
      nodeId,
      { markdown, title, kind: 'repo', path: '' },
      '',
    );
    return true;
  }

  return updateDocRow(nodeId, { content: markdown }, userId);
}

/**
 * 恢复成内置版本。
 *
 * 「恢复内置」不是删掉现场版，而是把内置版那份抄回去：
 * 抄回去之后它又归代码管了。
 */
export function resetBuiltinDoc(protocolId: string): boolean {
  const baseline = baselineRow(protocolId);
  const nodeId = builtinDocNodeId(protocolId);
  if (!baseline || !builtinRow(protocolId)) return false;

  let markdown: string | null = null;
  if (baseline.source_path && existsSync(baseline.source_path)) {
    try {
      markdown = readFileSync(baseline.source_path, 'utf8');
    } catch {
      markdown = null;
    }
  }
  if (markdown === null) {
    markdown = readBuiltinSource(protocolId);
  }
  if (markdown === null) return false;

  updateDocRow(nodeId, { content: markdown }, SYSTEM_ACTOR);
  saveBaseline(
    protocolId,
    nodeId,
    {
      markdown,
      title: builtinRow(protocolId)?.name ?? builtinDocName(protocolId),
      kind: baseline.source,
      path: baseline.source_path,
    },
    contentHash(markdown),
  );
  return true;
}
