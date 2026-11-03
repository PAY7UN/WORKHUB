/**
 * 管理接口：给运维面板（托盘 remote 模式）用的一组只管「这台机器怎么了」的端点。
 *
 * 范围划得很窄，就三件事：
 * - 状态：进程、库、版本、各类计数
 * - 日志：最近若干行（已在 logger 里做了脱敏）
 * - 重启：让服务换一份新代码/新配置重新起来
 *
 * 刻意**不包括**文档、账号、模型密钥——那些是管理员账号的地盘。
 * 机器令牌只管这一组端点，拿到它不等于拿到全站（见 server/manageTokens.ts）。
 */
import { spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { arch, platform, release } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Router, type NextFunction, type Request, type Response } from 'express';
import { logger, displayPath, recentLogLines } from './logger.ts';
import { verifyManageToken } from './manageTokens.ts';
import type { V2Database } from './storage/v2/schema.ts';

/** 令牌放在这个头里，而不是 Authorization */
export const MANAGE_TOKEN_HEADER = 'x-workhub-token';

/**
 * 读版本号。
 *
 * 打包后的 payload 里没有 package.json（或者有，但路径未必对），
 * 所以这里读不到就报 unknown——版本号是给人看的，读不到不影响功能。
 */
function readVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(resolve(here, '../package.json'), 'utf8')) as { version?: string };
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * 机器令牌校验。
 *
 * 失败一律 401，且不区分「令牌不存在」和「令牌对不上」——
 * 区分开等于给猜的人一个可以反复试探的信号源。
 */
function requireManageToken(db: V2Database, req: Request, res: Response, next: NextFunction): void {
  const raw = req.headers[MANAGE_TOKEN_HEADER];
  const token = Array.isArray(raw) ? raw[0] : raw;
  if (!token) {
    res.status(401).json({ error: `缺少机器令牌（请用 ${MANAGE_TOKEN_HEADER} 头）` });
    return;
  }
  const record = verifyManageToken(db, token);
  if (!record) {
    res.status(401).json({ error: '机器令牌无效或已撤销' });
    return;
  }
  res.locals.manageToken = record;
  next();
}

/**
 * 认出谁在管着这个进程。
 *
 * 重启这件事的关键不在「怎么重启」，而在「重启后谁来把它拉起来」：
 * 有人管（systemd / docker / pm2）时，我们退出即可，守护进程会重新拉起；
 * 没人管时 exiting 就等于服务彻底停了，得自己再起一个。
 */
function detectSupervisor(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.INVOCATION_ID) return 'systemd';
  if (env.PM2_HOME || env.pm_id) return 'pm2';
  if (existsSync('/.dockerenv')) return 'docker';
  return null;
}

/** 被托盘托管的服务不能自己重启：托盘才是它的父进程监管者 */
function isSupervisedByTray(): boolean {
  return Boolean(process.env.WORKHUB_PARENT_PID);
}

export interface RestartPlan {
  /** 'command' = 交给外部命令；'supervisor' = 退出让守护进程拉起；'self' = 自己再起一个 */
  strategy: 'command' | 'supervisor' | 'self';
  detail: string;
}

/**
 * 决定这次重启怎么做。
 *
 * 优先级：
 * 1. MDHUB_RESTART_CMD —— 运维明确指定了命令（比如 systemctl restart workhub），最省心
 * 2. 认得出守护进程 —— 退出即可，守护进程会接手
 * 3. 都没有 —— 自己再起一个，然后把旧的退出
 *
 * 第 3 条是兜底：像 `node server/index.ts` 这样裸跑的进程，
 * 退出后没人接盘，不自己起一个就等于把服务停了。
 */
export function planRestart(env: NodeJS.ProcessEnv = process.env): RestartPlan {
  const cmd = (env.MDHUB_RESTART_CMD ?? '').trim();
  if (cmd) return { strategy: 'command', detail: cmd };
  const supervisor = detectSupervisor(env);
  if (supervisor) return { strategy: 'supervisor', detail: `由 ${supervisor} 拉起` };
  return { strategy: 'self', detail: '没有守护进程，自己再起一个' };
}

/**
 * 真正执行重启。
 *
 * 三条路径都要保证「响应先发出去，进程再退出」——
 * 顺序反了的话，运维那边看到的是一次连接超时，
 * 根本分不清是重启失败还是服务已经起来了。
 */
function executeRestart(plan: RestartPlan): void {
  const shutdown = (): void => {
    logger.notice('收到重启请求，进程即将退出');
    setTimeout(() => process.exit(0), 300);
  };

  if (plan.strategy === 'command') {
    // 命令由运维自己写，跑失败也不该把服务带沟里：失败就只记日志，不退出
    const [cmd, ...args] = plan.detail.split(/\s+/);
    try {
      const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
      child.on('error', (err) => logger.error(`重启命令执行失败：${err.message}`));
      child.unref();
    } catch (err) {
      logger.error(`重启命令执行失败：${(err as Error).message}`);
    }
    shutdown();
    return;
  }

  if (plan.strategy === 'self') {
    // 用同样的命令行再起一个自己：argv[1] 起是脚本与其后的参数，
    // 原样传给新进程，它就会以完全相同的方式启动。
    const args = process.argv.slice(1);
    try {
      const child = spawn(process.execPath, args, {
        // 清掉托盘的父进程标记：新进程不受托盘管（这条路径只在没有托管者时才走）
        env: { ...process.env, WORKHUB_PARENT_PID: '' },
        detached: true,
        // 沿用父进程的输出：新进程的日志要落到同一个地方（journal / nohup），
        // 否则重启一次，运维那边的日志就断了
        stdio: 'inherit',
      });
      child.on('error', (err) => logger.error(`拉起新进程失败：${err.message}`));
      child.unref();
      logger.notice('已拉起新进程，旧进程退出');
    } catch (err) {
      logger.error(`拉起新进程失败：${(err as Error).message}`);
    }
  }

  shutdown();
}

/** 统计库里各表有多少行 */
function countRows(db: V2Database): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const table of ['repos', 'nodes', 'users']) {
    try {
      const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
      counts[table] = row?.n ?? 0;
    } catch {
      counts[table] = -1; // 读不到就明说读不到，别报 0 让人以为库是空的
    }
  }
  return counts;
}

/** 建管理路由 */
export function createManageRouter(db: V2Database, dbPath: string): Router {
  const router = Router();
  router.use((req, res, next) => requireManageToken(db, req, res, next));

  /**
   * 状态：这台机器现在什么样。
   *
   * 比 /api/healthz 详细得多，但同样只对持机器令牌的人开放——
   * healthz 是公开探针，这里是运维视图。
   */
  router.get('/status', (_req, res) => {
    let dbSize = -1;
    try {
      dbSize = statSync(dbPath).size;
    } catch {
      dbSize = -1;
    }
    const memory = process.memoryUsage();
    res.json({
      status: 'ok',
      version: readVersion(),
      pid: process.pid,
      startedAt: Date.now() - Math.floor(process.uptime() * 1000),
      uptime: Math.floor(process.uptime()),
      runtime: {
        node: process.version,
        platform: `${platform()} ${release()}`,
        arch: arch(),
      },
      memory: {
        rss: memory.rss,
        heapUsed: memory.heapUsed,
      },
      database: {
        path: displayPath(dbPath),
        sizeBytes: dbSize,
      },
      counts: countRows(db),
      supervisor: {
        detected: detectSupervisor(),
        managedByTray: isSupervisedByTray(),
      },
    });
  });

  /** 最近日志：默认 200 行，最多 500 行（缓冲里就这么多） */
  router.get('/logs', (req, res) => {
    const raw = Number(req.query.tail ?? 200);
    const tail = Number.isFinite(raw) ? Math.max(1, Math.min(500, Math.floor(raw))) : 200;
    res.json({ lines: recentLogLines(tail) });
  });

  /**
   * 重启服务。
   *
   * 被托盘托管时拒绝：托盘才是它的监管者，托盘自己的菜单里有「重启服务」，
   * 两边都来一次会起出两个进程抢同一个端口。
   */
  router.post('/restart', (_req, res) => {
    if (isSupervisedByTray()) {
      res.status(409).json({
        error: '这个服务由托盘托管，请在托盘菜单里重启（这里重启会和托盘抢端口）',
      });
      return;
    }
    const plan = planRestart();
    res.json({ ok: true, strategy: plan.strategy, detail: plan.detail });
    executeRestart(plan);
  });

  return router;
}
