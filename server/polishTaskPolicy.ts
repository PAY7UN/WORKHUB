/**
 * 润色任务的批量删除策略。
 *
 * 与 polishTasks.ts 分开的原因只有一个：批量删除里唯一有风险的部分是
 * 「会不会误伤正在生成的任务」，而它必须在不触碰内存任务表、不触发上游请求的
 * 前提下被穷举验证。放在同一个文件里，测这个函数就得先把 db、upstream、
 * 环境变量全部拉起来——于是这段策略实际上永远不会被测到。
 *
 * 本文件不得引入任何副作用或依赖。
 */
import type { PolishTask } from '../shared/types.ts';

/** 单个任务在批量删除中的处置方式 */
export type PolishTaskDisposition =
  /** 已结束，直接删除 */
  | 'delete'
  /** 正在生成：先中断上游、再删除 */
  | 'cancel-and-delete'
  /** 不存在，或按策略跳过 */
  | 'skip';

/**
 * 判定单个任务的处置方式。
 *
 * @param cancelRunning true 表示调用方显式要求一并中断进行中的生成
 *                      （用户在多选里明确勾了它）；false 表示只清理已结束的
 *                      （如「清空已完成」），此时绝不能打断正在跑的润色。
 */
export function decidePolishTaskDisposition(
  task: PolishTask | undefined,
  cancelRunning: boolean,
): PolishTaskDisposition {
  if (!task) return 'skip';
  if (task.status !== 'running') return 'delete';
  return cancelRunning ? 'cancel-and-delete' : 'skip';
}