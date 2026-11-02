import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertCircle, Lock, RefreshCw, Unlock, UserCheck } from 'lucide-react';
import { toast } from 'sonner';
import { useApp } from '@/context/AppContext';
import { Button } from '@/components/ui/button';
import { formatRelativeTime } from '@/utils';

/**
 * 加密文档清单（管理后台 · 加密文档分区，仅管理员）。
 *
 * 回答的是「现在有哪些文档是加密的、加密了多久、有几个人被放行」。
 *
 * 【这里没有密码】以前这个分区叫「访问密码」，列的是每个文档的访问密码，
 * 管理员可以随时取回、复制、换发。现在加密文档一律走申请制：
 * 服务端不签发、也不存储任何访客口令，数据密钥只由主密钥包裹。
 * 于是这个分区从「密码仓库」变成了「加密文档总览」——
 * 要放行谁，去「访问授权」分区批申请；要收回谁，在那里撤销。
 */
export function EncryptedSection() {
  const {
    docs,
    listAllAccessGrants,
    listKnownGuests,
    decryptDoc,
    bulkGrantAccess,
    openAdminConsole,
  } = useApp();
  const [grantCount, setGrantCount] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  /** 批量授权：勾选的文档 */
  const [selected, setSelected] = useState<string[]>([]);
  /** 已知访客（申请过或已获授权的） */
  const [guests, setGuests] = useState<Array<{ id: string; name: string }>>([]);
  /** 批量授权的目标访客 */
  const [guestId, setGuestId] = useState('');
  /** 批量授权的有效期：0 = 长期有效 */
  const [term, setTerm] = useState(0);
  const [busy, setBusy] = useState(false);

  /** 加密文档列表：直接用全局清单过滤，不额外请求 */
  const encryptedDocs = useMemo(() => docs.filter((d) => d.type === 'file' && d.encrypted), [docs]);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [grants, knownGuests] = await Promise.all([listAllAccessGrants(), listKnownGuests()]);
      const counts: Record<string, number> = {};
      for (const g of grants) {
        // 已撤销的授权不再算「现在谁能看」
        if (g.revokedAt) continue;
        counts[g.docId] = (counts[g.docId] ?? 0) + 1;
      }
      setGrantCount(counts);
      setGuests(knownGuests);
    } catch (e) {
      setError((e as Error)?.message || '读取失败');
    } finally {
      setLoading(false);
    }
  }, [listAllAccessGrants, listKnownGuests]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleDecrypt = async (id: string, name: string) => {
    try {
      await decryptDoc(id);
      await load();
      toast.success(`「${name}」已取消加密`);
    } catch (e) {
      toast.error((e as Error)?.message || '取消加密失败');
    }
  };

  const handleOpenGrants = (id: string, name: string) => {
    openAdminConsole('access', { docId: id, docName: name });
  };

  const toggleSelected = (id: string) => {
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  /**
   * 批量授权：把勾选的多篇文档一次性放行给同一个访客。
   *
   * 「一个目录里的文档都加密了」是常见的用法：访客要申请就得提 N 次、
   * 管理员要批 N 次。这里一次勾选、一次授权。
   *
   * 访客只能从「已知访客」里选——访客的身份是会话 cookie 里的标识，
   * 凭空造一个他登录时不会认得。所以没申请过的人，请他先走申请流程。
   */
  const handleBulkGrant = async () => {
    if (selected.length === 0 || !guestId) return;
    const guest = guests.find((g) => g.id === guestId);
    setBusy(true);
    try {
      const granted = await bulkGrantAccess(guestId, guest?.name ?? guestId, selected, term);
      toast.success(`已授权「${guest?.name ?? guestId}」访问 ${granted} 篇文档`);
      setSelected([]);
      await load();
    } catch (e) {
      toast.error((e as Error)?.message || '批量授权失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      <p className="text-xs leading-relaxed text-muted-foreground">
        这里列出所有以密文保存的文档。加密文档对访客不可读：他们需要提交访问申请，
        由你在「访问授权」分区批准后才能查看，批准与撤销都随时可做。服务端不保存任何访问密码。
      </p>

      {loading && encryptedDocs.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground">正在读取…</p>
      ) : error ? (
        <div className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-500 dark:border-red-900 dark:bg-red-950/30">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      ) : encryptedDocs.length === 0 ? (
        <div className="py-10 text-center">
          <Lock className="mx-auto mb-3 h-8 w-8 text-slate-300 dark:text-slate-600" />
          <p className="text-sm text-muted-foreground">还没有加密过任何文档</p>
          <p className="mt-1 text-xs text-muted-foreground">在文档菜单里点「加密文档」即可</p>
        </div>
      ) : (
        <>
          {/* 批量授权工具条：整个目录都加密时，勾一次就够 */}
          <div className="flex flex-wrap items-center gap-2 rounded-lg border border-indigo-100/60 bg-white/50 px-2.5 py-2 dark:border-indigo-900/50 dark:bg-white/5">
            <button
              type="button"
              onClick={() =>
                setSelected((prev) =>
                  prev.length === encryptedDocs.length ? [] : encryptedDocs.map((d) => d.id),
                )
              }
              className="cursor-pointer text-[11px] text-indigo-600 underline-offset-2 hover:underline dark:text-indigo-400"
            >
              {selected.length === encryptedDocs.length ? '取消全选' : '全选'}
            </button>
            <span className="text-[11px] text-muted-foreground">已选 {selected.length} 篇</span>
            <select
              value={guestId}
              onChange={(e) => setGuestId(e.target.value)}
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
              value={term}
              onChange={(e) => setTerm(Number(e.target.value))}
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
              disabled={selected.length === 0 || !guestId || busy}
              onClick={() => void handleBulkGrant()}
              className="h-7 px-2 text-[11px]"
            >
              <UserCheck className="mr-1 h-3.5 w-3.5" />
              {busy ? '授权中…' : '批量授权'}
            </Button>
          </div>

          {guests.length === 0 && (
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              还没有已知访客（访客要先提交一次访问申请才会出现在这里），
              批量授权需要从这里选择一位访客。
            </p>
          )}

          <ul className="space-y-2">
          {encryptedDocs.map((doc) => {
            const count = grantCount[doc.id] ?? 0;
            return (
              <li
                key={doc.id}
                className="rounded-lg border border-indigo-100/60 bg-white/50 px-3 py-2.5 dark:border-indigo-900/50 dark:bg-white/5"
              >
                <div className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={selected.includes(doc.id)}
                    onChange={() => toggleSelected(doc.id)}
                    aria-label={`勾选 ${doc.name}`}
                    className="h-3.5 w-3.5 shrink-0 cursor-pointer accent-indigo-500"
                  />
                  <Lock className="h-3.5 w-3.5 shrink-0 text-indigo-500" />
                  <span className="truncate text-sm font-medium">{doc.name}</span>
                  <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">
                    {doc.lockedAt ? `${formatRelativeTime(doc.lockedAt)}加密` : ''}
                    {' · '}
                    {count > 0 ? `${count} 人已授权` : '暂无授权'}
                  </span>
                </div>

                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => handleOpenGrants(doc.id, doc.name)}
                    title="查看这篇文档的访问申请与授权名单"
                  >
                    <UserCheck className="h-3.5 w-3.5" />
                    访问授权
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => void handleDecrypt(doc.id, doc.name)}
                    title="取消加密：正文恢复明文，访客直接可读"
                  >
                    <Unlock className="h-3.5 w-3.5" />
                    取消加密
                  </Button>
                </div>
              </li>
            );
          })}
          </ul>
        </>
      )}

      <div className="flex items-center justify-between gap-2">
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          加密文档的正文不会进入 Agent 的检索范围，管理员身份也不例外。
        </p>
        <Button size="sm" variant="ghost" onClick={() => void load()} disabled={loading}>
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
          刷新
        </Button>
      </div>
    </div>
  );
}
