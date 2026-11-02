/**
 * 提醒调度器：常驻巡检到期的提醒并推送到钉钉。
 *
 * 为什么用轮询而不是事件订阅：
 * 提醒是「到点发一条消息」，精度要求是分钟级而非毫秒级，
 * 30 秒一轮足够，且不引入任何外部依赖——服务端起得来就自带调度能力。
 *
 * 提醒记录落在 SQLite，进程重启不丢：重启后第一轮巡检立刻把过期的提醒补发。
 */
import { computeNextFutureFireAt, pushReminder, safeErrorMessage } from './dingtalk.ts';
import { getDingTalkConfig, listDueReminders, updateReminder } from './db.ts';
import { logger } from './logger.ts';

/** 巡检间隔 */
const SWEEP_MS = 30_000;

/**
 * 失败后的重试间隔。
 *
 * 推送失败（网络抖动、钉钉临时不可用）时不该丢提醒，也不该每 30 秒重试一次
 * 把自己刷成 spam：把下次触发时间往后推 5 分钟，错误原因记在 last_error 里。
 */
const RETRY_DELAY_MS = 5 * 60_000;

/** 上一轮巡检是否还在跑：没跑完就跳过本轮，避免任务堆积 */
let sweeping = false;

/**
 * 巡检一轮：把到期的提醒推送到钉钉。
 *
 * 导出为独立函数是为了能直接调用（接口里的「立即发送」也走同一条路径，
 * 行为与自动触发完全一致）。
 */
export async function sweepReminders(now = Date.now()): Promise<{ fired: number; failed: number }> {
  const cfg = getDingTalkConfig();
  if (!cfg.enabled) return { fired: 0, failed: 0 };

  const due = listDueReminders(now);
  let fired = 0;
  let failed = 0;

  for (const reminder of due) {
    try {
      const result = await pushReminder(cfg, reminder, reminder.channel);
      const nextAt = computeNextFutureFireAt(reminder.repeat, reminder.remindAt, now);
      if (nextAt === null) {
        // 一次性提醒：推送成功即终态
        updateReminder(reminder.id, {
          status: 'sent',
          firedAt: Date.now(),
          fireCount: reminder.fireCount + 1,
          lastError: '',
          todoId: result.todoId ?? reminder.todoId,
        });
      } else {
        // 重复提醒：顺延到下一次，仍处于待触发状态
        updateReminder(reminder.id, {
          status: 'pending',
          remindAt: nextAt,
          firedAt: Date.now(),
          fireCount: reminder.fireCount + 1,
          lastError: '',
          todoId: result.todoId ?? reminder.todoId,
        });
      }
      fired += 1;
      logger.info(`提醒已推送到钉钉：${reminder.title}`);
    } catch (e) {
      failed += 1;
      const message = safeErrorMessage(e);
      // 状态仍为 pending，只是把触发时间往后推，避免刷屏式重试
      updateReminder(reminder.id, {
        status: 'pending',
        remindAt: now + RETRY_DELAY_MS,
        lastError: message,
      });
      logger.warn(`提醒推送失败（5 分钟后重试）：${reminder.title} —— ${message}`);
    }
  }

  return { fired, failed };
}

/** 单轮巡检的执行包装：串行化，避免多轮叠加 */
async function runOnce(): Promise<void> {
  if (sweeping) return;
  sweeping = true;
  try {
    await sweepReminders();
  } catch (e) {
    logger.warn('提醒巡检异常', e);
  } finally {
    sweeping = false;
  }
}

/**
 * 启动调度器。
 *
 * unref() 让这个定时器不阻止进程退出（与 server/accessWatch.ts 同一处理）：
 * 服务被停掉时不该因为还挂着一个定时器而卡住不退出。
 */
export function startReminderScheduler(): void {
  const timer = setInterval(() => {
    void runOnce();
  }, SWEEP_MS);
  timer.unref();
  // 启动即先扫一轮：进程重启后过期的提醒能立刻补发，而不是干等 30 秒
  void runOnce();
  logger.info('提醒调度器已启动，每 30 秒巡检一次到期的提醒');
}
