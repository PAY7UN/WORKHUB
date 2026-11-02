/**
 * 监听加密文档的访问权失效（SSE）。
 *
 * 【为什么必须有这条通道】「收回授权」只有两个含义：权限没了，
 * 和对方知道了。少了后半个，管理员点完「收回」之后，对方屏幕上
 * 那份明文还稳稳地挂着、能选中、能复制——收回动作只是给了自己一个
 * 心理安慰，文档内容其实还在对方手里。
 *
 * 服务端在授权失效（被撤销 / 已过期）的瞬间推一条 revoked 事件，
 * 本 hook 收到就转给调用方，由调用方把明文从内存里抹掉、切回锁定界面。
 */
import { useEffect } from 'react';

/**
 * @param docId    要监听的文档；null 表示不监听
 * @param enabled  是否真的处于「已解锁并在看」的状态
 * @param onRevoked 授权失效时的回调
 */
export function useAccessWatch(
  docId: string | null,
  enabled: boolean,
  onRevoked: () => void,
): void {
  useEffect(() => {
    if (!docId || !enabled) return;

    // 同源相对路径：访客的会话 cookie 会自动带上（EventSource 不能自定义 header，
    // 靠的正是浏览器同源自动携带 cookie 这条规矩）
    const source = new EventSource(`/api/docs/${docId}/access-watch`);

    const handleRevoked = (event: Event) => {
      // 载荷目前只有原因字段，用不上也照样解析一遍：坏数据不该让界面崩掉
      try {
        JSON.parse((event as MessageEvent).data);
      } catch {
        /* 忽略坏载荷，事件本身仍然算作「授权已失效」 */
      }
      onRevoked();
    };

    source.addEventListener('revoked', handleRevoked as EventListener);
    return () => {
      source.removeEventListener('revoked', handleRevoked as EventListener);
      source.close();
    };
  }, [docId, enabled, onRevoked]);
}
