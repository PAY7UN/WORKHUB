/**
 * v2 数据模型的唯一定义。
 *
 * 这个文件是「表长什么样」的唯一真相源：运行时建表、空库启动补表，
 * 都走这里。改字段只改这一处，不会出现「两条建库路径」结构不一样这种事。
 *
 * 模型的三处根本设计：
 *
 * 1. **文档表叫 nodes，不叫 docs**。它不只装文档，也装文件夹——
 *    两者本是同一棵树，没必要拆成两张表再靠外键拼回去。
 *
 * 2. **正文不在库里**。库里只有索引（路径、哈希、大小），
 *    正文躺在 vault 的仓库目录里。库被拷走不等于内容被拷走，
 *    反过来内容也不会把库撑大。
 *
 * 3. **仓库是必填的**。nodes.repo_id NOT NULL：
 *    没有「未归档」这种状态，每篇文档都有明确的归属。
 */
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { resolveDbPath } from '../../paths.ts';

/**
 * v2 主库路径。
 *
 * 优先级与环境变量名都在 paths.ts 里定，别处不再各写一份——
 * 之前这里只认 WORKHUB_DB_V2，而 db.ts 认 WORKHUB_DB_V2 → WORKHUB_DB，
 * 两边对「用户到底配了哪个」的理解并不一致。
 */
export const DB_V2_PATH = resolveDbPath();

/** v2 数据库句柄 */
export type V2Database = Database.Database;

export const SCHEMA = `
-- ---------------------------------------------------------------- 仓库
-- 仓库是「一个项目」的容器：文件住它的目录、规则存它的行、检索按它切分。
-- slug 是目录名，改仓库名不会打断已有路径——所以 slug 一旦定下就不再变。
CREATE TABLE IF NOT EXISTS repos (
  id            TEXT PRIMARY KEY,
  slug          TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL UNIQUE,
  description   TEXT NOT NULL DEFAULT '',
  color         TEXT NOT NULL DEFAULT '#6366f1',
  -- 允许上传的扩展名白名单（JSON 数组，空数组表示不限）
  allowed_exts  TEXT NOT NULL DEFAULT '[]',
  -- 单附件体积上限（字节）
  max_file_size INTEGER NOT NULL DEFAULT 26214400,
  -- 该仓库是否参与 Agent 检索
  rag_enabled   INTEGER NOT NULL DEFAULT 1,
  -- 仓库级权限（JSON），形如 {"u-admin":"admin"}
  acl           TEXT NOT NULL DEFAULT '{}',
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  created_by    TEXT NOT NULL DEFAULT 'u-admin'
);

-- ---------------------------------------------------------------- 仓库事件
-- 项目仓库自己的历史：建了、改了哪条规则、搬进搬出多少篇、什么时候没的。
--
-- 这张表不引用 repos(id)：仓库删掉以后，那条「项目没了、连带清掉多少东西」
-- 仍要能被追问到，所以事件只留仓库 id 与名字快照，不跟着级联一起消失。
CREATE TABLE IF NOT EXISTS repo_events (
  id         TEXT PRIMARY KEY,
  repo_id    TEXT NOT NULL,
  repo_name  TEXT NOT NULL DEFAULT '',
  action     TEXT NOT NULL CHECK (action IN ('created','updated','migrated','deleted')),
  detail     TEXT NOT NULL DEFAULT '',
  actor      TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);

-- ---------------------------------------------------------------- 节点
-- 文档与文件夹合在一张表：它们构成同一棵树，拆开只是把关系挪个地方存。
--
-- 正文不在这里。path 是节点在仓库目录里的相对路径（仓库内唯一），
-- content_hash 是正文摘要，用来判断「文件被人手改过没有」。
CREATE TABLE IF NOT EXISTS nodes (
  id            TEXT PRIMARY KEY,
  -- 仓库是必填的：没有归属的节点在模型里不成立
  repo_id       TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  type          TEXT NOT NULL CHECK (type IN ('file','folder')),
  parent_id     TEXT REFERENCES nodes(id) ON DELETE CASCADE,
  -- 仓库内相对路径，唯一
  path          TEXT NOT NULL,
  size          INTEGER,
  content_hash  TEXT,
  -- 节点形态：note = Markdown 笔记；file = 原件（zip/图片/PDF/代码…）
  -- 读侧一律经 db.ts 的 kindOf() 兜底，空值按 note 处理
  kind          TEXT NOT NULL DEFAULT 'note',
  -- 原件的 MIME 与扩展名（kind='file' 时有值）
  mime          TEXT NOT NULL DEFAULT '',
  ext           TEXT NOT NULL DEFAULT '',
  -- 加密相关：正文文件写的是密文，库里只留被主密钥包裹的数据密钥
  encrypted      INTEGER NOT NULL DEFAULT 0,
  enc_master_dek TEXT,
  enc_locked_at  INTEGER,
  -- 节点级权限（JSON），空表示沿用仓库设置
  acl           TEXT NOT NULL DEFAULT '{}',
  tags          TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  created_by    TEXT NOT NULL,
  updated_by    TEXT NOT NULL,
  UNIQUE (repo_id, path)
);

-- ---------------------------------------------------------------- 附件
-- 附件二进制住在仓库目录的 assets 下，库里只记元数据与抽出的纯文本。
CREATE TABLE IF NOT EXISTS attachments (
  id           TEXT PRIMARY KEY,
  doc_id       TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  ext          TEXT NOT NULL DEFAULT '',
  mime         TEXT NOT NULL DEFAULT '',
  size         INTEGER NOT NULL DEFAULT 0,
  sha256       TEXT NOT NULL,
  -- 相对 vault 根目录的路径
  storage_key  TEXT NOT NULL,
  -- 正文可检索程度：none（未抽）/ ok（可检索）/ unsupported（该格式不抽）/ failed（抽取出错）
  text_status  TEXT NOT NULL DEFAULT 'none' CHECK (text_status IN ('none','ok','unsupported','failed')),
  text_content TEXT,
  text_chars   INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  created_by   TEXT NOT NULL DEFAULT 'u-admin'
);

-- ---------------------------------------------------------------- 全文索引
-- 中文按二元组切分后写入（写入与查询同一套切法，见 shared/retrieval.ts）。
-- repo_id 存成 UNINDEXED 列：查询时先按仓库过滤，再做匹配，
-- 不必把全站文档捞出来筛一遍。
CREATE VIRTUAL TABLE IF NOT EXISTS node_fts USING fts5(
  repo_id UNINDEXED,
  node_id UNINDEXED,
  name,
  body,
  tokenize = 'unicode61 remove_diacritics 2'
);

-- ---------------------------------------------------------------- 附件索引
-- 附件正文同样可检索：它和文档正文是同一种东西，只是来源不同。
-- 单开一张虚表而不是塞进 node_fts，是为了让「查文档」与「查附件」
-- 各自有干净的键空间，不必在结果里靠前缀去分辨谁是谁。
CREATE VIRTUAL TABLE IF NOT EXISTS attachment_fts USING fts5(
  repo_id UNINDEXED,
  att_id UNINDEXED,
  name,
  body,
  tokenize = 'unicode61 remove_diacritics 2'
);

-- ---------------------------------------------------------------- 账号
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  display_name  TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('admin','viewer')),
  avatar        TEXT NOT NULL,
  color         TEXT NOT NULL,
  -- 密码只存哈希。库里从来没有、也不再补明文列：
  -- 一份凭据只留一份副本，任何一处泄露都足以登录。
  password_hash TEXT NOT NULL DEFAULT ''
);

-- Agent 每调用上游模型记一行：问答与润色分场景存放，便于看清消耗在哪
CREATE TABLE IF NOT EXISTS agent_config (
  id              INTEGER PRIMARY KEY CHECK (id = 1),
  base_url        TEXT NOT NULL,
  api_key_enc     TEXT,
  model           TEXT NOT NULL,
  group_id        TEXT NOT NULL DEFAULT '',
  temperature     REAL NOT NULL DEFAULT 0.3,
  allow_guest     INTEGER NOT NULL DEFAULT 0,
  top_k           INTEGER NOT NULL DEFAULT 5,
  context_budget  INTEGER NOT NULL DEFAULT 24000,
  rag_scope       TEXT NOT NULL DEFAULT '{}',
  updated_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_usage (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  scene              TEXT NOT NULL CHECK (scene IN ('chat','polish')),
  model              TEXT NOT NULL,
  prompt_tokens      INTEGER NOT NULL DEFAULT 0,
  completion_tokens  INTEGER NOT NULL DEFAULT 0,
  total_tokens       INTEGER NOT NULL DEFAULT 0,
  cached_tokens      INTEGER NOT NULL DEFAULT 0,
  created_at         INTEGER NOT NULL
);

-- 机器令牌：运维面板（托盘 remote 模式）用的长期凭证。
--
-- 它只认令牌，不认用户会话：服务器上没有浏览器登录的时候，
-- 运维机器仍要能问一句「服务还活着吗」「最近报了什么错」。
--
-- 库里只存哈希。明文只在发放那一刻出现一次，丢了就再发一把——
-- 令牌是高熵随机串（不是人选的密码），所以用 sha256 足够，
-- 不需要 scrypt 那套慢哈希来拖慢暴力破解。
--
-- 撤销靠 revoked_at 而不是删行：删了就看不出「这把令牌曾经存在过」。
CREATE TABLE IF NOT EXISTS manage_tokens (
  id           TEXT PRIMARY KEY,
  label        TEXT NOT NULL DEFAULT '',
  token_hash   TEXT NOT NULL UNIQUE,
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at   INTEGER
);

-- 访客会话：让「谁申请的」有个可追的落点
CREATE TABLE IF NOT EXISTS guest_sessions (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);

-- 访问申请：访客点「申请访问」后落一行，等管理员审批
CREATE TABLE IF NOT EXISTS access_requests (
  id         TEXT PRIMARY KEY,
  doc_id     TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  guest_id   TEXT NOT NULL,
  guest_name TEXT NOT NULL,
  reason     TEXT NOT NULL DEFAULT '',
  status     TEXT NOT NULL CHECK (status IN ('pending','approved','rejected')),
  created_at INTEGER NOT NULL,
  decided_at INTEGER,
  decided_by TEXT,
  expires_at INTEGER
);

-- 访问授权：审批通过后生效。可撤销、可设有效期，撤销即失效。
--
-- capabilities 是这条授权允许的动作集合（JSON 数组，如 ["view","download"]）。
-- 默认只有 view：读与拿走是两件事，后者要管理员显式放行。
CREATE TABLE IF NOT EXISTS access_grants (
  id           TEXT PRIMARY KEY,
  doc_id       TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  guest_id     TEXT NOT NULL,
  guest_name   TEXT NOT NULL,
  granted_at   INTEGER NOT NULL,
  granted_by   TEXT NOT NULL,
  expires_at   INTEGER,
  revoked_at   INTEGER,
  capabilities TEXT NOT NULL DEFAULT '["view"]'
);

-- 访问审计：加密文档的每一次申请、批准、打开、下载、撤销都留一行。
-- 权限授出去之后，真正要回答的问题是「谁在什么时候看过、拿走过什么」，
-- 而这个问题只有流水答得上来。
CREATE TABLE IF NOT EXISTS access_audit (
  id         TEXT PRIMARY KEY,
  doc_id     TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  action     TEXT NOT NULL CHECK (action IN ('request','approve','reject','open','download','revoke','adjust','share')),
  actor_id   TEXT NOT NULL DEFAULT '',
  actor_name TEXT NOT NULL DEFAULT '',
  detail     TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);

-- ---------------------------------------------------------------- 索引
CREATE INDEX IF NOT EXISTS idx_nodes_parent ON nodes(parent_id);
CREATE INDEX IF NOT EXISTS idx_nodes_repo ON nodes(repo_id);
CREATE INDEX IF NOT EXISTS idx_repo_events_created ON repo_events(created_at);
CREATE INDEX IF NOT EXISTS idx_agent_usage_created ON agent_usage(created_at);
CREATE INDEX IF NOT EXISTS idx_access_requests_status ON access_requests(status, created_at);
CREATE INDEX IF NOT EXISTS idx_access_grants_doc ON access_grants(doc_id);
CREATE INDEX IF NOT EXISTS idx_access_audit_doc ON access_audit(doc_id, created_at);
CREATE INDEX IF NOT EXISTS idx_attachments_doc ON attachments(doc_id);
CREATE INDEX IF NOT EXISTS idx_attachments_sha ON attachments(sha256);
`;

/**
 * 打开（或创建）v2 库并建表。
 *
 * SCHEMA 是表结构的唯一真相源：库要么是新建的（结构即 SCHEMA），
 * 要么就是现役结构（由同一份 SCHEMA 建出来的）。
 * 刻意不保留「给老库补列 / 重建约束」这类迁移逻辑——
 * 结构对不上时，最该做的是重建库，而不是在旧结构上打补丁。
 */
export function openV2Db(path: string = DB_V2_PATH): V2Database {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path) as V2Database;
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('wal_autocheckpoint = 256');

  db.exec(SCHEMA);
  assertWritableSchema(db);
  return db;
}

/**
 * 从 SCHEMA 里解析出每张表应有的列。
 *
 * SCHEMA 是「表长什么样」的唯一真相源，核对也得照着它来，
 * 否则核对逻辑和建表逻辑会各说各话——那才是真正难查的故障。
 */
function expectedColumns(): Map<string, Array<{ name: string; notNull: boolean; hasDefault: boolean }>> {
  const out = new Map<string, Array<{ name: string; notNull: boolean; hasDefault: boolean }>>();
  // 只认普通的 CREATE TABLE：虚表（FTS）的结构由 FTS5 自己管，另有影子表
  const re = /CREATE TABLE IF NOT EXISTS (\w+)\s*\(([\s\S]*?)\n\);/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(SCHEMA))) {
    const [, table, body] = m;
    const columns: Array<{ name: string; notNull: boolean; hasDefault: boolean }> = [];
    for (const rawLine of body.split('\n')) {
      const line = rawLine.trim().replace(/--.*$/, '').trim();
      if (!line) continue;
      // 表级约束（UNIQUE (...) / CHECK (...) / FOREIGN KEY ...）不是列，跳过
      if (/^(UNIQUE|CHECK|PRIMARY|FOREIGN|CONSTRAINT)\b/i.test(line)) continue;
      const col = /^(\w+)\s+([A-Za-z]+(?:\s*\([^)]*\))?)\s*(.*)$/.exec(line);
      if (!col) continue;
      const [, name, , rest] = col;
      if (!rest || /PRIMARY KEY/i.test(rest)) continue; // 主键列在 SQLite 里是 NOT NULL 的特例，不参与核对
      columns.push({
        name,
        notNull: /NOT NULL/i.test(rest),
        hasDefault: /\bDEFAULT\b/i.test(rest),
      });
    }
    out.set(table, columns);
  }
  return out;
}

/**
 * 核对库的结构能不能接住现役代码的写入。
 *
 * 库只有一种结构（SCHEMA），不是「哪个版本建出来的都能跑」。
 * 但 SQLite 的 CREATE TABLE IF NOT EXISTS 不会改已存在的表——
 * 旧版留下来的库会带着旧列继续开着。
 *
 * 为什么这值得单独查：症状是**写入时**才炸，
 * 而且只炸第一处写入（「NOT NULL constraint failed: users.password」）。
 * 开库时一切正常，登录一次才开始不对，而报错信息里没有半个字提到
 * 「你的库是旧版」——排查方向会一路跑到密码校验上去，绕很远。
 *
 * 这里只判定、不修复：修复旧结构等于把刚删掉的兼容逻辑又写回来。
 * 判定出来就明确告诉使用者：备份，然后重建。
 *
 * 判定标准是「会不会挡住写入」，而不是「长得像不像」：
 *   - SCHEMA 里声明的列在库里缺了 → 写入会报「no such column」，要拦；
 *   - 库里多了一列，且是 NOT NULL 又没有默认值 → 写入会被约束挡下，要拦；
 *   - 库里多了一列，但可空或有默认值 → 不挡写入，放行（清掉它要重建表，
 *     那正是我们要避免的那类迁移动作）。
 */
export function assertWritableSchema(db: V2Database): void {
  const problems: string[] = [];
  for (const [table, columns] of expectedColumns()) {
    const actual = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
      name: string;
      notnull: number;
      dflt_value: unknown;
    }>;
    if (actual.length === 0) continue; // 表还不存在，交给 SCHEMA 建

    const actualNames = new Set(actual.map((c) => c.name));
    for (const col of columns) {
      if (!actualNames.has(col.name)) {
        problems.push(`${table} 缺少列 ${col.name}`);
      }
    }
    for (const col of actual) {
      if (columns.some((c) => c.name === col.name)) continue;
      if (col.notnull === 1 && col.dflt_value === null) {
        problems.push(`${table} 多出一列 ${col.name}（NOT NULL 且没有默认值，写入会被挡住）`);
      }
    }
  }
  if (problems.length === 0) return;
  throw new Error(
    `数据库结构与当前版本不匹配，这个库不能直接用：\n` +
      problems.map((p) => `  - ${p}`).join('\n') +
      `\n\n这个库是旧版本留下的。当前版本不再兼容旧结构` +
      `（不补列、不重建表），所以请先把 data 目录整个备份走，再删掉那个库文件重新启动——` +
      `正文在 data/vault/ 里，删库不会删掉正文，但库里的索引、标签与授权需要重新建立。`,
  );
}
