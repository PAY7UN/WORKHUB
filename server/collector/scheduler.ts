/**
 * 采集调度器：定时把本机 CodeBuddy 的会话痕迹汇成工作日志。
 *
 * 一轮的流程：
 *   1. 列会话，挑出「已空闲且游标没追上」的（见 codebuddy.selectDueSessions）
 *   2. 首次见到的会话只建游标不汇总——不追溯历史，避免上线第一轮
 *      把几十个旧会话一口气全喂给模型
 *   3. 组装痕迹 → 模型小结 → 追加进当天的日志文档 → 写游标
 *
 * 失败语义：汇总失败不动游标，下一轮自然重试；
 * 单轮限制处理个数，失败积压时不会把模型额度一次烧完。
 * 全程不抛异常：采集是旁路任务，它坏了不能拖垮主服务。
 */
import { envFlag, envValue } from '../env.ts';
import { getAgentConfig, getCollectorCursor, setCollectorCursor, defaultRepoId } from '../db.ts';
import { logger } from '../logger.ts';
import {
  buildSessionTrace,
  defaultCodeBuddyRoot,
  listSessions,
  selectDueSessions,
  type CodeBuddyDirs,
} from './codebuddy.ts';
import { summarizeSession } from './summarize.ts';
import { appendSessionEntry, ensureDailyDoc } from './journal.ts';

/** 数据源标识：游标按它隔离 */
const SOURCE = 'codebuddy';

const TICK_INTERVAL_MS = 60_000;
/** 单轮最多处理几个会话：失败积压时限流，不把模型额度一次烧完 */
const MAX_SESSIONS_PER_TICK = 5;

export interface CollectorSettings {
  enabled: boolean;
  dirs?: CodeBuddyDirs;
  /** 空闲判定：会话静默多久才算「结束了」 */
  idleMs: number;
  folderName: string;
  /** 指定仓库 id；空则用默认仓库 */
  repoId: string;
}

export function readCollectorSettings(): CollectorSettings {
  return {
    enabled: envFlag('COLLECTOR_ENABLED'),
    dirs: resolveDirs(),
    idleMs: (Number(envValue('COLLECTOR_IDLE_MINUTES')) || 10) * 60_000,
    folderName: envValue('COLLECTOR_FOLDER') || '日常工作日志',
    repoId: envValue('COLLECTOR_REPO'),
  };
}

function resolveDirs(): CodeBuddyDirs | undefined {
  const override = envValue('COLLECTOR_CODEBUDDY_DIR');
  if (override) return { root: override };
  const fallback = defaultCodeBuddyRoot();
  return fallback ? { root: fallback } : undefined;
}

/** 一轮采集。public 是为了测试：给一个假 dirs 就能端到端走一遍（除模型调用） */
export async function runCollectorTick(settings: CollectorSettings): Promise<number> {
  if (!settings.enabled) return 0;
  if (!settings.dirs) {
    logger.debug('采集器：找不到 CodeBuddy 存储目录，本轮跳过');
    return 0;
  }

  const sessions = listSessions(settings.dirs);
  const due = selectDueSessions(sessions, {
    now: Date.now(),
    idleMs: settings.idleMs,
    cursorOf: (id) => getCollectorCursor(SOURCE, id),
  });
  if (due.length === 0) return 0;

  let processed = 0;
  for (const session of due) {
    if (processed >= MAX_SESSIONS_PER_TICK) break;

    // 首次见到的会话只登记游标：日志从「装上之后」开始记，不追史
    const known = getCollectorCursor(SOURCE, session.conversationId);
    if (known === undefined) {
      setCollectorCursor(SOURCE, session.conversationId, session.updatedAt);
      logger.debug(`采集器：登记已有会话 ${session.conversationId.slice(0, 8)}，不追溯历史`);
      continue;
    }

    try {
      await processSession(settings, session.conversationId, session.updatedAt);
      processed += 1;
    } catch (err) {
      // 不动游标：下轮重试
      logger.warn(`采集器：会话 ${session.conversationId.slice(0, 8)} 处理失败，下轮重试`, (err as Error)?.message);
    }
  }
  if (processed > 0) logger.info(`采集器：本轮汇总了 ${processed} 个会话`);
  return processed;
}

async function processSession(
  settings: CollectorSettings,
  conversationId: string,
  updatedAt: number,
): Promise<void> {
  const cfg = getAgentConfig();
  if (!cfg.apiKey || !cfg.baseUrl || !cfg.model) {
    throw new Error('Agent 未配置模型凭据（管理后台 → Agent 设置）');
  }

  const trace = buildSessionTrace(settings.dirs!, conversationId);
  if (trace.files.length === 0) {
    // 没有文件变更（纯聊天、或全是凭据文件）：登记游标跳过，不值得花模型额度
    setCollectorCursor(SOURCE, conversationId, updatedAt);
    logger.debug(`采集器：会话 ${conversationId.slice(0, 8)} 无可汇总的文件变更，跳过`);
    return;
  }

  const summary = await summarizeSession(cfg, trace);
  const dateKey = formatDateKey(updatedAt);
  const repoId = settings.repoId || defaultRepoId();
  const docId = ensureDailyDoc(repoId, settings.folderName, dateKey);
  const ok = appendSessionEntry(docId, { time: updatedAt, conversationId, summary });
  if (!ok) throw new Error('写入日志文档失败');
  setCollectorCursor(SOURCE, conversationId, updatedAt);
  logger.info(`采集器：会话 ${conversationId.slice(0, 8)} 已写入 ${settings.folderName}/${dateKey}.md`);
}

function formatDateKey(ts: number): string {
  const d = new Date(ts);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

/* ------------------------------ 常驻定时器 ------------------------------ */

let timer: NodeJS.Timeout | undefined;
let running = false;

function tick(): void {
  // 上一轮还没跑完就跳过：汇总可能要等几十秒的模型响应，
  // 硬并发只会把同一个会话写两遍
  if (running) return;
  running = true;
  void runCollectorTick(readCollectorSettings())
    .catch((err) => logger.warn('采集器：本轮异常', (err as Error)?.message))
    .finally(() => {
      running = false;
    });
}

/** 服务启动时调一次：常驻定时器，不阻止进程退出 */
export function startCollectorScheduler(): void {
  const settings = readCollectorSettings();
  if (!settings.enabled) {
    logger.info('采集器：未启用（WORKHUB_COLLECTOR_ENABLED=1 开启）');
    return;
  }
  timer = setInterval(tick, TICK_INTERVAL_MS);
  timer.unref?.();
  logger.info(
    `采集器：已启动（每 ${Math.round(TICK_INTERVAL_MS / 60_000)} 分钟检查一次，空闲 ${settings.idleMs / 60_000} 分钟以上的会话会被汇总）`,
  );
  // 启动后先跑一轮：等服务起来再收，避免拖慢启动
  setTimeout(tick, 15_000).unref?.();
}

/** 优雅停机时清定时器 */
export function stopCollectorScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = undefined;
  }
}
