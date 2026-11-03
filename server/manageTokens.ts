/**
 * 机器令牌：运维面板（托盘 remote 模式）用的长期凭证。
 *
 * 为什么需要它：服务器上往往没有浏览器能登录，但运维仍要能问
 * 「服务还活着吗」「最近报了什么错」「重启一下」。用户会话（JWT）
 * 不适合这个场景——它 12 小时就过期，而运维面板是常年开着的机器，
 * 令牌得比会话活得久。
 *
 * 边界很重要：**机器令牌只管 /api/manage/* 这一组管理接口**，
 * 不等于管理员账号。拿它翻不了文档，也拿不到模型里的 API Key。
 * 这条边界靠「另一套凭证、另一组接口」来保证，而不是靠同一个令牌
 * 在不同接口上权限不同——后者一不小心就写成了一把手枪。
 *
 * 库里只存哈希：明文只在发放那一刻出现一次，丢了就再发一把。
 * 令牌是 32 字节随机数（不是人选的密码），sha256 足够；
 * 慢哈希（scrypt/argon2）是拿来对付低熵密码的，在这里只会白添延迟。
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { V2Database } from './storage/v2/schema.ts';

/** 令牌前缀：让令牌在配置、日志、截图里一眼认得出「这是机器令牌」 */
const TOKEN_PREFIX = 'mht_';

export interface ManageTokenRecord {
  id: string;
  label: string;
  created_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
}

export interface IssuedManageToken extends ManageTokenRecord {
  /** 明文：只在发放时返回一次，之后库里只有哈希，谁也拿不回来 */
  token: string;
}

/** 算哈希。存库、比对都用它 */
export function hashManageToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * 发放一把新令牌。
 *
 * 标签（label）是给人看的：机器多了以后，光看一串哈希谁也分不清
 * 「这把是运维笔记本上的，那把是监控机器上的」。
 */
export function issueManageToken(db: V2Database, label: string): IssuedManageToken {
  const id = randomUUID();
  const token = `${TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
  const createdAt = Date.now();
  db.prepare(
    'INSERT INTO manage_tokens (id, label, token_hash, created_at, last_used_at, revoked_at) VALUES (?, ?, ?, ?, NULL, NULL)',
  ).run(id, label, hashManageToken(token), createdAt);
  return {
    id,
    label,
    token,
    created_at: createdAt,
    last_used_at: null,
    revoked_at: null,
  };
}

/**
 * 校验令牌。
 *
 * 查不到就当没有——绝不因为「库里没这条记录」就放行。
 * 撤销过的令牌同样按无效处理：撤销是「立刻失效」，不是「等它过期」。
 */
export function verifyManageToken(db: V2Database, token: string): ManageTokenRecord | null {
  if (!token) return null;
  const row = db
    .prepare('SELECT * FROM manage_tokens WHERE token_hash = ?')
    .get(hashManageToken(token)) as ManageTokenRecord | undefined;
  if (!row) return null;
  if (row.revoked_at !== null) return null;
  // 记一下最近一次使用：令牌多久没人动，是决定该不该撤销它的依据
  const now = Date.now();
  db.prepare('UPDATE manage_tokens SET last_used_at = ? WHERE id = ?').run(now, row.id);
  return { ...row, last_used_at: now };
}

/** 列出全部令牌（不含哈希） */
export function listManageTokens(db: V2Database): ManageTokenRecord[] {
  return db
    .prepare('SELECT id, label, created_at, last_used_at, revoked_at FROM manage_tokens ORDER BY created_at DESC')
    .all() as ManageTokenRecord[];
}

/**
 * 撤销一把令牌。
 *
 * 撤销而不是删行：删了就看不出「这把令牌曾经存在过」，
 * 也没法回答「它是不是还在某台机器上配着」。
 */
export function revokeManageToken(db: V2Database, id: string): boolean {
  const changed = db
    .prepare('UPDATE manage_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL')
    .run(Date.now(), id).changes;
  return changed > 0;
}
