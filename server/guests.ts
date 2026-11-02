/**
 * 访客会话：让「谁」这个概念在访客侧成立。
 *
 * 访客不需要账号，但「申请访问 → 管理员审批 → 授权给某某」这条链子必须落到
 * 具体的人身上：否则批准之后，授权既给不出去也收不回来。
 *
 * 做法是发一个 httpOnly cookie（mdhub_sid），服务端据此维护一张会话表。
 * cookie 是 httpOnly 的，浏览器脚本读不到它——和密码一样，凭证不该交给前端。
 */
import { randomBytes } from 'node:crypto';
import type { Request, Response } from 'express';
import { IS_PRODUCTION } from './config.ts';
import { createGuestSession, getGuestSession, touchGuestSession } from './db.ts';

export const GUEST_COOKIE = 'mdhub_sid';
/** 会话有效期：180 天。够一个人长期使用，又不至于让 cookie 永久有效 */
const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 180;

/** 从请求头里取出某个 cookie 的值（不引第三方中间件，为此多写十来行） */
export function readCookie(req: Request, name: string): string | null {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    if (part.slice(0, idx).trim() !== name) continue;
    const value = decodeURIComponent(part.slice(idx + 1).trim());
    return value || null;
  }
  return null;
}

function setSessionCookie(res: Response, id: string): void {
  const attrs = [
    `${GUEST_COOKIE}=${id}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${COOKIE_MAX_AGE_SECONDS}`,
  ];
  // 只有走 https 才加 Secure：本地开发是 http，加了浏览器就不带 cookie 了
  if (IS_PRODUCTION) attrs.push('Secure');
  res.setHeader('Set-Cookie', attrs.join('; '));
}

export interface GuestIdentity {
  id: string;
  name: string;
}

/**
 * 取当前访客的会话，没有就新建一个。
 *
 * 访客第一次打开页面就会拿到一个会话——这一步不打扰他，也不记录他在做什么，
 * 只是让他后面「申请访问」时有个可指认的身份。
 */
export function ensureGuestSession(req: Request, res: Response): GuestIdentity {
  const existing = readCookie(req, GUEST_COOKIE);
  if (existing) {
    const row = getGuestSession(existing);
    if (row) {
      touchGuestSession(row.id, Date.now());
      return { id: row.id, name: row.name };
    }
  }
  const id = randomBytes(16).toString('hex');
  const row = createGuestSession(id, `访客${id.slice(0, 4)}`);
  setSessionCookie(res, id);
  return { id: row.id, name: row.name };
}
