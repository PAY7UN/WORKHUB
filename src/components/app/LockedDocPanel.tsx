import { useCallback, useEffect, useState } from 'react';
import { Lock, AlertCircle, UserPlus, CheckCircle2 } from 'lucide-react';
import { useApp } from '@/context/AppContext';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import type { DocNode } from '@/types';

interface LockedDocPanelProps {
  doc: DocNode;
  /** 解锁成功后把明文交给调用方（只留在组件内存里，不进任何缓存） */
  onUnlocked: (content: string) => void;
  /**
   * 授权是否已被收回。
   *
   * 收回和「从没申请过」是两回事：前者是曾经能看、现在不能了，
   * 界面上要如实说明——否则访客会以为自己从没申请过。
   */
  revoked?: boolean;
}

/**
 * 加密文档的锁定视图（访客）。
 *
 * 拿到正文只有一条路：申请访问（「获取权限」式的申请）。
 * 填个名字说明来意，管理员批准后就能直接打开，之后长期有效，
 * 管理员随时可以撤销——谁看过、什么时候看的，都有着落。
 *
 * 【不再有访问密码】以前这里还有「用密码打开」：管理员把密码发过来，
 * 访客输一次长期使用。密码意味着服务端要存一份口令材料（无论是哈希、
 * 封存密文还是包裹数据密钥的密钥），一旦库被拖走就是一次凭据泄露。
 * 现在加密文档一律走申请制：服务端只认会话和授权，不认任何共享口令。
 *
 * 管理员走另一条路：服务端能用主密钥直接解密，打开即见——
 * 那一侧的处理在 DocEditor 里。
 */
type Stage = 'checking' | 'need' | 'pending' | 'denied' | 'revoked' | 'request';

/** 轮询间隔：管理员批准后，访客界面上多久该自己翻到正文 */
const POLL_MS = 4000;

export function LockedDocPanel({ doc, onUnlocked, revoked = false }: LockedDocPanelProps) {
  const { openDocByGrant, checkDocAccess, requestDocAccess, guest, setGuestName } = useApp();
  const [stage, setStage] = useState<Stage>('checking');
  const [reason, setReason] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  /**
   * 静默探测权限状态。
   *
   * 与「取正文」分开是有意的：轮询每几秒就跑一次，
   * 每次都捎一份明文既费带宽，也平白扩大明文在网络上的暴露面。
   * 这里只问「批了没」，真要正文时另走一次 access-open。
   */
  const probe = useCallback(async (): Promise<'granted' | 'pending' | 'rejected' | 'none'> => {
    try {
      const s = await checkDocAccess(doc.id);
      return s.reason;
    } catch {
      // 探测失败不等于没权限——保持现状，下一轮再说
      return 'none';
    }
  }, [checkDocAccess, doc.id]);

  /** 取正文并交给上层（明文只留在内存里，不进任何缓存） */
  const openNow = useCallback(async () => {
    const opened = await openDocByGrant(doc.id);
    onUnlocked(opened.content ?? '');
  }, [doc.id, onUnlocked, openDocByGrant]);

  /** 看看手上有没有已批准的授权：有就直接开，没有才知道要申请 */
  const checkGrant = useCallback(async () => {
    setStage('checking');
    try {
      await openNow();
    } catch (e) {
      const reasonCode = (e as { data?: { reason?: string } })?.data?.reason;
      if (reasonCode === 'pending') setStage('pending');
      else if (reasonCode === 'rejected') setStage('denied');
      // 授权是「被收回」的，不是「从没申请过」——这两件事要如实区分
      else if (revoked) setStage('revoked');
      else setStage('need');
    }
  }, [openNow, revoked]);

  useEffect(() => {
    void checkGrant();
  }, [checkGrant]);

  /**
   * 申请在审期间自动盯管理员的审批结果。
   *
   * 以前要访客自己守在页面上、手动点「我已获批，重新检查」——
   * 管理员那边点一下批准，这边还得人再动一下才能看到，
   * 中间这段等待全靠人肉守着。现在批准与否由界面自己发现。
   */
  useEffect(() => {
    if (stage !== 'pending') return;
    let alive = true;
    const timer = setInterval(() => {
      void (async () => {
        const state = await probe();
        if (!alive) return;
        if (state === 'granted') {
          try {
            await openNow();
          } catch {
            // 状态说有授权、却取不到正文：下一轮再试，不必打断界面
          }
        } else if (state === 'rejected') {
          setStage('denied');
        }
      })();
    }, POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [stage, probe, openNow]);

  useEffect(() => {
    setName(guest?.name ?? '');
  }, [guest?.name]);

  const handleSubmitRequest = async () => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      // 先把名字落到会话上：审批单上显示的就是它
      const trimmed = name.trim();
      if (trimmed && trimmed !== guest?.name) await setGuestName(trimmed);
      await requestDocAccess(doc.id, reason.trim());
      setStage('pending');
    } catch (e) {
      setError(e instanceof Error ? e.message : '提交申请失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex-1 flex items-center justify-center p-8 overflow-auto">
      <div className="w-full max-w-sm rounded-xl border border-indigo-200/60 dark:border-indigo-900/60 bg-white/60 dark:bg-white/5 p-6 text-center">
        <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-indigo-100/70 dark:bg-indigo-950/50">
          <Lock className="h-6 w-6 text-indigo-500" />
        </div>

        {stage === 'checking' && (
          <>
            <h3 className="mb-1 text-sm font-semibold text-foreground">正在检查访问权限…</h3>
            <p className="text-xs text-muted-foreground">如果你已获得授权，将直接打开</p>
          </>
        )}

        {stage === 'pending' && (
          <>
            <h3 className="mb-1 text-sm font-semibold text-foreground">申请已提交，等待管理员确认</h3>
            <p className="mb-4 text-xs leading-relaxed text-muted-foreground">
              管理员批准后，这篇文档会自动对你可见，无需刷新页面。
              <br />
              内容不会进入 Agent 的检索范围。
            </p>
            <Button onClick={() => void checkGrant()} variant="outline" className="w-full">
              <CheckCircle2 className="mr-1.5 h-4 w-4" />
              立即检查一次
            </Button>
          </>
        )}

        {stage === 'denied' && (
          <>
            <h3 className="mb-1 text-sm font-semibold text-foreground">你的访问申请未获批准</h3>
            <p className="mb-4 text-xs leading-relaxed text-muted-foreground">
              如果仍需查看，可以重新申请，或直接联系管理员说明用途。
            </p>
            <Button onClick={() => setStage('request')} className="w-full gradient-bg hover:opacity-90">
              <UserPlus className="mr-1.5 h-4 w-4" />
              重新申请
            </Button>
          </>
        )}

        {stage === 'revoked' && (
          <>
            <h3 className="mb-1 text-sm font-semibold text-foreground">访问授权已被收回</h3>
            <p className="mb-4 text-xs leading-relaxed text-muted-foreground">
              管理员已收回你对「{doc.name}」的访问权限，正文已从本页撤下。
              <br />
              如仍需查看，请说明用途后重新申请。
            </p>
            <Button onClick={() => setStage('request')} className="w-full gradient-bg hover:opacity-90">
              <UserPlus className="mr-1.5 h-4 w-4" />
              重新申请
            </Button>
          </>
        )}

        {stage === 'need' && (
          <>
            <h3 className="mb-1 text-sm font-semibold text-foreground">该文档已加密</h3>
            <p className="mb-4 text-xs leading-relaxed text-muted-foreground">
              「{doc.name}」的{doc.kind === 'file' ? '文件内容' : '正文'}以密文保存。
              <br />
              提交访问申请，管理员批准后即可查看。
            </p>
            <Button onClick={() => setStage('request')} className="w-full gradient-bg hover:opacity-90">
              <UserPlus className="mr-1.5 h-4 w-4" />
              申请访问
            </Button>
          </>
        )}

        {stage === 'request' && (
          <div className="space-y-3 text-left">
            <div>
              <h3 className="mb-1 text-sm font-semibold text-foreground">申请访问「{doc.name}」</h3>
              <p className="text-xs leading-relaxed text-muted-foreground">
                填个名字并说明来意，管理员批准后这篇文档对你直接可见。名字会显示在管理员的待审批列表里。
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="access-name">你的名字</Label>
              <Input
                id="access-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="例如：张三 / 运维组"
                className="bg-white/60 dark:bg-white/5"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="access-reason">访问事由</Label>
              <Textarea
                id="access-reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="例如：排查线上问题，需要查看这份配置"
                rows={3}
                className="bg-white/60 dark:bg-white/5"
              />
            </div>
            {error && (
              <div className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-500 dark:border-red-900 dark:bg-red-950/30">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>{error}</span>
              </div>
            )}
            <div className="flex gap-2">
              <Button
                onClick={() => void handleSubmitRequest()}
                disabled={busy || !name.trim()}
                className="flex-1 gradient-bg hover:opacity-90"
              >
                <UserPlus className="mr-1.5 h-4 w-4" />
                {busy ? '提交中…' : '提交申请'}
              </Button>
              <Button onClick={() => setStage('need')} variant="outline" className="flex-1">
                返回
              </Button>
            </div>
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              申请只是「敲门」，能不能进由管理员决定。
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
