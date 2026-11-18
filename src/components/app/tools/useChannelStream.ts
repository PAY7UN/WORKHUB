import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import type { ChannelRecord, ChannelSession } from '../../../../shared/tools';

/** 界面上最多留多少条记录 */
export const MAX_ROWS = 500;

export interface ChannelStream {
  /** 已收到的记录（最新的在最后） */
  records: ChannelRecord[];
  /** 会话当前状态 */
  session: ChannelSession | null;
  /** 连上来的对端（串口没有，就是空） */
  peers: string[];
  /** 出错时的原因 */
  error: string;
  /** 补拉一次记录：停止的瞬间可能还有最后几条没推过来 */
  refresh: () => Promise<void>;
}

/**
 * 订阅一个通道的实时数据。
 *
 * 先拉一次快照（历史记录 + 当前状态），再接上增量流——
 * 这样控制台刷新页面也能把之前的东西接回来，不用从头听。
 *
 * 通道跑在服务端：关掉页面它照跑，回头打开还在。
 */
export function useChannelStream(sessionId: string | null): ChannelStream {
  const [records, setRecords] = useState<ChannelRecord[]>([]);
  const [session, setSession] = useState<ChannelSession | null>(null);
  const [peers, setPeers] = useState<string[]>([]);
  const [error, setError] = useState('');
  const streamRef = useRef<AbortController | null>(null);

  /** 补拉记录（游标之后的部分） */
  const refresh = useCallback(async () => {
    if (!sessionId) return;
    const last = records.length ? records[records.length - 1].id : 0;
    try {
      const { session: next, records: tail } = await api.tools.records(sessionId, last);
      if (tail.length) setRecords((prev) => [...prev, ...tail].slice(-MAX_ROWS));
      setSession(next);
      setPeers(next.peers);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [sessionId, records]);

  /** 快照：先把已有的东西拿回来 */
  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    void api.tools
      .records(sessionId, 0)
      .then(({ session: next, records: list }) => {
        if (cancelled) return;
        setSession(next);
        setPeers(next.peers);
        setRecords(list.slice(-MAX_ROWS));
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  /**
   * 增量流：只在跑着的时候接。
   *
   * 状态从 running 变成别的时，这个 effect 会自动收摊——
   * 通道停了，SSE 也就没有意义了。
   */
  useEffect(() => {
    if (!sessionId || session?.status !== 'running') return;
    const controller = new AbortController();
    streamRef.current = controller;
    api.tools
      .streamChannel(sessionId, {
        onSnapshot: (snap) => {
          setRecords(snap.records.slice(-MAX_ROWS));
          setSession(snap.session);
          setPeers(snap.session.peers);
        },
        onRecord: (record) => {
          setRecords((prev) => [...prev, record].slice(-MAX_ROWS));
          // 流量计数也顺手跟上：状态事件只在状态变化时才来，
          // 光等它的话，字节数要等到下次状态变化才更新。
          setSession((prev) =>
            prev
              ? {
                  ...prev,
                  bytesIn: prev.bytesIn + (record.direction === 'in' ? record.bytes : 0),
                  bytesOut: prev.bytesOut + (record.direction === 'out' ? record.bytes : 0),
                }
              : prev,
          );
        },
        onStatus: (next) => setSession(next),
        onPeers: (next) => setPeers(next),
        signal: controller.signal,
      })
      .catch((err) => {
        if ((err as Error)?.name === 'AbortError') return;
        setError(err instanceof Error ? err.message : String(err));
      });
    return () => controller.abort();
  }, [sessionId, session?.status]);

  return { records, session, peers, error, refresh };
}
