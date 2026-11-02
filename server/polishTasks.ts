/**
 * 润色后台任务。
 *
 * 润色是对全文的重写，动辄数十秒。若沿用「浏览器直连 SSE」的形态，用户只要
 * 误触关闭弹窗，SSE 断开就会连带中止上游请求，已生成的内容全部作废——长耗时与
 * 易中断叠加，体验反而比不润色更差。因此把生成过程提升为服务端任务：
 *
 * - 任务与 HTTP 连接彻底解耦，客户端断开不影响生成，任务跑到终态为止；
 * - 客户端只是订阅者，可随时离开再回来重新订阅，不会丢失已生成的部分；
 * - 状态与结果放在内存中，进程重启即清空——润色产物本就是待确认的草稿，
 *   不值得为它引入持久化表与迁移成本。
 */
import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import type { AgentSettings, PolishTask, PolishTaskStatus } from '../shared/types.ts';
import { buildPolishMessages, countChangedLines, stripPolishArtifacts } from '../shared/polish.ts';
import { decidePolishTaskDisposition } from './polishTaskPolicy.ts';
import { getAgentConfig, insertAgentUsage } from './db.ts';
import { logger } from './logger.ts';
import { readUpstreamStream } from './upstream.ts';

/** 内存任务表：进程重启即丢失，这是有意为之（见文件头说明） */
const tasks = new Map<string, PolishTask>();
/** 订阅者：任务 id → 正在观察它的 SSE 响应集合 */
const subscribers = new Map<string, Set<Response>>();
/** 取消句柄：任务 id → 中断上游请求 */
const controls = new Map<string, AbortController>();

/**
 * 任务保留上限。内存无限增长不可接受，而润色结果属短期草稿，
 * 超过上限后淘汰最旧的已完成任务即可。
 */
const MAX_TASKS = 30;

export function listPolishTasks(): PolishTask[] {
  return [...tasks.values()].sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * 当前正在生成的任务数，供提交新任务时判定并发是否超限。
 *
 * 遍历而非复用一个计数器：任务表是唯一事实来源，多维护一个并发计数就多一处
 * 必须在成功、失败、取消、删除四条路径上同步更新的状态——漏掉任何一条，
 * 计数就会与实际不符，且这种偏差不会自行恢复。
 */
export function countRunningPolishTasks(): number {
  let n = 0;
  for (const t of tasks.values()) {
    if (t.status === 'running') n++;
  }
  return n;
}

/** 中止进行中的上游请求；已不在运行的任务返回 false */
function cancelPolishTask(id: string): boolean {
  const control = controls.get(id);
  if (!control) return false;
  control.abort();
  return true;
}

/** 批量删除的结果。分开计数是为了让调用方能如实回报，不能用一个布尔值掩盖部分失败 */
export interface BatchRemoveResult {
  /** 已删除的任务 id（不含被取消的） */
  removed: string[];
  /** 因正在生成而先取消、再删除的任务 id */
  cancelled: string[];
  /** 不存在、已被淘汰，或按策略跳过的 id */
  missing: string[];
}

/**
 * 批量删除任务。
 *
 * `cancelRunning` 决定遇到进行中任务时怎么办：
 * - false：跳过它，其余照删。用于「清空已完成」，进行中的生成不该被顺手打断；
 * - true ：先 abort 再删掉。用于用户显式勾选后删除——既然明确勾了它，中断是预期行为。
 *
 * 必须区分这两者：若清空历史时把正在生成的任务一并取消，用户会看着生成到一半
 * 凭空消失，且毫不知情是自己点的那一下导致的。
 */
export function removePolishTasks(ids: string[], options: { cancelRunning: boolean }): BatchRemoveResult {
  const removed: string[] = [];
  const cancelled: string[] = [];
  const missing: string[] = [];

  for (const id of ids) {
    const task = tasks.get(id);
    switch (decidePolishTaskDisposition(task, options.cancelRunning)) {
      case 'skip':
        missing.push(id);
        break;
      case 'cancel-and-delete':
        // 先断上游再删表：反序的话 run() 里的 settle 会在任务消失后
        // broadcast 给一个已无人订阅的 id，白跑一次写回
        cancelPolishTask(id);
        closeSubscribers(id);
        tasks.delete(id);
        cancelled.push(id);
        break;
      case 'delete':
        closeSubscribers(id);
        tasks.delete(id);
        removed.push(id);
        break;
    }
  }

  return { removed, cancelled, missing };
}

/** 一次性移除所有已结束（已完成或失败）的任务，进行中的保持不动 */
export function clearFinishedPolishTasks(): BatchRemoveResult {
  const finished = listPolishTasks()
    .filter((t) => t.status !== 'running')
    .map((t) => t.id);
  return removePolishTasks(finished, { cancelRunning: false });
}

function evictOldTasks() {
  if (tasks.size <= MAX_TASKS) return;
  const overflow = tasks.size - MAX_TASKS;
  const removable = listPolishTasks()
    .filter((t) => t.status !== 'running')
    .slice(0, overflow);
  for (const t of removable) {
    tasks.delete(t.id);
    closeSubscribers(t.id);
  }
}

function closeSubscribers(id: string) {
  const set = subscribers.get(id);
  if (!set) return;
  for (const res of set) {
    if (!res.writableEnded) res.end();
  }
  subscribers.delete(id);
}

/** 向某任务的所有订阅者广播一个事件；已断开的订阅者就地清理 */
function broadcast(id: string, event: string, data: unknown) {
  const set = subscribers.get(id);
  if (!set) return;
  for (const res of set) {
    if (res.writableEnded) {
      set.delete(res);
      continue;
    }
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }
}

/** 对外暴露的任务视图 */
export function toView(task: PolishTask): PolishTask {
  return { ...task };
}

/**
 * 注册一个观察任务进度的 SSE 连接。
 *
 * 任务已完成时直接补发终态并关闭连接，使刷新页面或重新打开面板都能立刻
 * 看到结果，而不必依赖前端自己记得增量。
 */
export function subscribePolishTask(req: Request, res: Response, id: string): PolishTask | undefined {
  const task = tasks.get(id);
  if (!task) return undefined;

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  let set = subscribers.get(id);
  if (!set) {
    set = new Set();
    subscribers.set(id, set);
  }
  set.add(res);

  // 订阅者断开只影响它自己的连接，绝不能影响正在生成的任务
  req.on('close', () => {
    subscribers.get(id)?.delete(res);
  });

  res.write(`event: state\ndata: ${JSON.stringify(toView(task))}\n\n`);
  if (task.status !== 'running') res.end();
  return task;
}

/**
 * 创建并启动一个润色任务。
 *
 * 立即返回任务 id，不等待生成结束。调用方不得再把生成过程与某个 HTTP 响应绑定。
 */
export function createPolishTask(input: {
  docId: string;
  docName: string;
  content: string;
  instruction: string;
}): PolishTask {
  evictOldTasks();

  const task: PolishTask = {
    id: randomUUID(),
    docId: input.docId,
    docName: input.docName,
    content: input.content,
    status: 'running',
    result: '',
    reasoning: '',
    error: '',
    createdAt: Date.now(),
    finishedAt: 0,
  };
  tasks.set(task.id, task);

  const control = new AbortController();
  controls.set(task.id, control);

  // 刻意不 await：让生成在后台推进，与创建请求的生命周期无关
  void run(task, input.instruction, control);

  return task;
}

/** 把任务收敛到终态并通知订阅者。只能经此路径改状态，避免遗留「忘记改状态」的分支 */
function settle(task: PolishTask, status: PolishTaskStatus, patch: { result?: string; error?: string }) {
  if (task.status !== 'running') return;
  task.status = status;
  task.result = patch.result ?? '';
  // 只在成功时统计：失败没有可比的结果，算出来的数字只会误导
  task.changedLines = status === 'done' ? countChangedLines(task.content, task.result) : undefined;
  task.error = patch.error ?? '';
  task.finishedAt = Date.now();
  controls.delete(task.id);
  broadcast(task.id, 'state', toView(task));
  closeSubscribers(task.id);
}

/**
 * 生成看护：上游多久没有吐字就判定挂死，以及单条任务的总时长上限。
 *
 * 没有它，任务会永远停在「生成中」——不仅用户看不到结果，它还占着 MAX_RUNNING_POLISH_TASKS
 * 里的一个槽位，把后续所有润色提交都挤成 429。实测中出现过一次任务 5 分钟无任何增量，
 * 表现与「润色无反应」完全一致，用户分不清是模型慢还是程序坏了。
 *
 * 空闲阈值按上游实际的吐字节奏定：实测首字节约 8 秒，之后增量持续到达（正常任务
 * 的 `lastActivityAt` 一直在刷新），所以 300 秒无任何增量几乎必然是上游挂死。
 *
 * 别被「任务总耗时」误导：连续提交会占满并发槽位互相拖慢，实测单个任务总耗时
 * 能在 400~800 秒间波动，但那是排队与并发争抢，不是首字节延迟——看护盯的是
 * 「多久没吐字」，不是「跑了多久」，两者混为一谈会导致阈值被一味调大。
 */
const POLISH_IDLE_TIMEOUT_MS = 300_000;
const POLISH_MAX_DURATION_MS = 20 * 60_000;
const WATCHDOG_INTERVAL_MS = 5_000;

async function run(task: PolishTask, instruction: string, control: AbortController) {
  const cfg: AgentSettings = getAgentConfig();
  // 润色属创作类任务，温度不宜照搬问答的低值，否则输出过于随机、难以直接采用
  const messages = buildPolishMessages(task.content, instruction);

  let buffer = '';
  let lastActivityAt = Date.now();
  /**
   * 已广播出去的清洗结果长度。
   *
   * 用来按**净增量**推送。原先用 `cleaned.slice(-text.length)` 取尾部近似对齐，
   * 但清洗会剥掉 think 块与开场白，cleaned 的增长比原始增量慢；一旦 cleaned
   * 的长度不足 text.length，这个切片就会把早先已经推送过的内容再推一遍，
   * 前端的实时预览里会出现整段重复。
   */
  let pushed = 0;

  const watchdog = setInterval(() => {
    if (task.status !== 'running') return;
    const idleMs = Date.now() - lastActivityAt;
    const totalMs = Date.now() - task.createdAt;
    const reason =
      idleMs >= POLISH_IDLE_TIMEOUT_MS
        ? `模型在 ${Math.round(POLISH_IDLE_TIMEOUT_MS / 1000)} 秒内没有返回任何内容，已中止本次润色。` +
          '请重试，或改用更短的分段文档'
        : totalMs >= POLISH_MAX_DURATION_MS
          ? `本次润色超过 ${Math.round(POLISH_MAX_DURATION_MS / 60000)} 分钟上限，已中止。` +
            '文档可能过长，建议拆分后再润色'
          : '';
    if (!reason) return;
    // 先收敛终态再 abort：readUpstreamStream 抛 AbortError 后会回到下面的状态检查，
    // 那时任务已是 error 而非 running，不会被覆盖成「已取消」
    settle(task, 'error', { error: reason });
    control.abort();
  }, WATCHDOG_INTERVAL_MS);
  // 看护定时器不应拖住进程退出
  watchdog.unref?.();

  try {
    await readUpstreamStream({
      // 润色固定用较高的温度：把叙述改造成列表/表格属于结构性重排，
      // 低温（全局默认 0.3）下模型倾向逐字照抄原文，结构化几乎不会发生
      cfg: { ...cfg, temperature: 0.8 },
      messages,
      signal: control.signal,
      handlers: {
        onReasoning: (text) => {
          lastActivityAt = Date.now();
          task.reasoning += text;
          broadcast(task.id, 'reasoning', { text });
        },
        onDelta: (text) => {
          lastActivityAt = Date.now();
          // 增量先入缓冲，广播出去的是清洗后结果的尾部
          buffer += text;
          const cleaned = stripPolishArtifacts(buffer, instruction);
          // 按净增量推送：只发 cleaned 相对上次多出来的部分。
          // 最终结果仍以 state 里的完整 result 为准
          if (cleaned.length > pushed) {
            broadcast(task.id, 'delta', { text: cleaned.slice(pushed) });
            pushed = cleaned.length;
          }
          return true;
        },
        onError: (message) => settle(task, 'error', { error: message }),
        onUsage: (usage) => {
          // 润色是后台任务，客户端可能早已断开，故只落库不广播；
          // 落库失败同样不能带崩已生成的润色结果
          try {
            insertAgentUsage({ scene: 'polish', model: cfg.model, usage });
          } catch (e) {
            logger.warn('token 用量记录失败', e);
          }
        },
      },
    });
  } finally {
    clearInterval(watchdog);
  }

  // 已被 onError 收敛、被看护中止，或被用户取消
  if (task.status !== 'running') return;

  if (control.signal.aborted) {
    settle(task, 'error', { error: '已取消' });
    return;
  }

  // 流已完整，此时的清洗结果才是最终结果：增量阶段 buffer 不完整，
  // 指令回声只到一半时无法匹配，靠这一次兜住
  const cleaned = stripPolishArtifacts(buffer, instruction);
  if (!cleaned.trim()) {
    settle(task, 'error', {
      error: task.reasoning
        ? '模型只返回了思考过程而未输出正文，请重试，或在 Agent 设置里改用非推理模型'
        : '模型未返回任何内容，请检查模型名与 API Key',
    });
    return;
  }
  settle(task, 'done', { result: cleaned });
}