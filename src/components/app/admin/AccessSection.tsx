import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Check,
  Clock,
  Download,
  Eye,
  Inbox,
  Lock,
  ScrollText,
  ShieldOff,
  Unlock,
  UserCheck,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import { useApp } from '@/context/AppContext';
import { Button } from '@/components/ui/button';
import type { AccessAuditEntry, AccessCapability, AccessGrant, AccessRequest } from '@/types';
import { ACCESS_AUDIT_LABELS, ACCESS_CAPABILITY_LABELS } from '@/types';
import { formatRelativeTime } from '@/utils';

/**
 * 授权到期时间的显示。
 *
 * 不能用 formatRelativeTime：那个函数是给「过去的时间」用的，
 * 拿它去算未来的到期点只会得到「刚刚」——拼出来就是「刚刚到期」这种笑话。
 */
function formatExpiry(ts: number | null): string {
  if (ts === null) return '长期有效';
  const diff = ts - Date.now();
  if (diff <= 0) return '已过期';
  const days = Math.floor(diff / 86400000);
  if (days >= 1) return `${days} 天后到期`;
  const hours = Math.floor(diff / 3600000);
  if (hours >= 1) return `${hours} 小时后到期`;
  return `${Math.max(1, Math.floor(diff / 60000))} 分钟后到期`;
}

/**
 * 能力选择器。
 *
 * 「查看正文」是底线，恒定打开且不可取消——不给人看却给下载，
 * 那只是让人绕远路拿文件。「下载原件」是额外口子，要管理员主动勾。
 *
 * 摆成两个并排的按钮而不是一组复选框，是因为它们不是同类项：
 * 一个是默认就有的，一个是要额外给的。复选框会把两者摆成平级，
 * 让人以为「查看」也是要自己选才生效的。
 */
function CapabilityPicker({
  value,
  onChange,
  size = 'sm',
}: {
  value: AccessCapability[];
  onChange: (next: AccessCapability[]) => void;
  size?: 'sm' | 'xs';
}) {
  const downloadOn = value.includes('download');
  const h = size === 'xs' ? 'h-7' : 'h-8';
  const px = size === 'xs' ? 'px-2' : 'px-2.5';
  const fs = size === 'xs' ? 'text-[11px]' : 'text-xs';

  return (
    <div className="flex items-center gap-1">
      <span
        className={`${h} ${px} ${fs} inline-flex items-center gap-1 rounded-md border border-indigo-200/70 bg-indigo-50/70 text-indigo-700 dark:border-indigo-800/60 dark:bg-indigo-950/40 dark:text-indigo-300`}
        title="查看正文是访问授权的底线，恒定包含"
      >
        <Eye className="h-3.5 w-3.5" />
        {ACCESS_CAPABILITY_LABELS.view}
      </span>
      <button
        type="button"
        onClick={() =>
          onChange(downloadOn ? value.filter((c) => c !== 'download') : [...value, 'download'])
        }
        aria-pressed={downloadOn}
        title={
          downloadOn
            ? '允许下载原件（.md 导出或原始文件）——再次点击收回'
            : '仅允许查看，不允许把内容带走——点击放开下载'
        }
        className={`${h} ${px} ${fs} inline-flex cursor-pointer items-center gap-1 rounded-md border transition-colors ${
          downloadOn
            ? 'border-emerald-300/80 bg-emerald-50/80 text-emerald-700 dark:border-emerald-800/60 dark:bg-emerald-950/40 dark:text-emerald-300'
            : 'border-slate-200 bg-white/70 text-muted-foreground hover:border-slate-300 hover:text-foreground dark:border-slate-700 dark:bg-white/5'
        }`}
      >
        <Download className="h-3.5 w-3.5" />
        {ACCESS_CAPABILITY_LABELS.download}
      </button>
    </div>
  );
}

interface AccessSectionProps {
  /** 只看某篇文档的申请与授权（从文档菜单进入时传入）；不传则看全部 */
  docId?: string;
  docName?: string;
  /** 从文档范围切回全部 */
  onClearFilter?: () => void;
  /**
   * 要定位的申请单。
   *
   * 通过 ?access=<申请单号> 深链落回来时，就该直接看到那一条，
   * 而不是自己在列表里翻。
   */
  focusRequestId?: string;
}

/**
 * 访问权限管理（管理后台 · 访问权限分区）。
 *
 * 这里替代了「把密码抄给每个人」那套做法：访客自己申请，管理员在这里批。
 *
 * 一个分区回答同一条链上的四个问题：
 * - 加密文档：哪些文档以密文保存，谁被放行了，能不能取消加密；
 * - 待审批：谁想看哪篇文档、为什么，等我点头；
 * - 已授权：已经放行过谁，随时可以收回来；
 * - 访问审计：谁在什么时候看过、拿走过什么。
 *
 * 「加密文档」原先是另一个分区，但加密文档本身就是为了控制「谁能看它」——
 * 拆成两处只会让管理员在两个页面之间来回找同一个问题的答案。
 *
 * 授权不是密码：它有主人（是谁）、有期限（到什么时候）、能收回。
 * 密码发出去就收不回来了——这是两者的根本差别。
 */
export function AccessSection({ docId, docName, onClearFilter, focusRequestId }: AccessSectionProps) {
  const {
    docs,
    listAccessRequests,
    approveAccessRequest,
    rejectAccessRequest,
    listAllAccessGrants,
    revokeDocAccessGrant,
    updateDocAccessGrant,
    bulkApproveAccessRequests,
    bulkGrantAccess,
    listKnownGuests,
    listAccessAudit,
    decryptDoc,
    openAdminConsole,
  } = useApp();
  const [requests, setRequests] = useState<AccessRequest[]>([]);
  const [grants, setGrants] = useState<AccessGrant[]>([]);
  const [audit, setAudit] = useState<AccessAuditEntry[]>([]);
  const [loading, setLoading] = useState(false);
  /** 每条申请单独选有效期：0 = 长期有效 */
  const [terms, setTerms] = useState<Record<string, number>>({});
  /**
   * 每条申请单独选能力。
   *
   * 默认只给「查看正文」。下载是额外口子：默认打开它，
   * 等于让管理员在没想过这件事的情况下就把文件交出去了。
   */
  const [caps, setCaps] = useState<Record<string, AccessCapability[]>>({});
  /** 批量批准时勾选的申请 */
  const [selected, setSelected] = useState<string[]>([]);
  /** 批量批准共享的有效期：0 = 长期有效 */
  const [bulkTerm, setBulkTerm] = useState(0);
  /** 批量批准共享的能力集 */
  const [bulkCaps, setBulkCaps] = useState<AccessCapability[]>(['view']);
  const [bulkBusy, setBulkBusy] = useState(false);
  /** 正在高亮的申请（深链定位到的那条） */
  const [highlightId, setHighlightId] = useState<string | null>(null);
  /** 已经定位过的申请：避免每 10 秒的自动刷新都把页面滚回去 */
  const handledFocusRef = useRef<string | null>(null);

  /* ---------------- 加密文档清单 ---------------- */
  /** 已知访客（申请过或已获授权的），批量授权时供「选谁」 */
  const [guests, setGuests] = useState<Array<{ id: string; name: string }>>([]);
  /** 批量授权时勾选的加密文档 */
  const [selectedDocs, setSelectedDocs] = useState<string[]>([]);
  /** 批量授权的目标访客 */
  const [grantGuestId, setGrantGuestId] = useState('');
  /** 批量授权的有效期：0 = 长期有效 */
  const [grantTerm, setGrantTerm] = useState(0);
  const [grantBusy, setGrantBusy] = useState(false);

  /**
   * 加密文档清单。
   *
   * 限定到某篇文档时只留那一篇：从文档菜单进来的人问的是「这篇」，
   * 把全站密文文档摊在他面前只会挡路。
   */
  const encryptedDocs = useMemo(
    () => docs.filter((d) => d.type === 'file' && d.encrypted && (!docId || d.id === docId)),
    [docs, docId],
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

  /**
   * 定位到深链指定的那条申请。
   *
   * 列表是异步拉来的：深链带过来时它还是空的，
   * 所以得等这条申请真的出现在列表里再滚动+高亮。
   */
  useEffect(() => {
    if (!focusRequestId) return;
    if (handledFocusRef.current === focusRequestId) return;
    if (!requests.some((r) => r.id === focusRequestId)) return;
    handledFocusRef.current = focusRequestId;
    setHighlightId(focusRequestId);
    document
      .getElementById(`access-request-${focusRequestId}`)
      ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    // 高亮几秒后淡掉：一直亮着反而让人以为这条还有问题
    const timer = setTimeout(() => setHighlightId(null), 6000);
    return () => clearTimeout(timer);
  }, [focusRequestId, requests]);

  const load = useCallback(
    async (silent = false) => {
      if (!silent) setLoading(true);
      try {
        const [pending, all, log, knownGuests] = await Promise.all([
          listAccessRequests('pending', docId),
          // 一次性取全量授权：加密文档清单要按篇统计放行人数，
          // 文档筛选只是把这份列表按 docId 收窄，不必再单独发一次请求
          listAllAccessGrants(),
          listAccessAudit(docId),
          listKnownGuests(),
        ]);
        setRequests(pending);
        setGrants(all);
        setAudit(log);
        setGuests(knownGuests);
        // 已经不在待审批列表里的（例如被别人批掉了），就别再留在勾选里
        setSelected((prev) => prev.filter((id) => pending.some((r) => r.id === id)));
      } catch (e) {
        if (!silent) toast.error((e as Error)?.message || '读取失败');
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [docId, listAccessRequests, listAllAccessGrants, listAccessAudit, listKnownGuests],
  );

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * 开着管理后台时自动刷新。
   *
   * 访客那边一提交申请就有人在等；管理员要是得手动点一下刷新才看得见，
   * 等待就一直悬着。这里每 10 秒静默拉一次。
   */
  useEffect(() => {
    const timer = setInterval(() => {
      void load(true);
    }, 10_000);
    return () => clearInterval(timer);
  }, [load]);

  const toggleSelected = (id: string) => {
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  /** 批量批准：一次批掉勾选的所有申请，共享一个有效期与一组能力 */
  const handleBulkApprove = async () => {
    if (selected.length === 0) return;
    setBulkBusy(true);
    try {
      const approved = await bulkApproveAccessRequests(selected, bulkTerm, bulkCaps);
      const skipped = selected.length - approved;
      toast.success(
        skipped > 0
          ? `已批准 ${approved} 条申请，${skipped} 条被跳过（可能已被处理）`
          : `已批准 ${approved} 条申请`,
      );
      setSelected([]);
      await load(true);
    } catch (e) {
      toast.error((e as Error)?.message || '批量批准失败');
    } finally {
      setBulkBusy(false);
    }
  };

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
      await load(true);
      toast.success(`「${name}」已取消加密`);
    } catch (e) {
      toast.error((e as Error)?.message || '取消加密失败');
    }
  };

  /** 调整某条授权的口子大小 */
  const handleAdjustCaps = async (g: AccessGrant, next: AccessCapability[]) => {
    const before: AccessCapability[] = g.capabilities?.length
      ? g.capabilities
      : (['view'] as AccessCapability[]);
    const label = (caps: AccessCapability[]) =>
      caps.map((c) => ACCESS_CAPABILITY_LABELS[c] ?? c).join('、');
    try {
      await updateDocAccessGrant(g.docId, g.id, next);
      toast.success(
        `已调整「${g.guestName}」的授权：${label(before)} → ${label(next)}`,
      );
      await load(true);
    } catch (e) {
      toast.error((e as Error)?.message || '调整授权失败');
    }
  };

  const handleApprove = async (req: AccessRequest) => {
    const days = terms[req.id] ?? 0;
    const ability = caps[req.id] ?? ['view'];
    try {
      await approveAccessRequest(req.id, days, ability);
      const canDownload = ability.includes('download');
      toast.success(
        days > 0
          ? `已授权「${req.guestName}」访问「${req.docName}」，${days} 天后失效${
              canDownload ? '，含下载' : '（仅查看）'
            }`
          : `已授权「${req.guestName}」访问「${req.docName}」${canDownload ? '，含下载' : '（仅查看）'}`,
      );
      await load();
    } catch (e) {
      toast.error((e as Error)?.message || '批准失败');
    }
  };

  const handleReject = async (req: AccessRequest) => {
    try {
      await rejectAccessRequest(req.id);
      toast.info(`已拒绝「${req.guestName}」的申请`);
      await load();
    } catch (e) {
      toast.error((e as Error)?.message || '拒绝失败');
    }
  };

  const handleRevoke = async (grant: AccessGrant) => {
    try {
      await revokeDocAccessGrant(grant.docId, grant.id);
      toast.info(`已收回「${grant.guestName}」对「${grant.docName}」的访问权`);
      await load();
    } catch (e) {
      toast.error((e as Error)?.message || '收回失败');
    }
  };

  // 限定到某篇文档时，下面的授权名单也只看这一篇
  const scopedGrants = docId ? grants.filter((g) => g.docId === docId) : grants;
  const activeGrants = scopedGrants.filter((g) => !g.revokedAt);
  const revokedGrants = scopedGrants.filter((g) => g.revokedAt);

  return (
    <div className="space-y-4">
      {docName && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-indigo-200/60 bg-indigo-50/50 px-3 py-2 text-xs text-indigo-700 dark:border-indigo-900/50 dark:bg-indigo-950/25 dark:text-indigo-300">
          <span className="flex-1">正在查看「{docName}」的申请与授权。</span>
          {onClearFilter && (
            <button
              type="button"
              onClick={onClearFilter}
              className="cursor-pointer rounded-md border border-indigo-300/70 px-2 py-0.5 text-[11px] transition-colors hover:bg-indigo-100/60 dark:hover:bg-indigo-900/40"
            >
              查看全部文档
            </button>
          )}
        </div>
      )}

      {/* ---------------- 加密文档 ---------------- */}
      <section>
        <h4 className="mb-2 flex items-center gap-1.5 text-sm font-semibold">
          <Lock className="h-4 w-4 text-indigo-500" />
          加密文档
          {encryptedDocs.length > 0 && (
            <span className="rounded-full bg-indigo-500/15 px-2 py-0.5 text-[11px] text-indigo-600 dark:text-indigo-400">
              {encryptedDocs.length}
            </span>
          )}
        </h4>

        <p className="mb-2 text-[11px] leading-relaxed text-muted-foreground">
          以密文保存的文档，访客一律读不到正文：要提交访问申请，由你在下面批准后才能查看。
          服务端不保存任何访问密码，批准与撤销都随时可做。
        </p>

        {encryptedDocs.length === 0 ? (
          <p className="rounded-lg border border-dashed border-slate-200 px-3 py-4 text-center text-xs text-muted-foreground dark:border-slate-700">
            没有加密过任何文档（在文档菜单里点「加密文档」即可）
          </p>
        ) : (
          <>
            {/* 批量授权工具条：整个目录都加密时，勾一次就够 */}
            <div className="mb-2 flex flex-wrap items-center gap-2 rounded-lg border border-indigo-100/60 bg-white/50 px-2.5 py-2 dark:border-indigo-900/50 dark:bg-white/5">
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

            {guests.length === 0 && (
              <p className="mb-2 text-[11px] leading-relaxed text-muted-foreground">
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
                      <span className="truncate text-sm font-medium">{doc.name}</span>
                      <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">
                        {doc.lockedAt && `${formatRelativeTime(doc.lockedAt)}加密 · `}
                        {count > 0 ? `${count} 人已授权` : '暂无授权'}
                      </span>
                    </div>

                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => openAdminConsole('access', { docId: doc.id, docName: doc.name })}
                        title="只看这篇文档的申请与授权"
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
      </section>

      <section>
        <h4 className="mb-2 flex items-center gap-1.5 text-sm font-semibold">
          <Inbox className="h-4 w-4 text-amber-500" />
          待审批
          {requests.length > 0 && (
            <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[11px] text-amber-600 dark:text-amber-400">
              {requests.length}
            </span>
          )}
        </h4>

        {loading && requests.length === 0 ? (
          <p className="py-4 text-center text-sm text-muted-foreground">正在读取…</p>
        ) : requests.length === 0 ? (
          <p className="rounded-lg border border-dashed border-slate-200 px-3 py-4 text-center text-xs text-muted-foreground dark:border-slate-700">
            暂无待处理的申请
          </p>
        ) : (
          <>
            {/* 批量工具条：同一访客对多篇加密文档各提一次申请时，
                管理员不必连点 N 次「批准」 */}
            <div className="mb-2 flex flex-wrap items-center gap-2 rounded-lg border border-amber-200/60 bg-amber-50/40 px-2.5 py-2 dark:border-amber-900/50 dark:bg-amber-950/20">
              <button
                type="button"
                onClick={() =>
                  setSelected((prev) =>
                    prev.length === requests.length ? [] : requests.map((r) => r.id),
                  )
                }
                className="cursor-pointer text-[11px] text-amber-700 underline-offset-2 hover:underline dark:text-amber-400"
              >
                {selected.length === requests.length ? '取消全选' : '全选'}
              </button>
              <span className="text-[11px] text-muted-foreground">已选 {selected.length} 条</span>
              <select
                value={bulkTerm}
                onChange={(e) => setBulkTerm(Number(e.target.value))}
                className="h-7 rounded-md border border-slate-200 bg-white/70 px-1.5 text-[11px] dark:border-slate-700 dark:bg-white/5"
              >
                <option value={0}>长期有效</option>
                <option value={1}>1 天</option>
                <option value={7}>7 天</option>
                <option value={30}>30 天</option>
              </select>
              <CapabilityPicker value={bulkCaps} onChange={setBulkCaps} size="xs" />
              <Button
                size="sm"
                variant="outline"
                disabled={selected.length === 0 || bulkBusy}
                onClick={() => void handleBulkApprove()}
                className="h-7 px-2 text-[11px]"
              >
                <Check className="mr-1 h-3.5 w-3.5" />
                {bulkBusy ? '批准中…' : '批量批准'}
              </Button>
            </div>
            <ul className="space-y-2">
            {requests.map((req) => (
              <li
                key={req.id}
                id={`access-request-${req.id}`}
                className={
                  'rounded-lg border bg-amber-50/40 px-3 py-2.5 dark:bg-amber-950/20 ' +
                  (highlightId === req.id
                    ? 'border-sky-400 ring-2 ring-sky-400/40'
                    : 'border-amber-200/60 dark:border-amber-900/50')
                }
              >
                <div className="flex items-baseline gap-2">
                  <input
                    type="checkbox"
                    checked={selected.includes(req.id)}
                    onChange={() => toggleSelected(req.id)}
                    aria-label={`勾选 ${req.guestName} 对 ${req.docName} 的申请`}
                    className="mt-0.5 h-3.5 w-3.5 shrink-0 cursor-pointer accent-indigo-500"
                  />
                  <span className="text-sm font-medium">{req.guestName}</span>
                  <span className="truncate text-xs text-muted-foreground">申请查看</span>
                  <span className="truncate text-sm font-medium text-indigo-600 dark:text-indigo-400">
                    {req.docName}
                  </span>
                  <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">
                    {formatRelativeTime(req.createdAt)}
                  </span>
                </div>
                {req.reason && (
                  <p className="mt-1 text-xs leading-relaxed text-muted-foreground">事由：{req.reason}</p>
                )}
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <select
                    value={terms[req.id] ?? 0}
                    onChange={(e) => setTerms((prev) => ({ ...prev, [req.id]: Number(e.target.value) }))}
                    className="h-8 rounded-md border border-slate-200 bg-white/70 px-2 text-xs dark:border-slate-700 dark:bg-white/5"
                  >
                    <option value={0}>长期有效</option>
                    <option value={1}>1 天</option>
                    <option value={7}>7 天</option>
                    <option value={30}>30 天</option>
                  </select>
                  <CapabilityPicker
                    value={caps[req.id] ?? ['view']}
                    onChange={(next) => setCaps((prev) => ({ ...prev, [req.id]: next }))}
                  />
                  <Button size="sm" onClick={() => void handleApprove(req)}>
                    <Check className="mr-1 h-3.5 w-3.5" />
                    批准
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => void handleReject(req)}>
                    <X className="mr-1 h-3.5 w-3.5" />
                    拒绝
                  </Button>
                </div>
              </li>
            ))}
            </ul>
          </>
        )}
      </section>

      <section>
        <h4 className="mb-2 flex items-center gap-1.5 text-sm font-semibold">
          <ShieldOff className="h-4 w-4 text-indigo-500" />
          已授权
          {activeGrants.length > 0 && (
            <span className="rounded-full bg-indigo-500/15 px-2 py-0.5 text-[11px] text-indigo-600 dark:text-indigo-400">
              {activeGrants.length}
            </span>
          )}
        </h4>
        {activeGrants.length === 0 ? (
          <p className="rounded-lg border border-dashed border-slate-200 px-3 py-4 text-center text-xs text-muted-foreground dark:border-slate-700">
            还没有授权任何人
          </p>
        ) : (
          <ul className="space-y-2">
            {activeGrants.map((g) => {
              const expired = g.expiresAt !== null && g.expiresAt <= Date.now();
              return (
                <li
                  key={g.id}
                  className="flex flex-wrap items-center gap-2 rounded-lg border border-indigo-200/60 bg-white/50 px-3 py-2 dark:border-indigo-900/50 dark:bg-white/5"
                >
                  <span className="text-sm font-medium">{g.guestName}</span>
                  <span className="truncate text-sm text-indigo-600 dark:text-indigo-400">{g.docName}</span>
                  <span
                    className={
                      'ml-auto flex items-center gap-1 text-[11px] ' +
                      (expired ? 'text-red-500' : 'text-muted-foreground')
                    }
                  >
                    <Clock className="h-3 w-3" />
                    {formatExpiry(g.expiresAt)}
                  </span>
                  {/* 调整口子：批准时给错能力是常事，
                      直接改比「收回再重批」好——后者会把中间那段状态从流水里抹掉。 */}
                  <CapabilityPicker
                    value={g.capabilities?.length ? g.capabilities : ['view']}
                    onChange={(next) => void handleAdjustCaps(g, next)}
                    size="xs"
                  />
                  <Button size="sm" variant="outline" onClick={() => void handleRevoke(g)}>
                    收回
                  </Button>
                </li>
              );
            })}
          </ul>
        )}

        {revokedGrants.length > 0 && (
          <details className="mt-2">
            <summary className="cursor-pointer text-[11px] text-muted-foreground">
              已收回 {revokedGrants.length} 条
            </summary>
            <ul className="mt-1 space-y-1">
              {revokedGrants.map((g) => (
                <li key={g.id} className="text-[11px] text-muted-foreground">
                  {g.guestName} · {g.docName} · {formatRelativeTime(g.revokedAt ?? 0)}收回
                </li>
              ))}
            </ul>
          </details>
        )}
      </section>

      {/* 访问审计流水。
          权限授出去之后会被追问的从来不是「批了没有」，
          而是「谁在什么时候看过、拿走过什么」——这件事只有流水答得上来。
          放在最后而不是最前：它是事后追查用的账，不是日常操作界面。 */}
      <section>
        <h4 className="mb-2 flex items-center gap-1.5 text-sm font-semibold">
          <ScrollText className="h-4 w-4 text-slate-500" />
          访问审计
          {audit.length > 0 && (
            <span className="rounded-full bg-slate-500/15 px-2 py-0.5 text-[11px] text-slate-600 dark:text-slate-400">
              {audit.length}
            </span>
          )}
        </h4>
        {audit.length === 0 ? (
          <p className="rounded-lg border border-dashed border-slate-200 px-3 py-4 text-center text-xs text-muted-foreground dark:border-slate-700">
            暂无访问记录
          </p>
        ) : (
          <ul className="max-h-72 space-y-1 overflow-auto rounded-lg border border-slate-200/70 bg-white/40 px-3 py-2 dark:border-slate-700/60 dark:bg-white/[0.03]">
            {audit.map((a) => (
              <li
                key={a.id}
                className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[11px] leading-relaxed"
              >
                <span className="shrink-0 text-muted-foreground">
                  {formatRelativeTime(a.createdAt)}
                </span>
                <span className="shrink-0 rounded bg-slate-500/10 px-1.5 py-0.5 font-medium text-slate-700 dark:text-slate-300">
                  {ACCESS_AUDIT_LABELS[a.action] ?? a.action}
                </span>
                <span className="font-medium">{a.actorName}</span>
                {a.docName && (
                  <span className="truncate text-indigo-600 dark:text-indigo-400">{a.docName}</span>
                )}
                {a.detail && <span className="text-muted-foreground">{a.detail}</span>}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
