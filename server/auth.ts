/**
 * 鉴权：HS256 JWT 签发与校验（基于 node:crypto，无第三方依赖）。
 * 访客无需登录，服务端为其签发 role=viewer 的匿名令牌；
 * 管理员登录后签发 role=admin 令牌。
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import type { User } from '../shared/types.ts';
import { SECRET } from './config.ts';
import { findUserById } from './db.ts';
import { passwordFingerprint } from './password.ts';

const TTL_SECONDS = 60 * 60 * 12; // 12 小时

export interface AuthPayload {
  sub: string;
  username: string;
  displayName: string;
  role: 'admin' | 'viewer';
  avatar: string;
  color: string;
  /** 访客令牌标记，用于区分是否经过密码校验 */
  anon: boolean;
  /**
   * 签发时的密码指纹（password_hash 的一小段）。
   *
   * 没有它的话，改密码只影响「下次登录」，此前签发的令牌仍可用满 12 小时——
   * 密码泄露的典型场景恰恰是令牌也在别人手里，改密码却踢不掉他。
   * 校验时需查库比对，故只在 admin 令牌上携带，访客令牌免去这次查询。
   *
   * 旧令牌不含此字段，此时跳过比对（渐进兼容：它们会在 TTL 内自然过期）。
   */
  pwd?: string;
  iat: number;
  exp: number;
}

const b64url = (input: Buffer | string): string =>
  Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const b64urlDecode = (input: string): Buffer => Buffer.from(input.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

const signature = (data: string): string => b64url(createHmac('sha256', SECRET).update(data).digest());

export function signToken(user: User, anon: boolean, pwd?: string): string {
  const now = Math.floor(Date.now() / 1000);
  const payload: AuthPayload = {
    sub: user.id,
    username: user.username,
    displayName: user.displayName,
    role: user.role,
    avatar: user.avatar,
    color: user.color,
    anon,
    // 访客令牌不带指纹：它本就没有密码，也就不需要「改密后失效」这一语义
    ...(anon ? {} : { pwd: pwd ?? '' }),
    iat: now,
    exp: now + TTL_SECONDS,
  };
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify(payload));
  return `${header}.${body}.${signature(`${header}.${body}`)}`;
}

export function verifyToken(token: string): AuthPayload | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, body, sig] = parts;
  const expected = signature(`${header}.${body}`);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(b64urlDecode(body).toString('utf8')) as AuthPayload;
    if (!payload.exp || payload.exp * 1000 < Date.now()) return null;
    // 令牌有效期不得超过签发时设定的 TTL
    if (payload.exp - payload.iat > TTL_SECONDS + 60) return null;
    return payload;
  } catch {
    return null;
  }
}

export function readToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) return header.slice(7).trim();
  return null;
}

/**
 * 令牌携带的密码指纹是否仍与库中一致。
 *
 * 查不到用户时返回 false：宁可让令牌失效，也不要在没有依据时放行。
 */
function isFingerprintCurrent(payload: AuthPayload): boolean {
  const user = findUserById(payload.sub);
  if (!user) return false;
  return user.password_hash === '' || passwordFingerprint(user.password_hash) === payload.pwd;
}

/** 无需登录：解析令牌，失败则回落为访客身份 */
export function attachUser(req: Request, _res: Response, next: NextFunction): void {
  const token = readToken(req);
  const payload = token ? verifyToken(token) : null;
  // 指纹不符 = 密码已被改过，这个令牌不该再有效。降级为访客并标记失效，
  // 由 requireAdmin 转成 401，前端随之清理登录态并提示重新登录。
  const stale = Boolean(payload && !payload.anon && payload.pwd !== undefined && !isFingerprintCurrent(payload));
  if (payload && !stale) {
    req.user = {
      id: payload.sub,
      username: payload.username,
      displayName: payload.displayName,
      role: payload.role,
      avatar: payload.avatar,
      color: payload.color,
    };
    req.isAnon = payload.anon;
  } else {
    // 携带了令牌但校验不通过（过期或密钥轮换），必须让客户端知情：
    // 否则它会继续以管理员身份自居，随后所有写操作都收到 403 却不知原因。
    // 不在此处直接 401，是为了让只读接口仍可降级为访客视图，页面不至于白屏。
    req.tokenInvalid = Boolean(token) || stale;
    req.user = {
      id: 'u-viewer',
      username: 'viewer',
      displayName: '访客',
      role: 'viewer',
      avatar: 'V',
      color: '#f59e0b',
    };
    req.isAnon = true;
  }
  next();
}

/** 必须是管理员 */
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  // 令牌本身已失效：返回 401 而非 403，前者能触发客户端清理身份并提示重新登录
  if (req.tokenInvalid) {
    // 带上这个标记：前端只认这个标记才清登录态。
    // 「状态码是 401 就当登录失效」的做法太粗——任何业务性的 401
    // （比如密码输错）都会把管理员踢回访客，而且真正的错因被覆盖。
    res.setHeader('X-Auth-Expired', '1');
    res.status(401).json({ error: '登录已失效，请重新登录' });
    return;
  }
  if (req.user?.role !== 'admin') {
    res.status(403).json({ error: '需要管理员权限' });
    return;
  }
  next();
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: User;
      /** 当前令牌是否为匿名访客令牌 */
      isAnon?: boolean;
      /** 是否携带了无法校验的令牌（已过期或签名密钥已轮换） */
      tokenInvalid?: boolean;
    }
  }
}
