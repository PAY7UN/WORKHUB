import { useCallback, useEffect, useMemo, useState } from 'react';
import { Lock, Unlock, UserCheck } from 'lucide-react';
import { toast } from 'sonner';
import { useNavigate } from 'react-router-dom';
import { useApp } from '@/context/AppContext';
import { Button } from '@/components/ui/button';
import type { AccessGrant } from '@/types';

/**
 * 加密文档清单（管理后台 · 加密文档分区）。
 *
 * 从「访问权限」里拆出来，是因为这两件事问的不是同一个问题：
 * - 加密文档：哪些文档以密文保存、谁被放行了、能不能取消加密；
 * - 访问权限：谁在申请、谁已经拿到、什么时候被收回。
 *
 * 以前两件事挤在一页：想给一个目录整体开口子，得先滚过一屏申请单；
 * 想看「到底哪几篇是密文的」，又得从审批列表里把注意力拔回来。
 * 拆开后各有各的落点，中间那条跳转（点文档名 → 看这篇的申请与授权）保留。
 */
export function EncryptedDocsSection() {
  const { docs, listAllAccessGrants, listKnownGuests, bulkGrantAccess, decryptDoc } = useApp();
  const navigate = useNavigate();

  const [grants, setGrants] = useState<AccessGrant[]>([]);
  const [guests, setGuests] = useState<Array<{ id: string; name: string }>>([]);
  const [loading, setLoading] = useState(false);
  /** 批量授权时勾选的加密文档 */
  const [selectedDocs, setSelectedDocs] = useState<string[]>([]);
  /** 批量授权的目标访客 */
  const [grantGuestId, setGrantGuestId] = useState('');
  /** 批量授权的有效期：0 = 长期有效 */
  const [grantTerm, setGrantTerm] = useState(0);
  const [grantBusy, setGrantBusy] = useState(false);

  const encryptedDocs = useMemo(
    () => docs.filter((d) => d.type === 'file' && d.encrypted),
    [docs],
  );

  /** 每篇文档现在有几个人被放行（已撤销的不算） */
  const grantCount = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const g of grants) {
      if (g.revokedAt) continue;
      counts[g.docId] = (counts[g.docId] ?? 0) + 1;
    }
    return counts;
  }, [grants]);

  const load = useCallback(
    async (silent = false) => {
      if (!silent) setLoading(true);
      try {
        const [all, knownGuests] = await Promise.all([listAllAccessGrants(), listKnownGuests()]);
        setGrants(all);
        setGuests(knownGuests);
      } catch (e) {
        if (!silent) toast.error((e as Error)?.message || '读取失败');
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [listAllAccessGrants, listKnownGuests],
  );

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * 勾选里已经不在清单的（例如刚被取消加密）自动去掉。
   *
   * 单独一个 effect，而不是塞进 load 里：load 只管拉数据，
   * 清单本身的变化（取消加密）由这里的收敛负责。
   */
  useEffect(() => {
    setSelectedDocs((prev) => prev.filter((id) => encryptedDocs.some((d) => d.id === id)));
  }, [encryptedDocs]);

  /**
   * 开着这个分区时自动刷新。
   *
   * 授权人数会随别的分区里的审批动作变化，管理员切回来时不该看到过期数字。
   */
  useEffect(() => {
    const timer = setInterval(() => {
      void load(true);
    }, 10_000);
    return () => clearInterval(timer);
  }, [load]);

  /**
   * 批量授权：把勾选的多篇加密文档一次性放行给同一个访客。
   *
   * 「一个目录里的文档都加密了」是常见的用法：访客要申请就得提 N 次、
   * 管理员要批 N 次。这里一次勾选、一次授权。
   *
   * 访客只能从「已知访客」里选——访客的身份是会话 cookie 里的标识，
   * 凭空造一个他登录时不会认得。所以没申请过的人，请他先走申请流程。
   */
  const handleBulkGrant = async () => {
    if (selectedDocs.length === 0 || !grantGuestId) return;
    const guest = guests.find((g) => g.id === grantGuestId);
    setGrantBusy(true);
    try {
      const granted = await bulkGrantAccess(
        grantGuestId,
        guest?.name ?? grantGuestId,
        selectedDocs,
        grantTerm,
      );
      toast.success(`已授权「${guest?.name ?? grantGuestId}」访问 ${granted} 篇文档`);
      setSelectedDocs([]);
      await load(true);
    } catch (e) {
      toast.error((e as Error)?.message || '批量授权失败');
    } finally {
      setGrantBusy(false);
    }
  };

  /** 取消加密：正文恢复明文，访客直接可读 */
  const handleDecrypt = async (id: string, name: string) => {
    try {
      await decryptDoc(id);
      toast.success(`「${name}」已取消加密`);
    } catch (e) {
      toast.error((e as Error)?.message || '取消加密失败');
    }
  };

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-center gap-2">
        <h2 className="flex items-center gap-1.5 text-base font-semibold">
          <Lock className="h-4 w-4 text-indigo-500" />
          加密文档
          {encryptedDocs.length > 0 && (
            <span className="rounded-full bg-indigo-500/15 px-2 py-0.5 text-[11px] text-indigo-600 dark:text-indigo-400">
              {encryptedDocs.length}
            </span>
          )}
        </h2>
      </header>

      {loading && encryptedDocs.length === 0 ? (
        <p className="py-4 text-center text-sm text-muted-foreground">正在读取…</p>
      ) : encryptedDocs.length === 0 ? (
        <p className="py-2 text-[11px] text-muted-foreground">
          没有加密过任何文档（在文档菜单里点「加密文档」即可）
        </p>
      ) : (
        <>
          {/* 批量授权工具条：整个目录都加密时，勾一次就够。
              没有已知访客时整条藏起来——一排点不动的控件只是噪音。 */}
          {guests.length > 0 && (
            <div className="flex flex-wrap items-center gap-2 rounded-lg border border-indigo-100/60 bg-white/50 px-2.5 py-2 dark:border-indigo-900/50 dark:bg-white/5">
              <button
                type="button"
                onClick={() =>
                  setSelectedDocs((prev) =>
                    prev.length === encryptedDocs.length ? [] : encryptedDocs.map((d) => d.id),
                  )
                }
                className="cursor-pointer text-[11px] text-indigo-600 underline-offset-2 hover:underline dark:text-indigo-400"
              >
                {selectedDocs.length === encryptedDocs.length ? '取消全选' : '全选'}
              </button>
              <span className="text-[11px] text-muted-foreground">已选 {selectedDocs.length} 篇</span>
              <select
                value={grantGuestId}
                onChange={(e) => setGrantGuestId(e.target.value)}
                className="h-7 max-w-[10rem] rounded-md border border-slate-200 bg-white/70 px-1.5 text-[11px] dark:border-slate-700 dark:bg-white/5"
              >
                <option value="">选择访客…</option>
                {guests.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                  </option>
                ))}
              </select>
              <select
                value={grantTerm}
                onChange={(e) => setGrantTerm(Number(e.target.value))}
                className="h-7 rounded-md border border-slate-200 bg-white/70 px-1.5 text-[11px] dark:border-slate-700 dark:bg-white/5"
              >
                <option value={0}>长期有效</option>
                <option value={1}>1 天</option>
                <option value={7}>7 天</option>
                <option value={30}>30 天</option>
              </select>
              <Button
                size="sm"
                variant="outline"
                disabled={selectedDocs.length === 0 || !grantGuestId || grantBusy}
                onClick={() => void handleBulkGrant()}
                className="h-7 px-2 text-[11px]"
              >
                <UserCheck className="mr-1 h-3.5 w-3.5" />
                {grantBusy ? '授权中…' : '批量授权'}
              </Button>
            </div>
          )}

          <ul className="space-y-1.5">
            {encryptedDocs.map((doc) => {
              const count = grantCount[doc.id] ?? 0;
              return (
                /*
                 * 一行读完：勾选、锁、名称、授权人数、操作。
                 * 原来每篇占两行八个控件，页面被撑成两屏还没几篇文档。
                 */
                <li
                  key={doc.id}
                  className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-indigo-100/60 bg-white/50 px-3 py-2 dark:border-indigo-900/50 dark:bg-white/5"
                >
                  <input
                    type="checkbox"
                    checked={selectedDocs.includes(doc.id)}
                    onChange={() =>
                      setSelectedDocs((prev) =>
                        prev.includes(doc.id)
                          ? prev.filter((x) => x !== doc.id)
                          : [...prev, doc.id],
                      )
                    }
                    aria-label={`勾选 ${doc.name}`}
                    className="h-3.5 w-3.5 shrink-0 cursor-pointer accent-indigo-500"
                  />
                  <Lock className="h-3.5 w-3.5 shrink-0 text-indigo-500" />
                  <button
                    type="button"
                    onClick={() => navigate(`/admin/access?doc=${encodeURIComponent(doc.id)}`)}
                    title="查看这篇文档的申请与授权"
                    className="min-w-0 cursor-pointer truncate text-sm font-medium hover:underline"
                  >
                    {doc.name}
                  </button>
                  {count > 0 && (
                    <span className="shrink-0 text-[11px] text-muted-foreground">
                      {count} 人已授权
                    </span>
                  )}
                  <button
                    type="button"
                    onClick={() => void handleDecrypt(doc.id, doc.name)}
                    title="取消加密：正文恢复明文，访客直接可读"
                    className="ml-auto flex shrink-0 cursor-pointer items-center gap-1 text-[11px] text-muted-foreground hover:text-red-500"
                  >
                    <Unlock className="h-3.5 w-3.5" />
                    取消加密
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
}
