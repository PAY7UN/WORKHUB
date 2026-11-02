/**
 * 加密文档的访问权监听（SSE）。
 *
 * 【为什么必须有这条通道】「收回授权」只有两个含义：权限没了，
 * 和对方知道了。少了后半个，管理员点完「收回」之后，对方屏幕上
 * 那份明文还稳稳地挂着、能选中、能复制——收回动作只是给了自己一个
 * 心理安慰，文档内容其实还在对方手里。
 *
 * 所以这里让访客打开加密文档时开一条长连接：服务端在授权失效
 * （被撤销 / 已过期）的瞬间推一条 revoked 事件，前端据此把明文
 * 从内存里抹掉、切回锁定界面。
 *
 * 【两个失效来源都要覆盖】
 * - 撤销：管理员点「收回」时立即推送，秒级生效；
 * - 过期：授权带有效期，到期即失效——没有任何操作触发推送，
 *   只能靠服务端巡检兜底。
 */
import type { Request, Response } from 'express';
import { findActiveGrant } from './db.ts';

/** docId → guestId → 该访客在该文档上的所有连接 */
const watchers = new Map<string, Map<string, Set<Response>>>();

/** 心跳间隔：连接静默太久会被中间代理与浏览器悄悄掐掉 */
const HEARTBEAT_MS = 25_000;

/** 巡检间隔：授权是「到期即失效」的，到期那一刻没有任何操作来触发推送 */
const SWEEP_MS = 15_000;

/**
 * 注册一条访问权监听连接。
 *
 * 调用方须先自行校验该访客此刻确实持有有效授权——这里只负责通道，
 * 不负责准入判断。
 */
export function subscribeAccessWatch(req: Request, res: Response, docId: string, guestId: string): void {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  let byGuest = watchers.get(docId);
  if (!byGuest) {
    byGuest = new Map();
    watchers.set(docId, byGuest);
  }
  let set = byGuest.get(guestId);
  if (!set) {
    set = new Set();
    byGuest.set(guestId, set);
  }
  set.add(res);

  // 心跳用注释行（: ping）：SSE 客户端会忽略它，却能让连接不被判定为空闲
  const heartbeat = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      /* 连接已断，等 close 事件来清理 */
    }
  }, HEARTBEAT_MS);
  // unref：这个定时器不该让进程（乃至测试进程）没法退出
  heartbeat.unref?.();

  const cleanup = () => {
    clearInterval(heartbeat);
    const bucket = watchers.get(docId);
    const conns = bucket?.get(guestId);
    conns?.delete(res);
    if (conns && conns.size === 0) bucket?.delete(guestId);
    if (bucket && bucket.size === 0) watchers.delete(docId);
  };
  // 访客关掉标签页、或者网络断了，都走 close
  req.on('close', cleanup);
  res.on('error', cleanup);
}

/** 往某个访客在某篇文档上的所有连接推一条 revoked 事件 */
export function notifyAccessRevoked(docId: string, guestId: string, reason = 'revoked'): void {
  const conns = watchers.get(docId)?.get(guestId);
  if (!conns || conns.size === 0) return;
  const payload = `event: revoked\ndata: ${JSON.stringify({ docId, reason })}\n\n`;
  for (const res of conns) {
    try {
      res.write(payload);
    } catch {
      /* 单条连接写失败不影响其他连接 */
    }
  }
}

/**
 * 巡检：把已经失效的授权从各连接上清掉。
 *
 * 撤销有推送可依，到期没有——只能定期看一眼授权还在不在。
 * 连接最多的场景（几十个访客同时看着文档）也只几十次轻量查询，
 * 换来的是「到期即失效」这件事真的成立。
 */
function sweep(): void {
  for (const [docId, byGuest] of watchers) {
    for (const [guestId, conns] of byGuest) {
      if (findActiveGrant(docId, guestId)) continue;
      // 授权已经不存在（被收回或已过期）：通知并断开
      const payload = `event: revoked\ndata: ${JSON.stringify({ docId, reason: 'inactive' })}\n\n`;
      for (const res of conns) {
        try {
          res.write(payload);
          res.end();
        } catch {
          /* 忽略写入失败 */
        }
      }
      conns.clear();
      byGuest.delete(guestId);
    }
    if (byGuest.size === 0) watchers.delete(docId);
  }
}

const sweepTimer = setInterval(sweep, SWEEP_MS);
// unref：巡检不该拖住进程退出
sweepTimer.unref?.();
