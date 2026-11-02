import { useCallback, useEffect, useState } from 'react';
import type { PolishTask } from '../../../shared/types';
import { ApiError, api } from '@/lib/api';

/**
 * 润色任务的状态管理。
 *
 * 任务在服务端后台生成，本 hook 只做两件事：定期拉取任务列表，以及订阅进行中
 * 任务的增量输出。订阅断开（关面板、刷新、SSE 被中断）都不影响任务本身，
 * 重新打开面板时会从服务端补回完整状态。
 *
 * 订阅仅用于让进度「看起来是活的」，因此额外加了轮询兜底：即便所有订阅都失败，
 * 任务结束时列表也会在下一轮轮询中收敛，不会永远停在「进行中」。
 *
 * 列表的时效性由 `epoch` 负责：任务在编辑器侧的 PolishDialog 提交，那里拿不到本 hook，
 * 也无权直接 setTasks，故提交方 bump Context 里的计数器，本 hook 依赖它重新拉取。
 * 少了这一条会出现「Agent 面板开着、提交润色任务、面板里什么都没有」：本地列表停在
 * 提交前（空），而轮询的原条件是「存在 running 任务」——空列表自然没有 running，
 * 于是轮询也不启动，看不到任务恰恰成了看不到任务的原因，只能靠关开面板碰运气。
 *
 * @param enabled 面板是否处于可订阅状态（打开且为管理员）
 * @param epoch   润色任务创建信号，变化时立即重新拉取列表
 */
export function usePolishTasks(enabled: boolean, epoch: number) {
  const [tasks, setTasks] = useState<PolishTask[]>([]);
  /** 进行中任务的实时增量，仅用于展示；最终结果以 task.result 为准 */
  const [live, setLive] = useState<Record<string, string>>({});
  const [reasoning, setReasoning] = useState<Record<string, string>>({});

  const refresh = useCallback(async () => {
    if (!enabled) return;
    try {
      setTasks(await api.listPolishTasks());
    } catch {
      /* 列表拉取失败时保留旧数据，避免面板闪空 */
    }
  }, [enabled]);

  // 首次进入面板拉取一次；此后每次收到创建信号（epoch 变化）也立即拉取。
  // 两个职责合并成一个 effect：分开写会在「首次拉取尚未返回、epoch 又变化」时
  // 各自发一次请求，把同一次列表拉成两遍。
  useEffect(() => {
    void refresh();
  }, [enabled, epoch, refresh]);

  const runningIds = tasks.filter((t) => t.status === 'running').map((t) => t.id).join(',');

  useEffect(() => {
    if (!enabled || !runningIds) return;
    const controllers = runningIds.split(',').map((id) => {
      const controller = new AbortController();
      void api
        .streamPolishTask(id, {
          signal: controller.signal,
          onState: (task) => setTasks((prev) => prev.map((x) => (x.id === task.id ? task : x))),
          onDelta: (text) => setLive((prev) => ({ ...prev, [id]: (prev[id] ?? '') + text })),
          onReasoning: (text) => setReasoning((prev) => ({ ...prev, [id]: (prev[id] ?? '') + text })),
        })
        .catch(() => {
          /* 订阅失败不影响任务，交由轮询收敛 */
        });
      return controller;
    });
    return () => {
      for (const c of controllers) c.abort();
    };
  }, [enabled, runningIds]);

  // 轮询兜底：仅在有进行中任务时启用，无任务时不做无谓请求
  useEffect(() => {
    if (!enabled || !runningIds) return;
    const timer = setInterval(() => {
      void refresh();
    }, 4000);
    return () => clearInterval(timer);
  }, [enabled, runningIds, refresh]);

  const remove = useCallback(
    async (id: string) => {
      // 立即从视图移除，让操作即时反馈；失败时回滚
      const snapshot = tasks;
      setTasks((prev) => prev.filter((t) => t.id !== id));
      setLive((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      // 思考内容同样要清。它与 live 不同，整个面板生命周期里只写不删，
      // 任务记录被删除后仍会残留——「应用后自动删除」让这条路径从偶发变成高频，
      // 泄漏会随使用持续累积
      setReasoning((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      try {
        await api.removePolishTask(id);
        // 请求发出到返回之间，4 秒轮询可能恰好跑一轮，把服务端尚未删掉的
        // 任务重新拉回列表。仅靠开头那次乐观移除，任务会「删不掉又冒出来」。
        setTasks((prev) => prev.filter((t) => t.id !== id));
      } catch (e) {
        // 404 表示服务端已经没有这条记录了（已被清空、淘汰，或服务重启后丢失）。
        // 这时若回滚快照，反而会把一条不存在的任务塞回列表，而且它永远删不掉：
        // 每次点删除都 404，每次都回滚。视为删除成功，不回滚。
        if (!(e instanceof ApiError) || e.status !== 404) setTasks(snapshot);
      }
    },
    [tasks],
  );

  /** 清空已结束的任务。进行中的不受影响，因此不传 cancelRunning */
  const clearFinished = useCallback(async () => {
    setTasks((prev) => prev.filter((t) => t.status === 'running'));
    try {
      return await api.clearFinishedPolishTasks();
    } catch {
      // 重新拉取而不是回滚快照：清空的判定条件（已结束）与本地快照可能不一致
      await refresh();
      throw new Error('清空失败');
    }
  }, [refresh]);

  return { tasks, live, reasoning, refresh, remove, clearFinished };
}