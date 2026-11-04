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
import { statSync } from 'node:fs';
import { arch, platform, release } from 'node:os';
import { Router, type NextFunction, type Request, type Response } from 'express';
import { logger, displayPath, recentLogLines } from './logger.ts';
import { verifyManageToken } from './manageTokens.ts';
import {
  checkForUpdate,
  startUpgrade,
} from './updater.ts';
import type { V2Database } from './storage/v2/schema.ts';
import {
  currentVersion,
  detectSupervisor,
  isSupervisedByTray,
  planRestartFallback,
  type RestartPlan,
} from './host.ts';

/** 令牌放在这个头里，而不是 Authorization */
export const MANAGE_TOKEN_HEADER = 'x-workhub-token';

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
 * 「谁在管着这个进程」和「被托盘托管」的判断都搬到 host.ts 了。
 *
 * 之前 manage.ts 和 updater.ts 各写了一份 systemd/pm2/docker 的判断，
 * 两边对同一个进程的答案必须一致——不一致的后果是起两个进程抢同一个端口，
 * 或者一个都不起。
 */

/**
 * 决定这次重启怎么做。
 *
 * 判断本身在 host.ts：自动升级走的是同一份逻辑，两边答案必须一致——
 * 不一致的后果是升级时和重启时各按各的想法来，一个起不来进程，一个抢端口。
 * 这里转出去是为了不改动已有的调用点。
 */
export function planRestart(env: NodeJS.ProcessEnv = process.env): RestartPlan {
  return planRestartFallback(env);
}
export type { RestartPlan };

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
export interface ManageHooks {
  /**
   * 优雅停机的回调。
   *
   * 由入口注入，manage.ts 自己不碰进程生命周期——它只负责把「该停了」这件事
   * 告诉外面，具体怎么收摊由入口说了算。
   */
  shutdown?: (reason: string) => void;
}

export function createManageRouter(db: V2Database, dbPath: string, hooks: ManageHooks = {}): Router {
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
      version: currentVersion(),
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

  /**
   * 停机（不拉新的起来）。
   *
   * 给 Windows 服务宿主用：SCM 说「停」，宿主就调这个接口让服务自己收摊，
   * 而不是一棍子打死进程——强杀会打断正在写的事务（SQLite 靠 WAL 兜底，
   * 但正在跑的导入任务会被腰斩）。
   *
   * 被托盘托管时同样拒绝：托盘会把服务拉回来，这里停了就等于跟托盘对着干。
   */
  router.post('/shutdown', (_req, res) => {
    if (isSupervisedByTray()) {
      res.status(409).json({
        error: '这个服务由托盘托管，请在托盘菜单里停止（这里停了托盘会再拉起来）',
      });
      return;
    }
    res.json({ ok: true, detail: '正在关闭' });
    // 响应先发出去，再走关闭流程，否则调用方看到的是连接被掐断
    setTimeout(() => {
      if (hooks.shutdown) hooks.shutdown('管理接口请求');
      else {
        logger.notice('收到停止请求，进程即将退出');
        process.exit(0);
      }
    }, 200);
  });

  /**
   * 查更新。
   *
   * 查不到不算失败——没网、GitHub 限流、压根没发 Release，这些都会发生。
   * 所以这里返回 200，把错误放在 error 字段里：调用方（托盘、前端）
   * 能区分「没有新版本」和「查不到」，这两种在界面上该说的话不一样。
   */
  router.get('/update', async (_req, res) => {
    res.json(await checkForUpdate());
  });

  /**
   * 执行升级。
   *
   * 真正的活儿在 startUpgrade 里：下载校验解包 → 起更新器 → 写标记 → 退出。
   * 这里只负责把结果翻译成 HTTP 响应。
   */
  router.post('/update', async (_req, res) => {
    const result = await startUpgrade({
      onReady: () => {
        // 响应先发出去，再退出，否则调用方看到的是连接被掐断
        setTimeout(() => {
          if (hooks.shutdown) hooks.shutdown('自动升级');
          else process.exit(0);
        }, 300);
      },
    });
    if (!result.ok) {
      res.status(result.status ?? 500).json({ error: result.error ?? '升级失败' });
      return;
    }
    res.json(result);
  });

  return router;
}
