/**
 * SQLite 数据访问层：文档、用户、Agent 配置。
 * API Key 以 AES-256-GCM 加密落库，主密钥来自 config.ts 中已校验的 WORKHUB_SECRET。
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ADMIN_PASSWORD, SECRET } from './config.ts';
import { envFlag } from './env.ts';
import { logger } from './logger.ts';
import { hashPassword, verifyPassword } from './password.ts';
import { openV2Db } from './storage/v2/schema.ts';
import { planDbMigration, resolveDbPath } from './paths.ts';
import {
  VAULT_ROOT,
  bodyPath,
  contentHash,
  discardParkedRepoDir,
  filePath,
  folderDirs,
  moveAssetFile,
  moveBodyFile,
  moveFileAt,
  parkRepoDir,
  readFileSafe,
  removeBodyFile,
  removeRepoDir,
  unparkRepoDir,
  writeFileAtomic,
} from './storage/v2/vault.ts';
import {
  indexNode,
  searchAttachmentIndex,
  searchIndex,
  unindexAttachment,
  unindexNode,
} from './storage/v2/search.ts';
import {
  encryptDocContentWithDek,
  unwrapDekWithMaster,
  type EncryptedDocMaterial,
} from './docCrypto.ts';
import type {
  AccessAuditAction,
  AccessCapability,
  AgentSettings,
  DingTalkChannel,
  DingTalkConfig,
  DingTalkConfigView,
  DocNode,
  DocSearchHit,
  Reminder,
  ReminderRepeat,
  ReminderStatus,
  User,
  RagScope,
} from '../shared/types.ts';
import { DEFAULT_AGENT_SETTINGS, DEFAULT_DINGTALK_CONFIG, DEFAULT_RAG_SCOPE } from '../shared/types.ts';
// 仅取类型，编译后无运行时代码，不与 upstream.ts 形成循环依赖
import type { TokenUsage } from './upstream.ts';
import { SEED_DOCS } from '../shared/seed.ts';

/**
 * 数据库路径。导出供启动日志使用，避免与本文件各写一份而出现「日志说的不是实际那个库」。
 *
 * v2 起只有一个库：表结构统一由 server/storage/v2/schema.ts 定义，
 * 文档正文落在 vault 的仓库目录里，库里只留索引行。
 * 旧库 data/workhub-v1.db 原样保留着，作为回退的底牌。
 */
export const DB_PATH = resolveDbPath();

mkdirSync(dirname(DB_PATH), { recursive: true });

/**
 * 库文件改名后的迁移：把旧文件名下的库搬到新名字下。
 *
 * 必须在开库之前搬。SQLite 在 WAL 模式下，`.db` 旁边还跟着 `-wal` 与 `-shm`
 * 两个伴生文件：`-wal` 里攒着已提交但还没落回主库的事务页。只搬 `.db` 的话，
 * 新库开起来会看不见旧 WAL 里的那些页，表现为「少了几条记录」。
 *
 * **搬不动就拒绝启动，绝不拿空库顶上。**
 * 搬不动的原因是文件正被另一个进程占着（Windows 上会报 EBUSY）——多半是
 * 上一版的 WorkHub 还开着。这时候如果硬着头皮建一个新库，用户看到的现象是
 * 「我的文档全没了」，而真相是数据好好地躺在旧文件里。那是比启动失败
 * 严重得多的事故：人会以为该删什么、该重装什么。
 * 所以宁可起不来，并且把「先关掉正在运行的 WorkHub」这句话说清楚。
 */
const dbMigration = planDbMigration(DB_PATH);
if (dbMigration) {
  try {
    renameSync(dbMigration.from, dbMigration.to);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? '未知错误';
    throw new Error(
      `数据库改名迁移失败：${dbMigration.from} → ${dbMigration.to}（${code}）。` +
        `多半是还有 WorkHub 进程在用这个库——请先关掉正在运行的 WorkHub（含托盘），再启动一次。` +
        `你的数据仍在原处，没有丢。`,
    );
  }
  // WAL 与 SHM 是伴生文件：主库搬过来后它们也得跟上，否则 SQLite 找不到
  // 未落盘的事务页。搬不动只丢最近的事务，不至于开不了库 —— 警告即可。
  for (const suffix of ['-wal', '-shm']) {
    const from = dbMigration.from + suffix;
    if (!existsSync(from)) continue;
    try {
      renameSync(from, dbMigration.to + suffix);
    } catch {
      logger.warn(`数据库改名迁移：${from} 挪不动，最近的事务可能没带上（库本身不受影响）`);
    }
  }
  logger.notice(`数据库已改名迁移：${dbMigration.from} → ${dbMigration.to}`);
}

export const db = openV2Db(DB_PATH);
/**
 * WAL 里攒的是已提交但还没落回主库的事务页。SQLite 默认攒到 1000 页（约 4MB）
 * 才自动 checkpoint，而 checkpoint 只把页拷回主库、不回收 WAL 文件本身，
 * 于是「workhub-v2.db-wal」能一路涨到几 MB，攒出一堆看着像缓存的大文件。
 *
 * 两个 pragma 一起治：
 *   - wal_autocheckpoint 压到 256 页（约 1MB），让运行期及时把页拷回主库；
 *   - 启动时 TRUNCATE 一次，把上次运行残留的 WAL 直接截断归零。
 * 若此刻有别的进程连着同一个库，TRUNCATE 会返回 busy 而不生效，属于可接受情况：
 * 那说明对方正在用，WAL 保持原样不会丢数据。
 */
db.pragma('wal_checkpoint(TRUNCATE)');

/*
 * 表结构不在这里定义。
 *
 * 统一由 server/storage/v2/schema.ts 提供：那是「表长什么样」的唯一真相源，
 * 迁移器建库、运行时建表、空库启动补表都走它。
 * 这里只放「怎么用这些表」的逻辑——SQL 与行映射。
 *
 * 这样做的好处很实在：改字段只需改一处。
 * 以前建表语句散在 db.ts 里、迁移脚本里各写一份，改了一处忘了另一处，
 * 就会遇到「迁移建的库」和「运行时建的库」结构对不上，错误在别处才炸。
 */



/* ------------------------------ 密钥加解密 ------------------------------ */

/**
 * 主密钥：JWT 签名与密文包裹都基于它。
 * 导出供文档加密使用——服务端用它包裹/解包加密文档的数据密钥。
 * 注意：改动 WORKHUB_SECRET 会让既有密文（API Key、加密文档）全部不可解。
 */
export const MASTER_KEY = createHash('sha256').update(SECRET).digest();


/** AES-256-GCM 加密，输出 iv:tag:ciphertext（hex） */
export function encryptSecret(plain: string): string | null {
  if (!plain) return null;
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', MASTER_KEY, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return `${iv.toString('hex')}:${cipher.getAuthTag().toString('hex')}:${enc.toString('hex')}`;
}

/** 解密；主密钥变更后旧密文不可解，返回空串 */
export function decryptSecret(payload: string | null): string {
  if (!payload) return '';
  const [ivHex, tagHex, dataHex] = payload.split(':');
  if (!ivHex || !tagHex || !dataHex) return '';
  try {
    const decipher = createDecipheriv('aes-256-gcm', MASTER_KEY, Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    return Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]).toString('utf8');
  } catch {
    return '';
  }
}

/* ------------------------------ 行映射 ------------------------------ */

export interface UserRow {
  id: string;
  username: string;
  display_name: string;
  role: 'admin' | 'viewer';
  avatar: string;
  color: string;
  /** 存量明文列，仅为兼容旧库；新写入一律为空 */
  password: string;
  /** scrypt 哈希，空串表示尚未设置或待升级 */
  password_hash: string;
}

function rowToUser(r: UserRow): User {
  return {
    id: r.id,
    username: r.username,
    displayName: r.display_name,
    role: r.role,
    avatar: r.avatar,
    color: r.color,
  };
}

/* ------------------------------ 初始化 ------------------------------ */

/**
 * 示例文档仅在显式开启时灌入（WORKHUB_SEED_DEMO=1）。
 * 正式部署默认为空库，避免示例内容被当成真实数据带进生产。
 */
if (envFlag('SEED_DEMO')) {
  const docCount = db.prepare('SELECT COUNT(*) AS n FROM nodes').get() as { n: number };
  if (docCount.n === 0) {
    // 示例文档也要有归属：仓库为空时先建一个，否则文档无处安放
    const repoCount = db.prepare('SELECT COUNT(*) AS n FROM repos').get() as { n: number };
    if (repoCount.n === 0) {
      const ts = Date.now();
      db.prepare(
        `INSERT INTO repos (id, slug, name, description, color, allowed_exts, max_file_size, rag_enabled, acl, created_at, updated_at, created_by)
         VALUES ('r-demo', 'demo', '示例', '示例文档的归属仓库', '#6366f1', '[]', 26214400, 1, '{}', ?, ?, 'u-admin')`,
      ).run(ts, ts);
    }
    const repoId = (db.prepare('SELECT id FROM repos ORDER BY created_at LIMIT 1').get() as { id: string })
      .id;
    // 文件夹优先插入，满足父键约束
    [...SEED_DOCS]
      .sort((a) => (a.type === 'folder' ? -1 : 1))
      .forEach((d) =>
        insertDoc({
          ...d,
          repoId,
          content: d.content ?? '',
          size: d.size ?? undefined,
          createdBy: 'u-admin',
          updatedBy: 'u-admin',
        }),
      );
    logger.info(`已载入 ${SEED_DOCS.length} 篇示例文档（WORKHUB_SEED_DEMO=1）`);
  }
}

// 每个文档都必须有归属，所以「至少存在一个仓库」是系统的硬前提，
// 不是可选项：仓库一个都没有，新建的文档就无处安放。
// 空库启动时先立一个默认仓库，管理员随时可以改名或删掉重建。
const repoCount = db.prepare('SELECT COUNT(*) AS n FROM repos').get() as { n: number };
if (repoCount.n === 0) {
  const ts = Date.now();
  db.prepare(
    `INSERT INTO repos (id, slug, name, description, color, allowed_exts, max_file_size, rag_enabled, acl, created_at, updated_at, created_by)
     VALUES ('r-default', 'default', '默认仓库', '系统自动创建的默认仓库，可改名或换成自己的仓库', '#6366f1', '[]', 26214400, 1, '{}', ?, ?, 'u-admin')`,
  ).run(ts, ts);
  logger.info('已创建默认仓库「默认仓库」：文档必须有归属，空库也需要一个落脚的仓库');
}

// 账号与模型配置和文档数量无关，必须无条件保证存在，
// 否则空库启动后将无人可以登录、模型参数无处落库。
const userCount = db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number };
if (userCount.n === 0) {
  const insertUser = db.prepare(
    'INSERT INTO users (id, username, display_name, role, avatar, color, password, password_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  );
  // 初始密码即刻哈希，明文列留空。访客无密码可言，明文与哈希都写空串。
  insertUser.run('u-admin', 'admin', '系统管理员', 'admin', 'A', '#6366f1', '', hashPassword(ADMIN_PASSWORD));
  insertUser.run('u-viewer', 'viewer', '访客', 'viewer', 'V', '#f59e0b', '', '');
} else {
  // 体检：.env 里的 WORKHUB_ADMIN_PASSWORD 只在首次建库那一刻写进账号，之后再改它
  // 不会动已有账号的密码。很多人改完 .env 就登不上了，又找不到原因，
  // 只觉得「密码失效了」——那句话得在这里说清楚，而不是让人对着一句
  // 「密码错误」反复重试。真相其实就一句：这个变量只对新建的库生效。
  const adminRow = db
    .prepare("SELECT password_hash, password FROM users WHERE username = 'admin'")
    .get() as { password_hash: string; password: string } | undefined;
  if (adminRow && !verifyPassword(ADMIN_PASSWORD, adminRow.password_hash, adminRow.password)) {
    logger.warn('.env 中的 WORKHUB_ADMIN_PASSWORD 与数据库中现有的管理员密码不一致');
    logger.warn('  该变量只在首次建库时写入，之后修改 .env 不会改变已有账号的密码');
    logger.warn('  若要改用 .env 里的密码，请执行：npm run admin:password -- <新密码>');
  }
}

const agentConfigRow = db.prepare('SELECT id FROM agent_config WHERE id = 1').get();
if (!agentConfigRow) {
  db.prepare(
    `INSERT INTO agent_config (id, base_url, api_key_enc, model, group_id, temperature, allow_guest, top_k, context_budget, updated_at)
     VALUES (1, ?, NULL, ?, '', 0.3, 0, 5, 24000, ?)`,
  ).run(DEFAULT_AGENT_SETTINGS.baseUrl, DEFAULT_AGENT_SETTINGS.model, Date.now());
}

/* ------------------------------ 文档读写 ------------------------------ */

/**
 * nodes 表的一行。
 *
 * 与旧模型最大的不同：**没有 content 列**。
 * 正文住在 vault 的仓库目录里，这一行只记「它在哪、多大、是不是加密」。
 * 于是「读一篇文档」变成两件事：查索引拿路径 → 读文件。
 */
export interface NodeRow {
  id: string;
  repo_id: string;
  name: string;
  type: 'file' | 'folder';
  parent_id: string | null;
  /** 仓库内的相对路径，唯一 */
  path: string;
  size: number | null;
  content_hash: string | null;
  /** 节点形态：note（Markdown 笔记）/ file（原件）。老库补列后是空串，按 note 处理 */
  kind: string;
  /** 原件的 MIME 类型 */
  mime: string;
  /** 原件的扩展名（含点） */
  ext: string;
  encrypted: number;
  enc_master_dek: string | null;
  enc_locked_at: number | null;
  acl: string;
  tags: string | null;
  created_at: number;
  updated_at: number;
  created_by: string;
  updated_by: string;
}

/** 仓库目录名（slug）。仓库改名不会改 slug，所以路径不会断 */
export function repoSlugOf(repoId: string): string {
  const row = db.prepare('SELECT slug FROM repos WHERE id = ?').get(repoId) as
    | { slug: string }
    | undefined;
  if (!row) throw new Error(`仓库不存在：${repoId}`);
  return row.slug;
}

/** 某节点正文文件的绝对路径 */
function bodyFileOf(row: NodeRow): string {
  return bodyPath(repoSlugOf(row.repo_id), row.path, row.encrypted === 1);
}

/**
 * 节点形态。老库补列时拿不到默认值（会补成空串），所以空串一律按 note 处理。
 *
 * 读侧统一走这个函数，别处不要直接看 kind 列——
 * 一旦有人写了 `row.kind === 'file'`，老数据就会因为空串而走进另一条分支。
 */
export function kindOf(row: NodeRow): 'note' | 'file' {
  return row.kind === 'file' ? 'file' : 'note';
}

/**
 * 节点内容文件的绝对路径。
 *
 * note 与 file 的落盘位置不同：笔记是 `.md` 文本，原件是保留原名的任意字节。
 * 凡是「这个节点的文件在哪」的提问都该走这里，别自己拼路径。
 */
function nodeFileOf(row: NodeRow): string {
  const slug = repoSlugOf(row.repo_id);
  return kindOf(row) === 'file' ? filePath(slug, row.path) : bodyPath(slug, row.path, row.encrypted === 1);
}

/**
 * 读原件的字节内容。
 *
 * 只有 kind='file' 的节点有字节内容：笔记的正文是 UTF-8 文本，
 * 走 readBody 那条路。加密的原件返回 undefined——盘上是密文，
 * 当成「内容」发出去等于把密文塞进响应里。
 */
export function readNodeBytes(id: string): Buffer | undefined {
  const row = db.prepare('SELECT * FROM nodes WHERE id = ?').get(id) as NodeRow | undefined;
  if (!row) return undefined;
  if (row.type !== 'file') return undefined;
  if (kindOf(row) !== 'file') return undefined;
  if (row.encrypted === 1) return undefined;
  try {
    return readFileSync(nodeFileOf(row));
  } catch {
    return undefined;
  }
}

/**
 * 读原件在盘上的字节，不管它是不是加密态。
 *
 * 加密态下盘上是密文：这个函数给「加密/解密原件」那条链路用——
 * 它要拿到的正是盘上那份东西（密文或明文），由调用方决定怎么解释。
 *
 * 想拿到「能直接发给用户的字节」请用 readNodeBytes：那个函数对加密态一律
 * 收手，避免调用方不小心把密文当内容发出去。
 */
export function readNodeRawBytes(id: string): Buffer | undefined {
  const row = db.prepare('SELECT * FROM nodes WHERE id = ?').get(id) as NodeRow | undefined;
  if (!row) return undefined;
  if (row.type !== 'file') return undefined;
  if (kindOf(row) !== 'file') return undefined;
  try {
    return readFileSync(nodeFileOf(row));
  } catch {
    return undefined;
  }
}

/**
 * 读正文。
 *
 * 加密文档一律返回 undefined：磁盘上存的是密文，把它当「正文」发出去，
 * 等于把密文塞进了接口响应里——看着像内容，其实谁也读不懂，
 * 却让「响应里有正文」这条约定彻底失效。
 *
 * 文件读不出来（被手工删了、磁盘出错）返回 undefined，不抛——
 * 一篇读不出正文的文档仍然是存在的，只是内容暂时取不到。
 */
function readBody(row: NodeRow): string | undefined {
  if (row.type !== 'file') return undefined;
  if (row.encrypted === 1) return undefined;
  return readFileSafe(bodyFileOf(row)) ?? undefined;
}

/**
 * 行 → 文档对象。
 *
 * withContent 决定要不要读正文：列表场景不读（几百个文件没必要全 IO 一遍），
 * 打开单篇时才读。
 */
export function rowToDoc(r: NodeRow, withContent = false): DocNode {
  const kind = kindOf(r);
  return {
    id: r.id,
    name: r.name,
    type: r.type,
    parentId: r.parent_id,
    content: withContent ? readBody(r) : undefined,
    size: r.size ?? undefined,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    createdBy: r.created_by,
    updatedBy: r.updated_by,
    tags: r.tags ? (JSON.parse(r.tags) as string[]) : undefined,
    repoId: r.repo_id,
    encrypted: r.encrypted === 1,
    lockedAt: r.enc_locked_at ?? undefined,
    kind,
    // 原件的格式信息只在 kind='file' 时有意义，note 不带这两项
    ...(kind === 'file' ? { mime: r.mime || undefined, ext: r.ext || undefined } : {}),
  };
}

/**
 * 读取全部文档（未按身份过滤），由调用方裁剪。
 *
 * 没有回收站：库里有的就是站上的，不在库里的一律已经删干净了。
 */
export function listAllDocs(): DocNode[] {
  return (
    db.prepare('SELECT * FROM nodes ORDER BY name COLLATE NOCASE').all() as NodeRow[]
  ).map((r) => rowToDoc(r));
}

/** 取文档（连同正文） */
export function getDoc(id: string): DocNode | undefined {
  const r = db.prepare('SELECT * FROM nodes WHERE id = ?').get(id) as NodeRow | undefined;
  return r ? rowToDoc(r, true) : undefined;
}

/**
 * 全文搜索：在标题与正文里找关键词。
 *
 * 走 FTS5 索引，不再是全表 LIKE。中文按二元组切分后建索引，
 * 搜「调试」能命中「真机调试」这种包含关系。
 *
 * 加密文档不在索引里——索引是给检索用的，把密文喂进去既没意义也危险。
 */
export function searchDocs(keyword: string, limit = 50): DocSearchHit[] {
  const q = keyword.trim();
  if (!q) return [];
  const hits = searchIndex(db, q, limit);
  if (!hits.length) return [];

  const lowerQ = q.toLowerCase();
  return hits
    .map((hit) => {
      const row = db.prepare('SELECT * FROM nodes WHERE id = ?').get(hit.node_id) as
        | NodeRow
        | undefined;
      if (!row) return undefined;
      const content = readBody(row) ?? '';
      const at = content.toLowerCase().indexOf(lowerQ);
      let snippet = '';
      if (at >= 0) {
        // 片段只取命中处前后的一小段：搜索页要回答的是「在哪出现过」
        const start = Math.max(0, at - 30);
        const end = Math.min(content.length, at + q.length + 90);
        snippet =
          (start > 0 ? '…' : '') +
          content.slice(start, end).replace(/\s+/g, ' ').trim() +
          (end < content.length ? '…' : '');
      }
      return {
        id: row.id,
        name: row.name,
        type: row.type,
        parentId: row.parent_id,
        snippet,
        matchedIn: row.name.toLowerCase().includes(lowerQ) ? 'name' : 'content',
        path: docPathOf(row),
        updatedAt: row.updated_at,
        tags: row.tags ? (JSON.parse(row.tags) as string[]) : undefined,
      } as DocSearchHit;
    })
    .filter((x): x is DocSearchHit => x !== undefined);
}

/**
 * 按索引召回文档（Agent 检索用）。
 *
 * 返回的是「索引里最相关的若干篇」，而不是全站文档：
 * 召回之后才去读正文，于是每次提问要读的文件从「全站」降到「十来篇」。
 *
 * score 取 bm25 的相反数：FTS5 的 rank 越小越相关，取反之后越大越相关，
 * 和检索单元的分数方向保持一致，合并排序时不用再翻转。
 */
export function recallDocIds(keyword: string, limit = 40): Array<{ id: string; score: number }> {
  return searchIndex(db, keyword, limit, undefined, 'recall').map((h) => ({
    id: h.node_id,
    score: -h.rank,
  }));
}

/**
 * 按索引召回附件。
 *
 * 与文档同一套机制，只是查的是 attachment_fts。
 */
export function recallAttachmentIds(
  keyword: string,
  limit = 40,
): Array<{ id: string; score: number }> {
  return searchAttachmentIndex(db, keyword, limit, undefined, 'recall').map((h) => ({
    id: h.att_id,
    score: -h.rank,
  }));
}

/** 文档所在目录的路径，如「产品手册 / 接口说明」 */
function docPathOf(row: NodeRow): string {
  const i = row.path.lastIndexOf('/');
  return i >= 0 ? row.path.slice(0, i).split('/').join(' / ') : '';
}

/**
 * 算一个节点在仓库里的路径。
 *
 * 路径 = 父路径 + 名字。同名冲突不覆盖别人，而是加序号：
 * 「同名」在文件系统里天然存在（不同目录下可以有同名文件），
 * 但同一个仓库里不行——UNIQUE(repo_id, path) 是硬约束。
 */
function computePath(repoId: string, parentId: string | null, name: string, excludeId?: string): string {
  let parentPath = '';
  if (parentId) {
    const parent = db.prepare('SELECT path FROM nodes WHERE id = ?').get(parentId) as
      | { path: string }
      | undefined;
    parentPath = parent?.path ?? '';
  }
  const base = parentPath ? `${parentPath}/${name}` : name;
  const taken = db.prepare('SELECT id FROM nodes WHERE repo_id = ? AND path = ?').get(repoId, base) as
    | { id: string }
    | undefined;
  if (!taken || taken.id === excludeId) return base;

  let n = 1;
  while (true) {
    const candidate = `${base}~${n}`;
    const hit = db.prepare('SELECT id FROM nodes WHERE repo_id = ? AND path = ?').get(repoId, candidate) as
      | { id: string }
      | undefined;
    if (!hit || hit.id === excludeId) return candidate;
    n += 1;
  }
}

/**
 * 没有指定仓库时的兜底：取库里最早建的那个仓库。
 *
 * v2 起文档必须有归属（nodes.repo_id NOT NULL），
 * 但调用方偶尔会忘了传——这时落到默认仓库，比直接失败更友好，
 * 总比让文档无处安放强。
 */
export function defaultRepoId(): string {
  const row = db.prepare('SELECT id FROM repos ORDER BY created_at LIMIT 1').get() as
    | { id: string }
    | undefined;
  if (!row) throw new Error('还没有任何仓库，请先创建一个仓库');
  return row.id;
}

/**
 * 写入正文文件并更新索引行的相关字段。
 *
 * 加密文档写的是密文——密文永远不落明文，
 * 连临时文件都不落（writeFileAtomic 先写临时文件再改名，
 * 临时文件里也只有密文）。
 */
function writeBody(
  row: Pick<NodeRow, 'id' | 'repo_id' | 'path' | 'encrypted'>,
  text: string,
): { size: number; hash: string } {
  const abs = bodyPath(repoSlugOf(row.repo_id), row.path, row.encrypted === 1);
  writeFileAtomic(abs, text);
  const size = Buffer.byteLength(text, 'utf8');
  return { size, hash: contentHash(text) };
}

/**
 * 新建文档（Markdown 笔记）。
 *
 * 正文先落文件、再插索引行：文件写失败就抛错，不会留下一行指向空文件的索引。
 */
export function insertDoc(doc: DocNode): DocNode {
  const repoId = doc.repoId || defaultRepoId();
  const path = computePath(repoId, doc.parentId, doc.name);
  const content = doc.content ?? '';
  const size = Buffer.byteLength(content, 'utf8');
  const hash = contentHash(content);

  const row: NodeRow = {
    id: doc.id,
    repo_id: repoId,
    name: doc.name,
    type: doc.type,
    parent_id: doc.parentId,
    path,
    size,
    content_hash: hash,
    kind: 'note',
    mime: '',
    ext: '',
    encrypted: doc.encrypted ? 1 : 0,
    enc_master_dek: null,
    enc_locked_at: doc.encrypted ? doc.lockedAt ?? null : null,
    acl: '{}',
    tags: doc.tags ? JSON.stringify(doc.tags) : null,
    created_at: doc.createdAt,
    updated_at: doc.updatedAt,
    created_by: doc.createdBy,
    updated_by: doc.updatedBy,
  };

  if (doc.type === 'file') {
    writeBody(row, content);
  }

  db.prepare(
    `INSERT INTO nodes (id, repo_id, name, type, parent_id, path, size, content_hash,
        kind, mime, ext,
        encrypted, enc_master_dek, enc_locked_at, acl, tags,
        created_at, updated_at, created_by, updated_by)
     VALUES (@id, @repo_id, @name, @type, @parent_id, @path, @size, @content_hash,
        @kind, @mime, @ext,
        @encrypted, @enc_master_dek, @enc_locked_at, @acl, @tags,
        @created_at, @updated_at, @created_by, @updated_by)`,
  ).run(row);

  if (doc.type === 'file' && !row.encrypted) {
    indexNode(db, doc.id, repoId, doc.name, content);
  }
  return { ...doc, repoId, kind: 'note' };
}

/**
 * 新建一个「原件」节点。
 *
 * 原件就是文件本身：zip 是 zip，图片是图片，PDF 是 PDF——
 * 不再为一个 zip 造一篇同名同格式的 Markdown 空壳，
 * 也不需要谁再给它配一份备注。节点名保留原文件名与扩展名，
 * 落盘时原样保存字节，因此下载回来的东西与上传时一模一样。
 *
 * 索引只写文件名：原件的内容是二进制，喂进 FTS 只会得到一堆乱码分词。
 * 想让原件可检索，正文抽取那是附件那条链路的事，与此无关。
 */
export function insertBinaryDoc(input: {
  id: string;
  repoId: string;
  name: string;
  parentId: string | null;
  mime: string;
  ext: string;
  data: Buffer;
  createdBy: string;
  createdAt?: number;
}): DocNode {
  const repoId = input.repoId || defaultRepoId();
  const path = computePath(repoId, input.parentId, input.name);
  const ts = input.createdAt ?? Date.now();

  const row: NodeRow = {
    id: input.id,
    repo_id: repoId,
    name: input.name,
    type: 'file',
    parent_id: input.parentId,
    path,
    size: input.data.length,
    content_hash: contentHash(input.data),
    kind: 'file',
    mime: input.mime,
    ext: input.ext,
    encrypted: 0,
    enc_master_dek: null,
    enc_locked_at: null,
    acl: '{}',
    tags: null,
    created_at: ts,
    updated_at: ts,
    created_by: input.createdBy,
    updated_by: input.createdBy,
  };

  // 字节先落盘，再插索引行：文件写失败就抛错，
  // 不会留下一行指向空文件的索引（那会让「文件在但下下来是 0 字节」成为常态）
  writeFileAtomic(filePath(repoSlugOf(repoId), path), input.data);

  db.prepare(
    `INSERT INTO nodes (id, repo_id, name, type, parent_id, path, size, content_hash,
        kind, mime, ext,
        encrypted, enc_master_dek, enc_locked_at, acl, tags,
        created_at, updated_at, created_by, updated_by)
     VALUES (@id, @repo_id, @name, @type, @parent_id, @path, @size, @content_hash,
        @kind, @mime, @ext,
        @encrypted, @enc_master_dek, @enc_locked_at, @acl, @tags,
        @created_at, @updated_at, @created_by, @updated_by)`,
  ).run(row);

  indexNode(db, row.id, repoId, row.name, '');
  return rowToDoc(row);
}

/**
 * 主密钥取不回数据密钥时抛出。
 *
 * 为什么不能在这里「跳过这次更新」：跳过会让整次保存看起来成功
 * （HTTP 200、返回旧文档），而正文其实还停在旧版本——用户以为存上了，
 * 打开一看内容没变，几轮下来才发现东西丢了。
 * 宁可让保存明确失败，也好过让它悄悄地不生效。
 */
export class DekUnavailableError extends Error {
  readonly code = 'dek-unavailable';
  constructor(docId: string) {
    super(`加密文档的数据密钥无法取回：${docId}`);
    this.name = 'DekUnavailableError';
  }
}

/**
 * 改文档。
 *
 * 三类改动分别落到三处：
 *   - 改名字或换父目录 → 路径变了，正文文件要搬家（子孙的路径也跟着变）；
 *   - 改正文 → 重写文件，明文的还要重建索引；
 *   - 改标签 → 只动索引行。
 */
export function updateDocRow(id: string, patch: Partial<DocNode>, userId: string): boolean {
  const row = db.prepare('SELECT * FROM nodes WHERE id = ?').get(id) as NodeRow | undefined;
  if (!row) return false;

  const sets: string[] = [];
  const params: Record<string, unknown> = { id, updatedAt: Date.now(), updatedBy: userId };
  // 改名或换目录后，正文文件落在新路径上——先记下来，后面的写入都要用它
  let targetPath = row.path;
  let targetName = row.name;

  // ---- 名字 / 父节点变动 → 路径与文件都要动 ----
  const newName = patch.name !== undefined ? patch.name : row.name;
  const newParent = patch.parentId !== undefined ? patch.parentId : row.parent_id;
  const nameOrParentChanged = newName !== row.name || newParent !== row.parent_id;

  if (nameOrParentChanged) {
    const newPath = computePath(row.repo_id, newParent, newName, row.id);
    if (newPath !== row.path) {
      const slug = repoSlugOf(row.repo_id);
      // 笔记与原件的落盘位置不同，搬家时要走各自的通道
      if (kindOf(row) === 'file') {
        moveFileAt(filePath(slug, row.path), filePath(slug, newPath));
      } else {
        moveBodyFile(slug, row.path, slug, newPath, row.encrypted === 1);
      }
      // 附件的位置里嵌着宿主的路径，宿主换地方了附件也得跟着换
      relocateAttachmentFiles(id, { slug, path: row.path }, { slug, path: newPath });
      sets.push('path = @path');
      params.path = newPath;
      targetPath = newPath;
      // 子孙的路径都带着旧前缀，得一起挪
      rebaseSubtreePaths(row, newPath);
    }
    if (newName !== row.name) {
      sets.push('name = @name');
      params.name = newName;
      targetName = newName;
    }
    if (newParent !== row.parent_id) {
      sets.push('parent_id = @parentId');
      params.parentId = newParent;
    }
  }

  // ---- 正文变动 ----
  if (patch.content !== undefined) {
    // 原件不是 Markdown 正文，不能当文本改写。
    // 明确失败比悄悄忽略强：否则调用方以为存上了，打开一看内容还是旧的。
    if (kindOf(row) === 'file') {
      throw new Error('原件不支持正文编辑：要改内容请重新上传文件');
    }
    const text = String(patch.content ?? '');
    if (row.encrypted === 1) {
      // 加密文档的正文绝不以明文落盘：用主密钥取回数据密钥，重新加密后写文件。
      // 取不到数据密钥（主密钥被改过等）时宁可放弃这次更新，也不能把明文写出去。
      const dek = row.enc_master_dek ? unwrapDekWithMaster(row.enc_master_dek, MASTER_KEY) : null;
      if (!dek) {
        logger.error('加密文档的数据密钥无法取回，本次内容更新已中止', id);
        throw new DekUnavailableError(id);
      }
      const cipher = encryptDocContentWithDek(text, dek);
      const abs = bodyPath(repoSlugOf(row.repo_id), targetPath, true);
      writeFileAtomic(abs, cipher);
      sets.push('size = @size', 'content_hash = @hash');
      params.size = Buffer.byteLength(cipher, 'utf8');
      params.hash = contentHash(cipher);
    } else {
      const abs = bodyPath(repoSlugOf(row.repo_id), targetPath, false);
      writeFileAtomic(abs, text);
      sets.push('size = @size', 'content_hash = @hash');
      params.size = Buffer.byteLength(text, 'utf8');
      params.hash = contentHash(text);
      indexNode(db, id, row.repo_id, targetName, text);
    }
  } else if (targetName !== row.name && row.type === 'file' && row.encrypted !== 1) {
    // 只改了名字：正文没动，但索引里的名字列得跟着改，
    // 否则「按新名字搜」搜不到这篇——索引里躺的还是旧名字。
    indexNode(db, id, row.repo_id, targetName, readBody({ ...row, path: targetPath }) ?? '');
  }

  // ---- 标签 ----
  if (patch.tags !== undefined) {
    sets.push('tags = @tags');
    params.tags = patch.tags ? JSON.stringify(patch.tags) : null;
  }

  if (!sets.length) return false;
  sets.push('updated_at = @updatedAt', 'updated_by = @updatedBy');
  return db.prepare(`UPDATE nodes SET ${sets.join(', ')} WHERE id = @id`).run(params).changes > 0;
}

/**
 * 节点改名或换目录后，把子孙的路径一起改过来。
 *
 * 子孙路径 = 旧前缀 + 自身相对路径。逐个改而不是重算，
 * 是为了保持它们之间的相对结构不变。
 */
function rebaseSubtreePaths(row: NodeRow, newPath: string): void {
  const oldPrefix = row.path;
  const slug = repoSlugOf(row.repo_id);
  const children = db
    .prepare('SELECT * FROM nodes WHERE parent_id = ?')
    .all(row.id) as NodeRow[];
  const update = db.prepare('UPDATE nodes SET path = ? WHERE id = ?');
  for (const child of children) {
    const childNew = child.path.startsWith(`${oldPrefix}/`)
      ? `${newPath}${child.path.slice(oldPrefix.length)}`
      : computePath(child.repo_id, row.id, child.name, child.id);
    // 正文文件与附件文件都要跟着搬：只改库里的路径而文件留在原地，
    // 打开那篇子文档就只剩空正文了——这种「看着还在、其实没了」的故障
    // 比直接报错更难查。
    if (kindOf(child) === 'file') {
      moveFileAt(filePath(slug, child.path), filePath(slug, childNew));
    } else {
      moveBodyFile(slug, child.path, slug, childNew, child.encrypted === 1);
    }
    relocateAttachmentFiles(child.id, { slug, path: child.path }, { slug, path: childNew });
    update.run(childNew, child.id);
    rebaseSubtreePaths({ ...child, path: childNew }, childNew);
  }
}

/**
 * 把一篇文档的附件搬到新的仓库/路径下。
 *
 * 附件的位置里嵌着宿主的路径与仓库，所以文档搬家时附件必须跟着搬：
 * 不搬的话，原仓库一删，附件就只剩一行元数据、二进制没了。
 */
function relocateAttachmentFiles(
  docId: string,
  from: { slug: string; path: string },
  to: { slug: string; path: string },
): void {
  const rows = db
    .prepare('SELECT id, name FROM attachments WHERE doc_id = ?')
    .all(docId) as Array<{ id: string; name: string }>;
  if (!rows.length) return;
  const update = db.prepare('UPDATE attachments SET storage_key = ? WHERE id = ?');
  for (const r of rows) {
    moveAssetFile(from.slug, from.path, to.slug, to.path, r.name);
    update.run(`${to.slug}/assets/${to.path}/${r.name}`, r.id);
  }
}

/* ------------------------------ 文档加密读写 ------------------------------ */

/**
 * 读取一行的原始列（含加密材料）。
 * 对外只给服务端内部用：这些列一旦外泄，密文的安全性就只剩主密钥一道。
 */
export function getDocEncryptionRow(id: string): NodeRow | undefined {
  return db.prepare('SELECT * FROM nodes WHERE id = ?').get(id) as NodeRow | undefined;
}

/**
 * 读出加密文档的密文正文。
 *
 * 密文住在 .enc 文件里（正文不进库），所以这里读文件而不是查列。
 * 解密要用主密钥取回数据密钥，这一步由调用方做。
 */
export function readDocCipher(id: string): string | undefined {
  const row = db
    .prepare('SELECT * FROM nodes WHERE id = ? AND encrypted = 1')
    .get(id) as NodeRow | undefined;
  if (!row) return undefined;
  return readFileSafe(bodyPath(repoSlugOf(row.repo_id), row.path, true)) ?? undefined;
}

/**
 * 把文档置为加密态。
 *
 * 正文文件从 .md 换成 .md.enc，里面只有密文：
 * 拷走整个 vault 也不会泄露内容。
 *
 * 加密文档对访客仍然可见（否则访客连「申请访问」的入口都看不到），
 * 但访客拿到的响应里 content 为空——可见不等于可读。
 *
 * 只写两份材料：正文密文，与被主密钥包裹的数据密钥。
 * 没有任何访客口令被派生或落库。
 */
export function encryptDocRow(
  id: string,
  material: EncryptedDocMaterial,
  userId: string,
): boolean {
  const row = db.prepare('SELECT * FROM nodes WHERE id = ?').get(id) as NodeRow | undefined;
  if (!row) return false;
  const ts = Date.now();

  // 密文写进 .enc 文件，原来的明文文件删掉——不留明文残留
  const encAbs = bodyPath(repoSlugOf(row.repo_id), row.path, true);
  writeFileAtomic(encAbs, material.cipher);
  removeBodyFile(repoSlugOf(row.repo_id), row.path, false);

  const changed = db
    .prepare(
      `UPDATE nodes SET encrypted = 1, enc_master_dek = @masterWrappedDek,
         enc_locked_at = @lockedAt, size = @size, content_hash = @hash,
         updated_at = @updatedAt, updated_by = @updatedBy
       WHERE id = @id`,
    )
    .run({
      id,
      masterWrappedDek: material.masterWrappedDek,
      lockedAt: ts,
      size: Buffer.byteLength(material.cipher, 'utf8'),
      hash: contentHash(material.cipher),
      updatedAt: ts,
      updatedBy: userId,
    }).changes;

  // 加密后正文不再能被检索：从索引里撤掉
  unindexNode(db, id);
  return changed > 0;
}

/** 取消加密：明文写回 .md 文件，加密材料全部清空 */
export function decryptDocRow(id: string, plain: string, userId: string): boolean {
  const row = db.prepare('SELECT * FROM nodes WHERE id = ?').get(id) as NodeRow | undefined;
  if (!row) return false;
  const ts = Date.now();

  const plainAbs = bodyPath(repoSlugOf(row.repo_id), row.path, false);
  writeFileAtomic(plainAbs, plain);
  removeBodyFile(repoSlugOf(row.repo_id), row.path, true);

  const changed = db
    .prepare(
      `UPDATE nodes SET encrypted = 0, enc_master_dek = NULL, enc_locked_at = NULL,
         size = @size, content_hash = @hash,
         updated_at = @updatedAt, updated_by = @updatedBy
       WHERE id = @id`,
    )
    .run({
      id,
      size: Buffer.byteLength(plain, 'utf8'),
      hash: contentHash(plain),
      updatedAt: ts,
      updatedBy: userId,
    }).changes;

  if (row.type === 'file') {
    indexNode(db, id, row.repo_id, row.name, plain);
  }
  return changed > 0;
}

/**
 * 把原件置为加密态：盘上的字节换成密文。
 *
 * 与正文的加密是同一套信封，只是载荷从 UTF-8 文本换成任意字节。
 *
 * 为什么必须真的加密字节：把 zip 标成「已加密」却让它继续以明文躺在磁盘上，
 * 是给用户一个「它加密了」的错觉——真出事时，拖走 vault 的人照样拿得到内容。
 * 加密态下原件不参与检索（索引里只留过文件名，本来也没有正文可检索）。
 */
export function encryptBinaryDocRow(
  id: string,
  material: EncryptedDocMaterial,
  userId: string,
): boolean {
  const row = db.prepare('SELECT * FROM nodes WHERE id = ?').get(id) as NodeRow | undefined;
  if (!row) return false;
  if (kindOf(row) !== 'file') return false;
  const ts = Date.now();

  // 密文覆盖原文件：原子写，不会出现「写了一半」的中间态
  writeFileAtomic(nodeFileOf(row), Buffer.from(material.cipher, 'utf8'));

  const changed = db
    .prepare(
      `UPDATE nodes SET encrypted = 1, enc_master_dek = @masterWrappedDek,
         enc_locked_at = @lockedAt, size = @size, content_hash = @hash,
         updated_at = @updatedAt, updated_by = @updatedBy
       WHERE id = @id`,
    )
    .run({
      id,
      masterWrappedDek: material.masterWrappedDek,
      lockedAt: ts,
      size: Buffer.byteLength(material.cipher, 'utf8'),
      hash: contentHash(material.cipher),
      updatedAt: ts,
      updatedBy: userId,
    }).changes;

  unindexNode(db, id);
  return changed > 0;
}

/** 取消原件加密：明文字节写回磁盘，加密材料全部清空 */
export function decryptBinaryDocRow(id: string, plain: Buffer, userId: string): boolean {
  const row = db.prepare('SELECT * FROM nodes WHERE id = ?').get(id) as NodeRow | undefined;
  if (!row) return false;
  if (kindOf(row) !== 'file') return false;
  const ts = Date.now();

  writeFileAtomic(nodeFileOf(row), plain);

  const changed = db
    .prepare(
      `UPDATE nodes SET encrypted = 0, enc_master_dek = NULL, enc_locked_at = NULL,
         size = @size, content_hash = @hash,
         updated_at = @updatedAt, updated_by = @updatedBy
       WHERE id = @id`,
    )
    .run({
      id,
      size: plain.length,
      hash: contentHash(plain),
      updatedAt: ts,
      updatedBy: userId,
    }).changes;

  // 原件的索引里只有文件名，本来就没进过 FTS，这里无需重建
  return changed > 0;
}

/* --------------------------- 访客会话与访问授权 --------------------------- */

export interface GuestSessionRow {
  id: string;
  name: string;
  created_at: number;
  last_seen_at: number;
}

export interface AccessRequestRow {
  id: string;
  doc_id: string;
  guest_id: string;
  guest_name: string;
  reason: string;
  status: 'pending' | 'approved' | 'rejected';
  created_at: number;
  decided_at: number | null;
  decided_by: string | null;
  expires_at: number | null;
}

export interface AccessGrantRow {
  id: string;
  doc_id: string;
  guest_id: string;
  guest_name: string;
  granted_at: number;
  granted_by: string;
  expires_at: number | null;
  revoked_at: number | null;
  /** 这条授权允许的动作（JSON 数组字符串）。老库补列后是空串，按 ['view'] 处理 */
  capabilities: string;
}

/**
 * 把库里存的能力串解析成能力数组。
 *
 * 老库补列时拿不到 DEFAULT '["view"]'（会补成空串），
 * 空串与解析失败一律退回到「只读」——权限在默认方向上收紧。
 */
export function parseCapabilities(raw: string | null | undefined): AccessCapability[] {
  if (!raw) return ['view'];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return ['view'];
    const valid = parsed.filter((c): c is AccessCapability => c === 'view' || c === 'download');
    // 一条什么都做不了的授权等于没有授权
    return valid.length ? valid : ['view'];
  } catch {
    return ['view'];
  }
}

/** 能力数组存回库里的字符串形式 */
export function serializeCapabilities(caps: AccessCapability[]): string {
  const valid = caps.filter((c) => c === 'view' || c === 'download');
  return JSON.stringify(valid.length ? valid : ['view']);
}

/** 访客会话：cookie 里的 sid 对应的一行 */
export function getGuestSession(id: string): GuestSessionRow | undefined {
  return db.prepare('SELECT * FROM guest_sessions WHERE id = ?').get(id) as GuestSessionRow | undefined;
}

export function createGuestSession(id: string, name: string): GuestSessionRow {
  const ts = Date.now();
  db.prepare(
    'INSERT OR REPLACE INTO guest_sessions (id, name, created_at, last_seen_at) VALUES (?, ?, ?, ?)',
  ).run(id, name, ts, ts);
  return { id, name, created_at: ts, last_seen_at: ts };
}

export function touchGuestSession(id: string, ts: number): void {
  db.prepare('UPDATE guest_sessions SET last_seen_at = ? WHERE id = ?').run(ts, id);
}

/** 访客改自己的昵称：申请与审批单上显示的就是它 */
export function renameGuestSession(id: string, name: string): boolean {
  return (
    db.prepare('UPDATE guest_sessions SET name = ? WHERE id = ?').run(name, id).changes > 0
  );
}

export function insertAccessRequest(row: {
  id: string;
  docId: string;
  guestId: string;
  guestName: string;
  reason: string;
}): AccessRequestRow {
  const ts = Date.now();
  db.prepare(
    `INSERT INTO access_requests (id, doc_id, guest_id, guest_name, reason, status, created_at)
     VALUES (@id, @docId, @guestId, @guestName, @reason, 'pending', @createdAt)`,
  ).run({ ...row, createdAt: ts });
  return {
    id: row.id,
    doc_id: row.docId,
    guest_id: row.guestId,
    guest_name: row.guestName,
    reason: row.reason,
    status: 'pending',
    created_at: ts,
    decided_at: null,
    decided_by: null,
    expires_at: null,
  };
}

export function getAccessRequest(id: string): AccessRequestRow | undefined {
  return db.prepare('SELECT * FROM access_requests WHERE id = ?').get(id) as AccessRequestRow | undefined;
}

/** 同一访客对同一文档的未决申请：用来挡住重复提交 */
export function findPendingRequest(docId: string, guestId: string): AccessRequestRow | undefined {
  return db
    .prepare("SELECT * FROM access_requests WHERE doc_id = ? AND guest_id = ? AND status = 'pending'")
    .get(docId, guestId) as AccessRequestRow | undefined;
}

/** 某访客对某文档最近一次被拒的申请：让他知道「被拒过」而不是「从没申请过」 */
export function findLatestRequest(docId: string, guestId: string): AccessRequestRow | undefined {
  return db
    .prepare('SELECT * FROM access_requests WHERE doc_id = ? AND guest_id = ? ORDER BY created_at DESC')
    .get(docId, guestId) as AccessRequestRow | undefined;
}

/**
 * 申请列表（管理员用），带出文档名。
 *
 * 排序：待处理在前、新的在前——管理员打开面板先看最该处理的那条。
 */
export function listAccessRequests(filter: {
  status?: 'pending' | 'approved' | 'rejected' | 'all';
  docId?: string;
}): Array<AccessRequestRow & { doc_name: string }> {
  const where: string[] = [];
  const params: Record<string, string> = {};
  if (filter.status && filter.status !== 'all') {
    where.push('r.status = @status');
    params.status = filter.status;
  }
  if (filter.docId) {
    where.push('r.doc_id = @docId');
    params.docId = filter.docId;
  }
  const sql = `SELECT r.*, d.name AS doc_name FROM access_requests r
      LEFT JOIN nodes d ON d.id = r.doc_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY CASE r.status WHEN 'pending' THEN 0 ELSE 1 END, r.created_at DESC`;
  return db.prepare(sql).all(params) as Array<AccessRequestRow & { doc_name: string }>;
}

export function decideAccessRequest(
  id: string,
  status: 'approved' | 'rejected',
  by: string,
  expiresAt: number | null,
): boolean {
  return (
    db
      .prepare(
        `UPDATE access_requests SET status = @status, decided_at = @decidedAt, decided_by = @decidedBy,
           expires_at = @expiresAt WHERE id = @id`,
      )
      .run({ id, status, decidedAt: Date.now(), decidedBy: by, expiresAt }).changes > 0
  );
}

export function insertAccessGrant(row: {
  id: string;
  docId: string;
  guestId: string;
  guestName: string;
  grantedBy: string;
  expiresAt: number | null;
  capabilities?: AccessCapability[];
}): AccessGrantRow {
  const ts = Date.now();
  const capabilities = serializeCapabilities(row.capabilities ?? ['view']);
  db.prepare(
    `INSERT INTO access_grants (id, doc_id, guest_id, guest_name, granted_at, granted_by, expires_at, capabilities)
     VALUES (@id, @docId, @guestId, @guestName, @grantedAt, @grantedBy, @expiresAt, @capabilities)`,
  ).run({ ...row, grantedAt: ts, capabilities });
  return {
    id: row.id,
    doc_id: row.docId,
    guest_id: row.guestId,
    guest_name: row.guestName,
    granted_at: ts,
    granted_by: row.grantedBy,
    expires_at: row.expiresAt,
    revoked_at: null,
    capabilities,
  };
}

/* ------------------------------ 访问审计 ------------------------------ */

/**
 * 记一条访问审计。
 *
 * 权限一旦授出，真正需要回答的问题是「谁在什么时候看过、拿走过什么」——
 * 而这个问题只有流水答得上来。写审计失败不该阻断主流程，
 * 因此这里吞掉异常：审计是辅助账，不是主账。
 */
export function insertAccessAudit(row: {
  id?: string;
  docId: string;
  action: AccessAuditAction;
  actorId?: string;
  actorName?: string;
  detail?: string;
}): void {
  try {
    db.prepare(
      `INSERT INTO access_audit (id, doc_id, action, actor_id, actor_name, detail, created_at)
       VALUES (@id, @docId, @action, @actorId, @actorName, @detail, @createdAt)`,
    ).run({
      id: row.id ?? randomUUID(),
      docId: row.docId,
      action: row.action,
      actorId: row.actorId ?? '',
      actorName: row.actorName ?? '',
      detail: row.detail ?? '',
      createdAt: Date.now(),
    });
  } catch (err) {
    logger.warn('写入访问审计失败', row.docId, row.action, err);
  }
}

/**
 * 访问审计列表（管理员用）。
 *
 * docId 传了就只看这一篇；不传看全部。新的在前——审计是流水，越近的越该先看到。
 */
export function listAccessAudit(docId?: string): Array<{
  id: string;
  doc_id: string;
  doc_name?: string;
  action: AccessAuditAction;
  actor_id: string;
  actor_name: string;
  detail: string;
  created_at: number;
}> {
  const sql = docId
    ? `SELECT a.*, d.name AS doc_name FROM access_audit a
         LEFT JOIN nodes d ON d.id = a.doc_id
        WHERE a.doc_id = ? ORDER BY a.created_at DESC LIMIT 500`
    : `SELECT a.*, d.name AS doc_name FROM access_audit a
         LEFT JOIN nodes d ON d.id = a.doc_id
        ORDER BY a.created_at DESC LIMIT 500`;
  const params = docId ? [docId] : [];
  return db.prepare(sql).all(...params) as Array<{
    id: string;
    doc_id: string;
    doc_name?: string;
    action: AccessAuditAction;
    actor_id: string;
    actor_name: string;
    detail: string;
    created_at: number;
  }>;
}

/** 某文档的授权名单（含已撤销的，用于「谁曾经能看」的历史） */
export function listAccessGrants(docId: string): Array<AccessGrantRow & { doc_name?: string }> {
  return db
    .prepare('SELECT * FROM access_grants WHERE doc_id = ? ORDER BY granted_at DESC')
    .all(docId) as Array<AccessGrantRow & { doc_name?: string }>;
}

/** 全部有效授权（管理员总览用） */
export function listAllAccessGrants(): Array<AccessGrantRow & { doc_name: string }> {
  return db
    .prepare(
      `SELECT g.*, d.name AS doc_name FROM access_grants g
       LEFT JOIN nodes d ON d.id = g.doc_id
       ORDER BY g.granted_at DESC`,
    )
    .all() as Array<AccessGrantRow & { doc_name: string }>;
}

/**
 * 查访客对某文档是否持有有效授权。
 *
 * 「有效」= 未撤销且未过期。过期与撤销在这里是同一件事：
 * 管理员点撤销之后，这条授权对访客就该立刻不存在。
 */
export function findActiveGrant(docId: string, guestId: string): AccessGrantRow | undefined {
  const now = Date.now();
  const row = db
    .prepare(
      `SELECT * FROM access_grants
        WHERE doc_id = ? AND guest_id = ? AND revoked_at IS NULL
          AND (expires_at IS NULL OR expires_at > ?)
        ORDER BY granted_at DESC LIMIT 1`,
    )
    .get(docId, guestId, now) as AccessGrantRow | undefined;
  return row;
}

export function revokeAccessGrant(id: string): boolean {
  return (
    db.prepare('UPDATE access_grants SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(
      Date.now(),
      id,
    ).changes > 0
  );
}

/** 取一条授权（撤销时需要知道它属于谁、属于哪篇文档） */
export function getAccessGrant(id: string): AccessGrantRow | undefined {
  return db.prepare('SELECT * FROM access_grants WHERE id = ?').get(id) as AccessGrantRow | undefined;
}

/**
 * 调整一条授权的口子大小与有效期。
 *
 * 批准时给错能力是常事（本想只给查看，却顺手勾了下载）。
 * 撤销再重批也能改，但那样会把中间那段的口子状态从流水里抹掉——
 * 「那段时间到底能不能下载」就再也查不出来。
 * 直接改能力、并另留一条 adjust 审计，才是对现状的如实记录。
 *
 * 已撤销的授权不再改：它是历史，不是当前状态。
 */
export function updateAccessGrant(
  id: string,
  capabilities: AccessCapability[],
  expiresAt: number | null,
): boolean {
  return (
    db
      .prepare(
        `UPDATE access_grants SET capabilities = ?, expires_at = ?
          WHERE id = ? AND revoked_at IS NULL`,
      )
      .run(serializeCapabilities(capabilities), expiresAt, id).changes > 0
  );
}

/**
 * 批量批准访问申请。
 *
 * 「一次只批一条」在多篇加密文档的场景下很常见：同一个访客对 4 篇文档
 * 各提了一次申请，管理员就得连点 4 次「批准」、挨个选有效期。
 * 这里把批准做成事务里的一组操作：逐条判定该批不该批，该批的批，
 * 不该批的给出原因——整体要么都成，要么都不动。
 *
 * 批准动作同时写两张表（access_grants 记授权、access_requests 改状态），
 * 放在同一个事务里才不会出「授权建了但申请还挂着」这种半截状态。
 */
export function bulkApproveAccessRequests(
  ids: string[],
  by: string,
  expiresAt: number | null,
  capabilities?: AccessCapability[],
): { approved: number; skipped: Array<{ id: string; reason: string }> } {
  const approved: string[] = [];
  const skipped: Array<{ id: string; reason: string }> = [];
  const ts = Date.now();
  const caps = serializeCapabilities(capabilities ?? ['view']);

  const insert = db.prepare(
    `INSERT INTO access_grants (id, doc_id, guest_id, guest_name, granted_at, granted_by, expires_at, capabilities)
     VALUES (@id, @docId, @guestId, @guestName, @grantedAt, @grantedBy, @expiresAt, @capabilities)`,
  );
  const decide = db.prepare(
    `UPDATE access_requests SET status = 'approved', decided_at = @decidedAt, decided_by = @decidedBy,
       expires_at = @expiresAt WHERE id = @id`,
  );

  db.transaction(() => {
    for (const id of ids) {
      const req = db.prepare('SELECT * FROM access_requests WHERE id = ?').get(id) as
        | AccessRequestRow
        | undefined;
      if (!req) {
        skipped.push({ id, reason: '申请不存在' });
        continue;
      }
      if (req.status !== 'pending') {
        skipped.push({ id, reason: '该申请已被处理过' });
        continue;
      }
      const doc = getDoc(req.doc_id);
      if (!doc) {
        skipped.push({ id, reason: '文档已删除' });
        continue;
      }
      if (!doc.encrypted) {
        skipped.push({ id, reason: '该文档已取消加密' });
        continue;
      }
      insert.run({
        id: randomUUID(),
        docId: req.doc_id,
        guestId: req.guest_id,
        guestName: req.guest_name,
        grantedAt: ts,
        grantedBy: by,
        expiresAt,
        capabilities: caps,
      });
      decide.run({ id, decidedAt: ts, decidedBy: by, expiresAt });
      approved.push(id);
    }
  })();

  return { approved: approved.length, skipped };
}

/**
 * 直接批量授权：给某个访客在多篇文档上同时开口子。
 *
 * 与 bulkApproveAccessRequests 的区别：这条不经过申请。
 * 管理员已经知道该给谁看哪几篇时（例如「把整个项目测试目录给某某」），
 * 没必要先制造一堆申请单再逐条批准。
 */
export function bulkInsertAccessGrants(
  rows: Array<{
    docId: string;
    guestId: string;
    guestName: string;
    grantedBy: string;
    expiresAt: number | null;
    capabilities?: AccessCapability[];
  }>,
): number {
  if (rows.length === 0) return 0;
  const ts = Date.now();
  const insert = db.prepare(
    `INSERT INTO access_grants (id, doc_id, guest_id, guest_name, granted_at, granted_by, expires_at, capabilities)
     VALUES (@id, @docId, @guestId, @guestName, @grantedAt, @grantedBy, @expiresAt, @capabilities)`,
  );
  db.transaction(() => {
    for (const r of rows) {
      insert.run({
        id: randomUUID(),
        docId: r.docId,
        guestId: r.guestId,
        guestName: r.guestName,
        grantedAt: ts,
        grantedBy: r.grantedBy,
        expiresAt: r.expiresAt,
        capabilities: serializeCapabilities(r.capabilities ?? ['view']),
      });
    }
  })();
  return rows.length;
}

/**
 * 所有已知访客：从申请与授权两边聚合出来。
 *
 * 访客没有账号，名字又是自己填的，管理员要批量授权时需要一个「选谁」的清单。
 * 这里把两边出现过的访客合并去重，按最近一次出现的时间倒序。
 */
export function listKnownGuests(): Array<{ id: string; name: string }> {
  const rows = db
    .prepare(
      `SELECT guest_id AS id, MAX(guest_name) AS name, MAX(last_seen) AS lastSeen FROM (
         SELECT guest_id, guest_name, created_at AS last_seen FROM access_requests
         UNION ALL
         SELECT guest_id, guest_name, granted_at AS last_seen FROM access_grants
       ) GROUP BY guest_id ORDER BY lastSeen DESC`,
    )
    .all() as Array<{ id: string; name: string; lastSeen: number }>;
  return rows.map((r) => ({ id: r.id, name: r.name }));
}

/** 待处理申请数：给管理端入口显示个角标，管理员不必点开才知道有人等着 */
export function countPendingAccessRequests(): number {
  const row = db.prepare("SELECT COUNT(*) AS n FROM access_requests WHERE status = 'pending'").get() as {
    n: number;
  };
  return row.n;
}

/**
 * 清掉一篇文档上的全部申请与授权。
 *
 * 取消加密后访客本来就能直接读了，再留着「某某有该文档权限」的记录只会
 * 让管理端显示出一堆已经不成立的授权。
 */
export function clearDocAccess(docId: string): void {
  db.transaction(() => {
    db.prepare('DELETE FROM access_grants WHERE doc_id = ?').run(docId);
    db.prepare('DELETE FROM access_requests WHERE doc_id = ?').run(docId);
  })();
}

/** 收集自身与全部后代 id */
export function collectSubtreeIds(rootId: string): string[] {
  const all = db.prepare('SELECT id, parent_id FROM nodes').all() as {
    id: string;
    parent_id: string | null;
  }[];
  const childrenOf = new Map<string, string[]>();
  all.forEach((r) => {
    if (!r.parent_id) return;
    const list = childrenOf.get(r.parent_id);
    if (list) list.push(r.id);
    else childrenOf.set(r.parent_id, [r.id]);
  });
  const result: string[] = [];
  const queue = [rootId];
  while (queue.length) {
    const cur = queue.shift()!;
    result.push(cur);
    (childrenOf.get(cur) ?? []).forEach((c) => queue.push(c));
  }
  return result;
}

/**
 * 摘掉一棵子树在库里的痕迹，并列出还留在盘上的文件。
 *
 * 删库和删盘得分开：Windows 上 unlink 一个文件要一百多毫秒——杀软要逐个
 * 扫一遍才肯放手——一个装着几十个文件的文件夹删完就是好几秒。这几秒里
 * 请求线程被占着，整个 API 都在打转，前端只能干等，用户看到的就是
 * 「点了删除，什么都没发生」。
 *
 * 这里只负责「库里的痕迹」和「该删哪些文件、哪些空目录」；盘上的清理由调用方安排：
 * 改名挪进暂存区，再让清道夫线程去删（见 vault.ts）。
 */
export function detachSubtree(rootId: string): { removed: number; files: string[]; dirs: string[] } {
  const ids = collectSubtreeIds(rootId);
  if (!ids.length) return { removed: 0, files: [], dirs: [] };

  // 文件路径先收走：附件行会被外键 CASCADE 连带删掉，之后就再也查不到它的存储路径了
  const attachmentFiles = collectAttachmentFiles(ids);
  const attachmentIds = (
    db
      .prepare(`SELECT id FROM attachments WHERE doc_id IN (${ids.map(() => '?').join(',')})`)
      .all(...ids) as Array<{ id: string }>
  ).map((r) => r.id);
  const nodes = db
    .prepare(`SELECT * FROM nodes WHERE id IN (${ids.map(() => '?').join(',')})`)
    .all(...ids) as NodeRow[];

  db.transaction(() => {
    db.prepare(`DELETE FROM nodes WHERE id IN (${ids.map(() => '?').join(',')})`).run(...ids);
    for (const id of ids) unindexNode(db, id);
    for (const id of attachmentIds) unindexAttachment(db, id);
  })();

  // 行删完了，路径也就定下来了：这些就是该从盘上抹掉的东西
  const files: string[] = [];
  // 文件夹删掉后占的目录会空下来，顺手记下来，等会儿连目录一起收掉
  const dirs: string[] = [];
  for (const node of nodes) {
    if (kindOf(node) === 'file') {
      files.push(filePath(repoSlugOf(node.repo_id), node.path));
    } else {
      files.push(bodyPath(repoSlugOf(node.repo_id), node.path, node.encrypted === 1));
      dirs.push(...folderDirs(repoSlugOf(node.repo_id), node.path));
    }
  }
  files.push(...attachmentFiles);
  return { removed: ids.length, files, dirs };
}

/**
 * 导入载荷里的一处不合格。
 *
 * `at` 指向出问题的文档（没有 id 时用序号），`reason` 是人话原因——
 * 报错要说清楚「哪里不对」，不然调用方只能对着一个 400 干瞪眼。
 */
export interface ImportProblem {
  at: string;
  reason: string;
}

/** 导入时给缺失的作者兜底 */
const IMPORT_ACTOR = 'u-admin';

/**
 * 名字能不能当路径段用。
 *
 * 正文要落到 `vault/<仓库>/docs/<名字>` 里，名字里带斜杠就会凭空多出一层目录，
 * 带 `..` 就可能踩到仓库外面去。Windows 那套保留字符同样不能碰。
 */
function isSafeDocName(name: string): boolean {
  if (!name || name === '.' || name === '..') return false;
  if (name.endsWith('.')) return false; // Windows 会悄悄去掉尾点，路径就对不上了
  if (/[\\/:*?"<>|]/.test(name)) return false; // Windows 非法字符
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f]/.test(name)) return false; // 控制字符
  return true;
}

/**
 * 找出导入载荷里的毛病。
 *
 * 为什么要先看载荷再动手：覆盖式导入是「全量替换」，
 * 中途出岔子的代价是整个资料库没了——库里空了，盘上的内容也找不回来。
 * 与其让它崩在半路，不如在动手之前把不合格的挑出来，原样退回。
 *
 * 只挑「真的没法用」的：
 *   - id、名字、类型、父子关系决定内容落在哪，猜不出来，只能退回；
 *   - 时间戳与作者缺了可以兜底（迁移的首要目标是「把内容搬过来」），
 *     所以不算毛病，只在整理载荷时补上。
 */
export function findImportProblems(raw: unknown[]): ImportProblem[] {
  const problems: ImportProblem[] = [];
  const seen = new Map<string, number>();
  const ids = new Set<string>();

  raw.forEach((item, i) => {
    const at = `#${i}`;
    if (!item || typeof item !== 'object') {
      problems.push({ at, reason: '不是对象' });
      return;
    }
    const d = item as Record<string, unknown>;
    const label = typeof d.id === 'string' && d.id ? d.id : at;

    if (typeof d.id !== 'string' || !d.id.trim()) {
      problems.push({ at, reason: '缺少 id' });
    } else if (seen.has(d.id)) {
      problems.push({ at: label, reason: `id 与第 ${(seen.get(d.id) ?? 0) + 1} 篇重复` });
    } else {
      seen.set(d.id, i);
      ids.add(d.id);
    }

    if (typeof d.name !== 'string' || !d.name.trim()) {
      problems.push({ at: label, reason: '缺少名字' });
    } else if (!isSafeDocName(d.name)) {
      problems.push({ at: label, reason: `名字「${d.name}」不能作为路径段（含斜杠或非法字符）` });
    }

    if (d.type !== 'file' && d.type !== 'folder') {
      problems.push({ at: label, reason: `类型必须是 file 或 folder，实际是 ${JSON.stringify(d.type)}` });
    }

    if (d.createdAt !== undefined && !Number.isFinite(d.createdAt)) {
      problems.push({ at: label, reason: 'createdAt 不是有效时间戳' });
    }
    if (d.updatedAt !== undefined && !Number.isFinite(d.updatedAt)) {
      problems.push({ at: label, reason: 'updatedAt 不是有效时间戳' });
    }
    if (d.createdBy !== undefined && (typeof d.createdBy !== 'string' || !d.createdBy)) {
      problems.push({ at: label, reason: 'createdBy 必须是非空字符串' });
    }
    if (d.updatedBy !== undefined && (typeof d.updatedBy !== 'string' || !d.updatedBy)) {
      problems.push({ at: label, reason: 'updatedBy 必须是非空字符串' });
    }
    if (d.parentId !== undefined && d.parentId !== null && typeof d.parentId !== 'string') {
      problems.push({ at: label, reason: 'parentId 必须是字符串或 null' });
    }
  });

  // 父子关系：父节点必须在这批文档里。
  // 导入是全量替换，库里原有的文档已经不存在了——
  // 父节点不在这一批里的话，子节点只能算成平级，整棵树就散了。
  raw.forEach((item, i) => {
    if (!item || typeof item !== 'object') return;
    const d = item as Record<string, unknown>;
    if (typeof d.parentId !== 'string' || !d.parentId) return;
    if (!ids.has(d.parentId)) {
      const label = typeof d.id === 'string' && d.id ? d.id : `#${i}`;
      problems.push({ at: label, reason: `父节点「${d.parentId}」不在这批文档里` });
    }
  });

  // 有环：a 的爹是 b，b 的爹是 a。这样的树没法按「父在前」插进去。
  const parentOf = new Map<string, string>();
  raw.forEach((item) => {
    if (!item || typeof item !== 'object') return;
    const d = item as Record<string, unknown>;
    if (typeof d.id === 'string' && typeof d.parentId === 'string' && d.parentId) {
      parentOf.set(d.id, d.parentId);
    }
  });
  for (const id of parentOf.keys()) {
    const walked = new Set<string>([id]);
    let cur = parentOf.get(id);
    while (cur && parentOf.has(cur)) {
      if (walked.has(cur)) {
        problems.push({ at: id, reason: '父子关系成环' });
        break;
      }
      walked.add(cur);
      cur = parentOf.get(cur);
    }
  }

  return problems;
}

/**
 * 导入时被兜底补齐的内容统计。
 *
 * 兜底不是静默的：迁移完得让人知道哪些地方是替它猜的，
 * 不然「谁写的」「什么时候写的」就成了查无对证的东西。
 */
export interface ImportDefaulted {
  /** 缺时间戳、按当前时间补齐的篇数 */
  timestamps: number;
  /** 缺作者、按导入人补齐的篇数 */
  authors: number;
  /** 归属仓库不存在、落到默认仓库的篇数 */
  repos: number;
}

/**
 * 把导入载荷整理成能安全写库的形状。
 *
 * 缺的时间戳与作者用兜底值补齐：迁移的首要目的是「把内容搬过来」，
 * 元数据缺一两个不该让整次迁移失败。
 * 归属仓库不存在时落到默认仓库——内容比归属重要，
 * 换个仓库总比整批导不进去强。
 *
 * 加密文档不带走正文：快照里根本没有密文，
 * 把明文塞进 .enc 文件等于在盘上留一份明文副本——
 * 那比导不进来更糟。
 */
export function normalizeImportDocs(raw: unknown[]): {
  docs: DocNode[];
  defaulted: ImportDefaulted;
} {
  const repoIds = new Set(
    (db.prepare('SELECT id FROM repos').all() as Array<{ id: string }>).map((r) => r.id),
  );
  const fallbackRepo = defaultRepoId();
  const now = Date.now();
  const defaulted: ImportDefaulted = { timestamps: 0, authors: 0, repos: 0 };

  const docs = raw.map((item) => {
    const d = (item ?? {}) as Record<string, unknown>;
    const hasCreatedAt = Number.isFinite(d.createdAt);
    const hasUpdatedAt = Number.isFinite(d.updatedAt);
    const hasCreatedBy = typeof d.createdBy === 'string' && !!d.createdBy;
    const hasUpdatedBy = typeof d.updatedBy === 'string' && !!d.updatedBy;
    if (!hasCreatedAt || !hasUpdatedAt) defaulted.timestamps += 1;
    if (!hasCreatedBy || !hasUpdatedBy) defaulted.authors += 1;

    const createdAt = hasCreatedAt ? (d.createdAt as number) : now;
    const encrypted = d.encrypted === true;
    // 没写归属的文档落到默认仓库是常事，不用报；
    // 但「指向了一个不存在的仓库」得报——那说明它被悄悄挪了地方。
    const namedRepo = typeof d.repoId === 'string' && !!d.repoId;
    const hasRepo = namedRepo && repoIds.has(d.repoId as string);
    if (namedRepo && !hasRepo) defaulted.repos += 1;
    const repoId = hasRepo ? (d.repoId as string) : fallbackRepo;

    return {
      id: d.id as string,
      name: d.name as string,
      type: d.type as DocNode['type'],
      parentId: typeof d.parentId === 'string' && d.parentId ? d.parentId : null,
      content: encrypted || typeof d.content !== 'string' ? undefined : d.content,
      createdAt,
      updatedAt: hasUpdatedAt ? (d.updatedAt as number) : createdAt,
      createdBy: hasCreatedBy ? (d.createdBy as string) : IMPORT_ACTOR,
      updatedBy: hasUpdatedBy ? (d.updatedBy as string) : IMPORT_ACTOR,
      tags: Array.isArray(d.tags) ? (d.tags as string[]) : undefined,
      encrypted,
      lockedAt: Number.isFinite(d.lockedAt) ? (d.lockedAt as number) : undefined,
      repoId,
    } satisfies DocNode;
  });

  return { docs, defaulted };
}

/**
 * 把文档排成「父在前、子在后」的顺序。
 *
 * 路径是算出来的：子节点的路径 = 父节点的路径 + 自己的名字。
 * 父还没插进去就算不出子节点的路径，它会落成一个平级的节点——
 * 树就散了，「同名冲突自动加序号」这条规则也跟着失效。
 *
 * 所以按在树里的深度排序：深度小的先插，父必然先于子。
 * 深度相同的保持原有相对顺序（排序是稳定的）。
 */
function orderForImport(docs: DocNode[]): DocNode[] {
  const byId = new Map(docs.map((d) => [d.id, d]));
  const depthOf = (d: DocNode): number => {
    let depth = 0;
    let cur: DocNode | undefined = d;
    const guard = new Set<string>();
    while (cur?.parentId) {
      if (guard.has(cur.parentId)) break; // 有环：校验阶段就拦下了，这里只是别死循环
      guard.add(cur.parentId);
      const parent = byId.get(cur.parentId);
      if (!parent) break;
      depth += 1;
      cur = parent;
    }
    return depth;
  };
  return [...docs].sort((a, b) => depthOf(a) - depthOf(b));
}

/**
 * 覆盖式导入（用于迁移浏览器 localStorage 中的历史数据）
 *
 * 这是「全量替换」：整个资料库被换成导入的这一批。
 * 因此它必须是全有或全无的——中途失败绝不能留下一个「库空了」的残局。
 * 三道防线：
 *
 *   1. 先校验后动手：载荷不合格就地退回，一个字节都不碰。
 *   2. 库里的删与插在同一个事务里：插到一半炸了，事务回滚，库还是原来那份。
 *   3. 盘上的旧目录先挪到一边暂存：回滚时挪回来，成功之后才清掉。
 *      文件写盘不受事务保护，这一手是盘上唯一的兜底。
 */
export function replaceAllDocs(docs: DocNode[]): number {
  const ordered = orderForImport(docs);

  // 旧仓库目录先挪到一边暂存。
  //
  // 只清库里的行会留下一地孤儿文件：它们不再被任何文档引用，
  // 却还占着磁盘，而且再也没人会去清理它们。
  // 挪而不是删，是因为「清空」这一步本身可能失败，
  // 而失败点落在中间的话，内容就再也找不回来了。
  const slugs = (db.prepare('SELECT slug FROM repos').all() as Array<{ slug: string }>).map(
    (r) => r.slug,
  );
  const parked = new Map<string, string>();
  try {
    for (const slug of slugs) {
      const name = parkRepoDir(slug);
      if (name) parked.set(slug, name);
    }
  } catch (err) {
    // 一个都没挪动成功：把已经挪走的挪回去，库与盘都还没动过
    for (const [slug, name] of parked) {
      try {
        unparkRepoDir(name, slug);
      } catch (e) {
        logger.error(`导入中止，但旧目录挪不回去：${slug}`, e);
      }
    }
    throw err;
  }

  try {
    // 删与插在同一个事务里：插到一半炸了，事务回滚，库还是原来那份。
    db.transaction(() => {
      db.prepare('DELETE FROM nodes').run();
      db.prepare('DELETE FROM node_fts').run();
      db.prepare('DELETE FROM attachment_fts').run();
      for (const d of ordered) insertDoc(d);
    })();
  } catch (err) {
    // 库已经回滚了；盘上要把这次写了一半的新目录清掉，再把旧目录挪回原位。
    //
    // 顺序不能反：先删新目录，才腾得出位置放旧目录。
    for (const slug of slugs) {
      try {
        removeRepoDir(slug);
      } catch (e) {
        logger.warn(`回滚时清不掉新目录：${slug}`, e);
      }
    }
    for (const [slug, name] of parked) {
      try {
        unparkRepoDir(name, slug);
      } catch (e) {
        logger.error(`回滚时旧目录挪不回去：${slug}`, e);
      }
    }
    throw err;
  }

  // 成了：暂存的旧目录清场
  for (const name of parked.values()) {
    try {
      discardParkedRepoDir(name);
    } catch (err) {
      logger.warn('导入成功，但旧仓库目录没清掉', err);
    }
  }
  return docs.length;
}

/* ------------------------------ 跨仓库搬家 ------------------------------ */

/**
 * 把一批文档（连同子孙）整体搬到另一个仓库。
 *
 * 搬的不只是数据库里的那几行：正文文件住在仓库目录里，
 * 仓库变了目录名，文件不跟着走就成了孤儿——索引说它在，磁盘上却读不出来。
 * 所以这里搬文件、搬路径、搬归属，一次做完。
 *
 * 根节点的父指针会置空：它的爹留在原仓库，硬留着会造成
 * 「孩子在 A 仓库、爹在 B 仓库」的错位，按仓库过滤文件树时对不上。
 */
export function moveNodesToRepo(docIds: string[], targetRepoId: string): number {
  if (!docIds.length) return 0;

  const all = db.prepare('SELECT id, parent_id FROM nodes').all() as Array<{
    id: string;
    parent_id: string | null;
  }>;
  const childrenOf = new Map<string, string[]>();
  all.forEach((r) => {
    if (!r.parent_id) return;
    const list = childrenOf.get(r.parent_id);
    if (list) list.push(r.id);
    else childrenOf.set(r.parent_id, [r.id]);
  });

  // 收集所有选中节点及其后代
  const targets = new Set<string>();
  const queue = [...docIds];
  while (queue.length) {
    const cur = queue.shift()!;
    if (targets.has(cur)) continue;
    targets.add(cur);
    (childrenOf.get(cur) ?? []).forEach((c) => queue.push(c));
  }
  if (!targets.size) return 0;

  // 父在前子在后：算新路径时要先知道爹的新路径
  const ordered: NodeRow[] = [];
  const seen = new Set<string>();
  const visit = (id: string) => {
    if (seen.has(id)) return;
    seen.add(id);
    const row = db.prepare('SELECT * FROM nodes WHERE id = ?').get(id) as NodeRow | undefined;
    if (!row) return;
    if (row.parent_id && targets.has(row.parent_id)) visit(row.parent_id);
    ordered.push(row);
  };
  docIds.forEach(visit);

  const ts = Date.now();
  const update = db.prepare(
    'UPDATE nodes SET repo_id = ?, path = ?, parent_id = ?, updated_at = ? WHERE id = ?',
  );
  const roots = new Set(
    ordered.filter((n) => !n.parent_id || !targets.has(n.parent_id)).map((n) => n.id),
  );

  db.transaction(() => {
    for (const node of ordered) {
      if (node.repo_id === targetRepoId) continue;
      const sourceSlug = repoSlugOf(node.repo_id);
      const targetSlug = repoSlugOf(targetRepoId);
      const newPath = computePath(targetRepoId, node.parent_id, node.name, node.id);
      // 正文与附件都要搬进目标仓库的目录：留在原仓库下就成了孤儿文件，
      // 原仓库一删，这些文档就只剩一行元数据、二进制没了。
      if (kindOf(node) === 'file') {
        moveFileAt(filePath(sourceSlug, node.path), filePath(targetSlug, newPath));
      } else {
        moveBodyFile(sourceSlug, node.path, targetSlug, newPath, node.encrypted === 1);
      }
      relocateAttachmentFiles(node.id, { slug: sourceSlug, path: node.path }, { slug: targetSlug, path: newPath });
      update.run(
        targetRepoId,
        newPath,
        roots.has(node.id) ? null : node.parent_id,
        ts,
        node.id,
      );
    }
  })();

  // 索引里的仓库归属也要跟着改：检索是先按仓库圈范围再匹配的，
  // 归属留在旧仓库的话，搬过去的文档在按仓库检索时就「消失」了。
  const movedIds = ordered.filter((n) => n.repo_id !== targetRepoId).map((n) => n.id);
  if (movedIds.length) {
    const placeholders = movedIds.map(() => '?').join(',');
    db.prepare(`UPDATE node_fts SET repo_id = ? WHERE node_id IN (${placeholders})`).run(
      targetRepoId,
      ...movedIds,
    );
    db.prepare(
      `UPDATE attachment_fts SET repo_id = ?
        WHERE att_id IN (SELECT id FROM attachments WHERE doc_id IN (${placeholders}))`,
    ).run(targetRepoId, ...movedIds);
  }

  return ordered.length;
}

/* ------------------------------ 附件二进制回收 ------------------------------ */

/**
 * 收集这些文档名下附件在 vault 里的绝对路径。
 *
 * 删文档时附件行会被外键 CASCADE 连带删掉，之后就再也查不到它的存储路径了。
 * 所以必须在删之前先把路径收走。
 */
export function collectAttachmentFiles(docIds: string[]): string[] {
  if (!docIds.length) return [];
  const rows = db
    .prepare(
      `SELECT DISTINCT storage_key FROM attachments
        WHERE doc_id IN (${docIds.map(() => '?').join(',')})`,
    )
    .all(...docIds) as Array<{ storage_key: string }>;
  return rows.map((r) => join(VAULT_ROOT, r.storage_key));
}

/* ------------------------------ 用户 ------------------------------ */
export function findUserByUsername(username: string): UserRow | undefined {
  return db.prepare('SELECT * FROM users WHERE username = ?').get(username) as UserRow | undefined;
}

export function findUserById(id: string): UserRow | undefined {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
}

/**
 * 写入新密码。
 *
 * 同时清空明文列：留着它等于同时维护两份凭据，任何一处泄露都足以登录，
 * 而它的存在价值只是给旧版本代码降级读取——本项目没有第二个版本。
 */
/** 写入新密码并返回其哈希，避免调用方为取指纹重复跑一次 scrypt */
export function updateUserPassword(id: string, plain: string): string {
  const hash = hashPassword(plain);
  db.prepare('UPDATE users SET password_hash = ?, password = ? WHERE id = ?').run(hash, '', id);
  return hash;
}

/**
 * 把明文密码升级为哈希。登录成功后调用一次，是存量库唯一的迁移路径。
 *
 * 不单独提供「重置为环境变量密码」的通道：那会让 WORKHUB_ADMIN_PASSWORD 在
 * 已有库上重新生效，与「环境变量仅用于首次初始化」的既定语义冲突。
 */
export function upgradeLegacyPassword(id: string, plain: string): void {
  db.prepare('UPDATE users SET password_hash = ?, password = ? WHERE id = ?').run(hashPassword(plain), '', id);
  logger.info('管理员密码已由明文升级为哈希存储');
}

export { rowToUser };

/* ------------------------------ Agent 配置 ------------------------------ */

interface ConfigRow {
  base_url: string;
  api_key_enc: string | null;
  model: string;
  group_id: string;
  temperature: number;
  allow_guest: number;
  top_k: number;
  context_budget: number;
  rag_scope: string | null;
}

const readConfigRow = (): ConfigRow | undefined =>
  db.prepare('SELECT * FROM agent_config WHERE id = 1').get() as ConfigRow | undefined;

/**
 * 解析库里存的检索范围。
 *
 * 存量库里这列可能为空或是半截 JSON。解析不出来就退回默认的全站范围——
 * 宁可宽一点，也不要因为一行脏数据就让模型什么都读不到。
 */
function parseRagScope(raw: string | null | undefined): RagScope {
  if (!raw) return { ...DEFAULT_RAG_SCOPE };
  try {
    const parsed = JSON.parse(raw) as Partial<RagScope>;
    const mode: RagScope['mode'] = parsed.mode === 'repos' || parsed.mode === 'docs' ? parsed.mode : 'all';
    return {
      mode,
      repoIds: Array.isArray(parsed.repoIds) ? parsed.repoIds.filter((x) => typeof x === 'string') : [],
      docIds: Array.isArray(parsed.docIds) ? parsed.docIds.filter((x) => typeof x === 'string') : [],
      includeAttachments: parsed.includeAttachments !== false,
    };
  } catch {
    return { ...DEFAULT_RAG_SCOPE };
  }
}

/** 完整配置（含明文 Key，仅服务端内部使用，禁止外发） */
export function getAgentConfig(): AgentSettings {
  const r = readConfigRow();
  if (!r) return { ...DEFAULT_AGENT_SETTINGS };
  return {
    baseUrl: r.base_url,
    apiKey: decryptSecret(r.api_key_enc),
    model: r.model,
    groupId: r.group_id,
    temperature: r.temperature,
    allowGuest: r.allow_guest === 1,
    topK: r.top_k,
    contextBudget: r.context_budget,
    ragScope: parseRagScope(r.rag_scope),
  };
}

/** 脱敏配置：不下发 Key，只告知是否已配置 */
export function getAgentConfigPublic(): Omit<AgentSettings, 'apiKey'> & { hasApiKey: boolean } {
  const { apiKey, ...rest } = getAgentConfig();
  return { ...rest, hasApiKey: Boolean(apiKey) };
}

export interface AgentConfigPatch extends Partial<Omit<AgentSettings, 'apiKey'>> {
  /** 新 Key，非空则覆盖 */
  apiKey?: string;
  /** 显式清除已存 Key */
  clearApiKey?: boolean;
}

/**
 * 更新配置。
 * apiKey 传空/缺省表示保持原值（前端不回显密文，故无法原样提交）。
 */
export function saveAgentConfig(patch: AgentConfigPatch): void {
  const cur = getAgentConfig();
  const next: AgentSettings = { ...cur };
  (['baseUrl', 'model', 'groupId', 'temperature', 'allowGuest', 'topK', 'contextBudget'] as const).forEach(
    (k) => {
      const v = patch[k];
      if (v !== undefined) (next[k] as unknown) = v;
    },
  );
  // 范围要整体替换：前端提交的是完整的一份，局部合并反而会留下
  // 「模式切到 docs 却还留着旧的 repoIds」这种自相矛盾的配置。
  if (patch.ragScope) {
    next.ragScope = {
      mode: patch.ragScope.mode,
      repoIds: [...(patch.ragScope.repoIds ?? [])],
      docIds: [...(patch.ragScope.docIds ?? [])],
      includeAttachments: patch.ragScope.includeAttachments !== false,
    };
  }

  const curEnc = readConfigRow()?.api_key_enc ?? null;
  let enc = curEnc;
  if (patch.clearApiKey) enc = null;
  else if (patch.apiKey?.trim()) enc = encryptSecret(patch.apiKey.trim());

  db.prepare(
    `UPDATE agent_config SET base_url = ?, api_key_enc = ?, model = ?, group_id = ?,
       temperature = ?, allow_guest = ?, top_k = ?, context_budget = ?, rag_scope = ?, updated_at = ?
     WHERE id = 1`,
  ).run(
    next.baseUrl,
    enc,
    next.model,
    next.groupId,
    next.temperature,
    next.allowGuest ? 1 : 0,
    next.topK,
    next.contextBudget,
    JSON.stringify(next.ragScope),
    Date.now(),
  );
}

/* ------------------------------ token 用量统计 ------------------------------ */

/**
 * 记一次模型调用的 token 用量。
 *
 * 缺失字段一律按 0 落库：不同厂商给的字段并不一致，用量只用于统计，
 * 采集不全不该在写库这层抛错把主流程带崩。
 */
export function insertAgentUsage(input: {
  scene: 'chat' | 'polish';
  model: string;
  usage: TokenUsage;
}): void {
  const { scene, model, usage } = input;
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.trunc(v)) : 0);
  const prompt = num(usage.prompt_tokens);
  const completion = num(usage.completion_tokens);
  const total = num(usage.total_tokens) || prompt + completion;
  const cached = num(usage.prompt_tokens_details?.cached_tokens);
  if (total === 0) return; // 网关未下发用量时不留空行
  db.prepare(
    `INSERT INTO agent_usage
       (scene, model, prompt_tokens, completion_tokens, total_tokens, cached_tokens, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(scene, model, prompt, completion, total, cached, Date.now());
}

/** token 用量汇总：面板底部一行只依赖这个结构 */
export interface AgentUsageSummary {
  totalTokens: number;
  promptTokens: number;
  completionTokens: number;
  callCount: number;
  byScene: Record<'chat' | 'polish', { calls: number; totalTokens: number }>;
  recent: Array<{ scene: string; model: string; totalTokens: number; createdAt: number }>;
}

type UsageAggRow = {
  total_tokens: number;
  prompt_tokens: number;
  completion_tokens: number;
  calls: number;
};

/**
 * 读取累计用量与最近若干条明细。
 *
 * 累计用一条全表 SUM 得出而非逐行累加：明细表会持续增长，
 * 每次开面板都把全部行进 JS 累加，代价随使用时长线性上升。
 */
export function getAgentUsageSummary(recentLimit = 20): AgentUsageSummary {
  const agg = db
    .prepare(
      `SELECT COALESCE(SUM(total_tokens), 0) AS total_tokens,
              COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
              COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
              COUNT(*) AS calls
         FROM agent_usage`,
    )
    .get() as UsageAggRow;

  const scenes = db
    .prepare(`SELECT scene, COALESCE(SUM(total_tokens), 0) AS total_tokens, COUNT(*) AS calls
                FROM agent_usage GROUP BY scene`)
    .all() as Array<{ scene: string; total_tokens: number; calls: number }>;

  const byScene: AgentUsageSummary['byScene'] = {
    chat: { calls: 0, totalTokens: 0 },
    polish: { calls: 0, totalTokens: 0 },
  };
  for (const r of scenes) {
    if (r.scene === 'chat' || r.scene === 'polish') {
      byScene[r.scene] = { calls: r.calls, totalTokens: r.total_tokens };
    }
  }

  const recent = db
    .prepare(`SELECT scene, model, total_tokens, created_at
                FROM agent_usage ORDER BY id DESC LIMIT ?`)
    .all(Math.max(1, Math.min(recentLimit, 200))) as Array<{
    scene: string;
    model: string;
    total_tokens: number;
    created_at: number;
  }>;

  return {
    totalTokens: agg.total_tokens,
    promptTokens: agg.prompt_tokens,
    completionTokens: agg.completion_tokens,
    callCount: agg.calls,
    byScene,
    recent: recent.map((r) => ({
      scene: r.scene,
      model: r.model,
      totalTokens: r.total_tokens,
      createdAt: r.created_at,
    })),
  };
}

/* ------------------------------ 钉钉同步配置 ------------------------------ */

interface DingTalkConfigRow {
  id: number;
  enabled: number;
  channel: string;
  webhook_url: string;
  webhook_secret_enc: string | null;
  app_key: string;
  app_secret_enc: string | null;
  robot_code: string;
  user_ids: string;
  union_id: string;
  executor_ids: string;
  todo_base_url: string;
  updated_at: number;
}

function readDingTalkConfigRow(): DingTalkConfigRow | undefined {
  return db.prepare('SELECT * FROM dingtalk_config WHERE id = 1').get() as
    | DingTalkConfigRow
    | undefined;
}

/** 逗号分隔的 id 列表 → 数组（去首尾空白、丢空项） */
function splitIdList(raw: string): string[] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 库里存的是逗号分隔串，写回时保持同一形状 */
function joinIdList(ids: string[]): string {
  return ids
    .map((s) => s.trim())
    .filter(Boolean)
    .join(',');
}

/** 读取钉钉配置（含明文密钥，仅服务端内部使用） */
export function getDingTalkConfig(): DingTalkConfig {
  const r = readDingTalkConfigRow();
  if (!r) return { ...DEFAULT_DINGTALK_CONFIG };
  const channel: DingTalkChannel =
    r.channel === 'notify' || r.channel === 'todo' ? r.channel : 'webhook';
  return {
    enabled: r.enabled === 1,
    channel,
    webhookUrl: r.webhook_url,
    webhookSecret: decryptSecret(r.webhook_secret_enc),
    appKey: r.app_key,
    appSecret: decryptSecret(r.app_secret_enc),
    robotCode: r.robot_code,
    userIds: splitIdList(r.user_ids),
    unionId: r.union_id,
    executorIds: splitIdList(r.executor_ids),
    todoBaseUrl: r.todo_base_url,
  };
}

/** 脱敏配置：不下发密钥，只告知是否已配置 */
export function getDingTalkConfigPublic(): DingTalkConfigView {
  const { webhookSecret, appSecret, ...rest } = getDingTalkConfig();
  return {
    ...rest,
    hasWebhookSecret: Boolean(webhookSecret),
    hasAppSecret: Boolean(appSecret),
  };
}

export interface DingTalkConfigPatch extends Partial<DingTalkConfig> {
  /** 新加签密钥，非空则覆盖 */
  webhookSecret?: string;
  /** 显式清除已存加签密钥 */
  clearWebhookSecret?: boolean;
  /** 新 AppSecret，非空则覆盖 */
  appSecret?: string;
  /** 显式清除已存 AppSecret */
  clearAppSecret?: boolean;
}

/**
 * 更新钉钉配置。
 *
 * 密钥字段传空/缺省表示保持原值（浏览器拿不到密文，无法原样提交），
 * 与 Agent 的 API Key 是同一套语义。
 */
export function saveDingTalkConfig(patch: DingTalkConfigPatch): void {
  const cur = getDingTalkConfig();
  const next: DingTalkConfig = { ...cur };
  (
    [
      'enabled',
      'channel',
      'webhookUrl',
      'appKey',
      'robotCode',
      'userIds',
      'unionId',
      'executorIds',
      'todoBaseUrl',
    ] as const
  ).forEach((k) => {
    const v = patch[k];
    if (v !== undefined) (next[k] as unknown) = v;
  });

  const row = readDingTalkConfigRow();
  let webhookEnc = row?.webhook_secret_enc ?? null;
  if (patch.clearWebhookSecret) webhookEnc = null;
  else if (patch.webhookSecret?.trim()) webhookEnc = encryptSecret(patch.webhookSecret.trim());

  let appEnc = row?.app_secret_enc ?? null;
  if (patch.clearAppSecret) appEnc = null;
  else if (patch.appSecret?.trim()) appEnc = encryptSecret(patch.appSecret.trim());

  db.prepare(
    `INSERT INTO dingtalk_config
       (id, enabled, channel, webhook_url, webhook_secret_enc, app_key, app_secret_enc,
        robot_code, user_ids, union_id, executor_ids, todo_base_url,
        updated_at)
       VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       enabled = excluded.enabled,
       channel = excluded.channel,
       webhook_url = excluded.webhook_url,
       webhook_secret_enc = excluded.webhook_secret_enc,
       app_key = excluded.app_key,
       app_secret_enc = excluded.app_secret_enc,
       robot_code = excluded.robot_code,
       user_ids = excluded.user_ids,
       union_id = excluded.union_id,
       executor_ids = excluded.executor_ids,
       todo_base_url = excluded.todo_base_url,
       updated_at = excluded.updated_at`,
  ).run(
    next.enabled ? 1 : 0,
    next.channel,
    next.webhookUrl,
    webhookEnc,
    next.appKey,
    appEnc,
    next.robotCode,
    joinIdList(next.userIds),
    next.unionId,
    joinIdList(next.executorIds),
    next.todoBaseUrl,
    Date.now(),
  );
}

/**
 * 合并一份「草稿配置」：以库中配置为底，用草稿里的非空值覆盖，不落库。
 *
 * 用于连通性测试——用户改完还没保存就想先试一下，
 * 不该非得先点保存；而配置本身就保存不成功时，更需要先验证对错。
 */
export function previewDingTalkConfig(
  patch: Partial<DingTalkConfig> & { webhookSecret?: string; appSecret?: string },
): DingTalkConfig {
  const cur = getDingTalkConfig();
  const next: DingTalkConfig = { ...cur };
  (
    [
      'enabled',
      'channel',
      'webhookUrl',
      'appKey',
      'robotCode',
      'userIds',
      'unionId',
      'executorIds',
      'todoBaseUrl',
    ] as const
  ).forEach((k) => {
    const v = patch[k];
    if (v !== undefined) (next[k] as unknown) = v;
  });
  if (patch.webhookSecret?.trim()) next.webhookSecret = patch.webhookSecret.trim();
  if (patch.appSecret?.trim()) next.appSecret = patch.appSecret.trim();
  return next;
}

/* ------------------------------ 提醒记录 ------------------------------ */
interface ReminderRow {
  id: string;
  title: string;
  content: string;
  remind_at: number;
  repeat: string;
  channel: string;
  status: string;
  doc_id: string | null;
  doc_name: string | null;
  created_at: number;
  created_by: string;
  fired_at: number | null;
  done_at: number | null;
  last_error: string;
  fire_count: number;
  todo_id: string;
}

function rowToReminder(r: ReminderRow): Reminder {
  const repeat: ReminderRepeat =
    r.repeat === 'daily' || r.repeat === 'weekly' || r.repeat === 'monthly' ? r.repeat : 'once';
  const channel: DingTalkChannel =
    r.channel === 'notify' || r.channel === 'todo' ? r.channel : 'webhook';
  const status: ReminderStatus =
    r.status === 'sent' || r.status === 'done' || r.status === 'cancelled' || r.status === 'failed'
      ? r.status
      : 'pending';
  return {
    id: r.id,
    title: r.title,
    content: r.content,
    remindAt: r.remind_at,
    repeat,
    channel,
    status,
    docId: r.doc_id,
    docName: r.doc_name,
    createdAt: r.created_at,
    createdBy: r.created_by,
    firedAt: r.fired_at,
    doneAt: r.done_at,
    lastError: r.last_error,
    fireCount: r.fire_count,
    todoId: r.todo_id,
  };
}

/** 提醒清单：按提醒时间正序，已到点的排在最前 */
export function listReminders(): Reminder[] {
  const rows = db
    .prepare('SELECT * FROM reminders ORDER BY remind_at ASC, created_at ASC')
    .all() as ReminderRow[];
  return rows.map(rowToReminder);
}

/** 到期待触发的提醒：供调度器扫描 */
export function listDueReminders(now: number): Reminder[] {
  const rows = db
    .prepare("SELECT * FROM reminders WHERE status = 'pending' AND remind_at <= ? ORDER BY remind_at ASC")
    .all(now) as ReminderRow[];
  return rows.map(rowToReminder);
}

export function getReminder(id: string): Reminder | undefined {
  const r = db.prepare('SELECT * FROM reminders WHERE id = ?').get(id) as ReminderRow | undefined;
  return r ? rowToReminder(r) : undefined;
}

export interface InsertReminderInput {
  id: string;
  title: string;
  content: string;
  remindAt: number;
  repeat: ReminderRepeat;
  channel: DingTalkChannel;
  docId: string | null;
  docName: string | null;
  createdBy: string;
}

/** 新建一条提醒记录 */
export function insertReminder(input: InsertReminderInput): Reminder {
  db.prepare(
    `INSERT INTO reminders
       (id, title, content, remind_at, repeat, channel, status, doc_id, doc_name,
        created_at, created_by, fired_at, done_at, last_error, fire_count, todo_id)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, NULL, NULL, '', 0, '')`,
  ).run(
    input.id,
    input.title,
    input.content,
    input.remindAt,
    input.repeat,
    input.channel,
    input.docId,
    input.docName,
    Date.now(),
    input.createdBy,
  );
  return getReminder(input.id) as Reminder;
}

export interface ReminderPatch {
  title?: string;
  content?: string;
  remindAt?: number;
  repeat?: ReminderRepeat;
  channel?: DingTalkChannel;
  status?: ReminderStatus;
  firedAt?: number | null;
  doneAt?: number | null;
  lastError?: string;
  fireCount?: number;
  todoId?: string;
}

/** 更新提醒。字段缺省表示保持原值 */
export function updateReminder(id: string, patch: ReminderPatch): void {
  const cur = getReminder(id);
  if (!cur) return;
  const next = { ...cur, ...patch };
  db.prepare(
    `UPDATE reminders SET title = ?, content = ?, remind_at = ?, repeat = ?, channel = ?,
       status = ?, fired_at = ?, done_at = ?, last_error = ?, fire_count = ?, todo_id = ?
     WHERE id = ?`,
  ).run(
    next.title,
    next.content,
    next.remindAt,
    next.repeat,
    next.channel,
    next.status,
    next.firedAt,
    next.doneAt,
    next.lastError,
    next.fireCount,
    next.todoId,
    id,
  );
}

/** 删除提醒记录；返回是否真的删掉了 */
export function deleteReminder(id: string): boolean {
  const info = db.prepare('DELETE FROM reminders WHERE id = ?').run(id);
  return info.changes > 0;
}
