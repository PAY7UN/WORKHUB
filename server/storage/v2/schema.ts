/**
 * v2 数据模型的唯一定义。
 *
 * 这个文件是「表长什么样」的唯一真相源：迁移器建库、运行时建表、
 * 空库启动补表，都走这里。改字段只改这一处，不会出现
 * 「迁移建的库」和「运行时建的库」结构不一样这种事。
 *
 * 模型与旧库的三处根本差别：
 *
 * 1. **文档表叫 nodes，不叫 docs**。它不只装文档，也装文件夹——
 *    旧模型里两者塞在同一张表、用 type 列区分，本质是同一棵树，
 *    没必要拆成两张表再靠外键拼回去。
 *
 * 2. **正文不在库里**。库里只有索引（路径、哈希、大小），
 *    正文躺在 vault 的仓库目录里。库被拷走不等于内容被拷走，
 *    反过来内容也不会把库撑大。
 *
 * 3. **仓库是必填的**。nodes.repo_id NOT NULL：
 *    新模型里没有「未归档」这种状态，每篇文档都有明确的归属。
 */
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { resolveDbPath } from '../../paths.ts';

/**
 * v2 主库路径。
 *
 * 优先级与环境变量名都在 paths.ts 里定，别处不再各写一份——
 * 之前这里只认 MDHUB_DB_V2，而 db.ts 认 MDHUB_DB_V2 → MDHUB_DB，
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
  -- 老库补列时拿不到 DEFAULT 'note'，所以读侧一律按「空值即 note」处理
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
  password      TEXT NOT NULL,
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

-- 钉钉同步配置：单行（id=1）
CREATE TABLE IF NOT EXISTS dingtalk_config (
  id                INTEGER PRIMARY KEY CHECK (id = 1),
  enabled           INTEGER NOT NULL DEFAULT 0,
  channel           TEXT NOT NULL DEFAULT 'webhook' CHECK (channel IN ('webhook','notify','todo')),
  webhook_url       TEXT NOT NULL DEFAULT '',
  webhook_secret_enc TEXT,
  app_key           TEXT NOT NULL DEFAULT '',
  app_secret_enc    TEXT,
  robot_code        TEXT NOT NULL DEFAULT '',
  user_ids          TEXT NOT NULL DEFAULT '',
  union_id          TEXT NOT NULL DEFAULT '',
  executor_ids      TEXT NOT NULL DEFAULT '',
  todo_base_url     TEXT NOT NULL DEFAULT '',
  updated_at        INTEGER NOT NULL
);

-- 提醒记录：到点推送到钉钉，过程与结果都留痕
CREATE TABLE IF NOT EXISTS reminders (
  id         TEXT PRIMARY KEY,
  title      TEXT NOT NULL,
  content    TEXT NOT NULL DEFAULT '',
  remind_at  INTEGER NOT NULL,
  repeat     TEXT NOT NULL DEFAULT 'once' CHECK (repeat IN ('once','daily','weekly','monthly')),
  channel    TEXT NOT NULL DEFAULT 'webhook' CHECK (channel IN ('webhook','notify','todo')),
  status     TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','done','cancelled','failed')),
  doc_id     TEXT,
  doc_name   TEXT,
  created_at INTEGER NOT NULL,
  created_by TEXT NOT NULL DEFAULT 'u-admin',
  fired_at   INTEGER,
  done_at    INTEGER,
  last_error TEXT NOT NULL DEFAULT '',
  fire_count INTEGER NOT NULL DEFAULT 0,
  todo_id    TEXT NOT NULL DEFAULT ''
);

-- ---------------------------------------------------------------- 索引
CREATE INDEX IF NOT EXISTS idx_nodes_parent ON nodes(parent_id);
CREATE INDEX IF NOT EXISTS idx_nodes_repo ON nodes(repo_id);
CREATE INDEX IF NOT EXISTS idx_agent_usage_created ON agent_usage(created_at);
CREATE INDEX IF NOT EXISTS idx_access_requests_status ON access_requests(status, created_at);
CREATE INDEX IF NOT EXISTS idx_access_grants_doc ON access_grants(doc_id);
CREATE INDEX IF NOT EXISTS idx_access_audit_doc ON access_audit(doc_id, created_at);
CREATE INDEX IF NOT EXISTS idx_reminders_due ON reminders(status, remind_at);
CREATE INDEX IF NOT EXISTS idx_attachments_doc ON attachments(doc_id);
CREATE INDEX IF NOT EXISTS idx_attachments_sha ON attachments(sha256);
`;

/**
 * 从 SCHEMA 里解析出每张表应有的列。
 *
 * SCHEMA 是「表长什么样」的唯一真相源，补列也得照着它来，
 * 否则补列逻辑和建表逻辑会各说各话——那才是真正难查的故障。
 */
function expectedColumns(): Array<{ table: string; columns: Array<{ name: string; type: string; notNull: boolean }> }> {
  const out: Array<{ table: string; columns: Array<{ name: string; type: string; notNull: boolean }> }> = [];
  // 只认普通的 CREATE TABLE：虚表（FTS）不能 ALTER，它的结构问题在上面单独处理
  const re = /CREATE TABLE IF NOT EXISTS (\w+)\s*\(([\s\S]*?)\n\);/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(SCHEMA))) {
    const [, table, body] = m;
    const columns: Array<{ name: string; type: string; notNull: boolean }> = [];
    for (const raw of body.split('\n')) {
      const line = raw.trim().replace(/--.*$/, '').trim();
      if (!line) continue;
      // 表级约束（UNIQUE (...) / CHECK (...) / FOREIGN KEY ...）不是列，跳过
      if (/^(UNIQUE|CHECK|PRIMARY|FOREIGN|CONSTRAINT)\b/i.test(line)) continue;
      const col = /^(\w+)\s+([A-Za-z]+(?:\s*\([^)]*\))?)\s*(.*)$/.exec(line);
      if (!col) continue;
      const [, name, type, rest] = col;
      if (!rest || /PRIMARY KEY/i.test(rest)) continue; // 主键列补不了，跳过
      columns.push({ name, type: type.replace(/\s+/g, ''), notNull: /NOT NULL/i.test(rest) });
    }
    out.push({ table, columns });
  }
  return out;
}

/**
 * 给已存在的表补上 SCHEMA 里新增的列。
 *
 * CREATE TABLE IF NOT EXISTS 只管「表在不在」，管不了「列齐不齐」：
 * 老库建好之后再往 SCHEMA 里加字段，那个库永远补不上。
 * 后果不是启动报错，而是运行时一句 “no such column: xxx”——
 * 而且只在真正写那条记录时才炸，平时一切正常，看着像好好的。
 *
 * 所以每次开库都核对一遍：缺哪列补哪列。补列是幂等的，
 * 库已经是最新结构时什么也不做。
 */
export function ensureColumns(db: V2Database): string[] {
  const added: string[] = [];
  for (const { table, columns } of expectedColumns()) {
    const actual = new Set(
      (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
        (c) => c.name,
      ),
    );
    if (actual.size === 0) continue; // 表还不存在，交给 SCHEMA 建
    for (const col of columns) {
      if (actual.has(col.name)) continue;
      // 补 NOT NULL 的列必须带默认值，否则 SQLite 不让加
      const def =
        col.notNull
          ? col.type.startsWith('TEXT')
            ? ` DEFAULT ''`
            : col.type.startsWith('REAL')
              ? ' DEFAULT 0'
              : ' DEFAULT 0'
          : '';
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${col.name} ${col.type}${def}`);
      added.push(`${table}.${col.name}`);
    }
  }
  return added;
}

/**
 * 放宽 access_audit.action 的取值范围。
 *
 * CHECK 约束是写死在建表语句里的，而 CREATE TABLE IF NOT EXISTS 不会改已存在的表——
 * 于是新加的动作（比如「调整授权」）往老库里写会被 CHECK 挡下来。
 * 而写审计的代码是吞异常的：数据没进去，日志里只留一行 warn，
 * 表现就是「点了没反应，流水里也没有」，极难往数据库方向想。
 *
 * SQLite 不能直接改 CHECK，只能重建表：建新的、搬数据、删旧的、改名。
 * 老表的 CHECK 里已经含新值就什么都不做——重建是无意义的写放大。
 */
function widenAccessAuditActions(db: V2Database): boolean {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'access_audit'")
    .get() as { sql?: string } | undefined;
  const sql = row?.sql ?? '';
  if (!sql) return false;
  if (sql.includes("'adjust'")) return false; // 已经放开了

  const rebuild = db.transaction(() => {
    db.exec(`
      CREATE TABLE access_audit_new (
        id         TEXT PRIMARY KEY,
        doc_id     TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
        action     TEXT NOT NULL CHECK (action IN ('request','approve','reject','open','download','revoke','adjust','share')),
        actor_id   TEXT NOT NULL DEFAULT '',
        actor_name TEXT NOT NULL DEFAULT '',
        detail     TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL
      );
      INSERT INTO access_audit_new (id, doc_id, action, actor_id, actor_name, detail, created_at)
        SELECT id, doc_id, action, actor_id, actor_name, detail, created_at FROM access_audit;
      DROP TABLE access_audit;
      ALTER TABLE access_audit_new RENAME TO access_audit;
      CREATE INDEX IF NOT EXISTS idx_access_audit_doc ON access_audit(doc_id, created_at);
    `);
  });
  rebuild();
  return true;
}

/**
 * 打开（或创建）v2 库并建表。
 *
 * FTS 虚表要单独检查一次结构：CREATE TABLE IF NOT EXISTS 遇到已存在的表不会改结构，
 * 而虚表又不能 ALTER——所以列对不上就直接重建（里面的数据是索引，随时能重建）。
 */
export function openV2Db(path: string = DB_V2_PATH): V2Database {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path) as V2Database;
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('wal_autocheckpoint = 256');

  const ftsCols = db.prepare("select name from pragma_table_info('node_fts')").all() as Array<{
    name: string;
  }>;
  if (ftsCols.length > 0 && !ftsCols.some((c) => c.name === 'repo_id')) {
    db.exec('drop table if exists node_fts;');
  }

  db.exec(SCHEMA);
  ensureColumns(db);
  // CHECK 约束不在 ensureColumns 的射程内：它管列，不管约束
  widenAccessAuditActions(db);
  return db;
}
