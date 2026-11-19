import { useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, Package, Send } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import type { ProtocolBuild } from '../../../../shared/tools';

/** 原生控件的统一样式 */
const CONTROL_CLASS =
  'h-8 w-full rounded-md border border-border/80 bg-background px-2 text-[12px] outline-none focus:border-indigo-500 focus:ring-2 focus:ring-ring/50';

export interface BuildDialogProps {
  /** 开着吗 */
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 能组哪些命令（由这条通道的解析插件给出） */
  builds: ProtocolBuild[];
  /** 连上来的对端：JT/T 808 一个终端一条连接 */
  peers: string[];
  /** 通道在跑吗 */
  running: boolean;
  /** 组包中 */
  building: boolean;
  /** 组一条并发出去 */
  onBuild: (kind: string, args: Record<string, string>, peer?: string) => void;
}

/**
 * 组包下发：把「要发什么」按协议规则组装成字节帧发出去。
 *
 * 「解析」是把收到的字节读成人话，「组包」反过来：
 * 人填几个参数（终端编号、应答序列号、文本内容……），
 * 服务端按这套协议组装、算校验码、转义，再发到指定的对端。
 *
 * 表单是照着协议给的清单渲染的：能组什么、每条要填哪些参数，
 * 界面不自己猜——猜错了发出去的是废帧。
 */
export function BuildDialog({
  open,
  onOpenChange,
  builds,
  peers,
  running,
  building,
  onBuild,
}: BuildDialogProps) {
  const [kind, setKind] = useState('');
  const [args, setArgs] = useState<Record<string, string>>({});
  const [peer, setPeer] = useState('');
  /** 上一次铺过表单的命令：只有换命令才重铺 */
  const filledKindRef = useRef('');

  /** 当前选中的命令 */
  const current = useMemo(() => builds.find((b) => b.kind === kind), [builds, kind]);

  /**
   * 换个命令就把参数清干净：上一条命令的字段留着，
   * 下一条命令可能压根没有它，混在一起只会让人填错。
   *
   * 只在**命令真的换了**时才重铺——通道每隔一秒推一次状态，
   * 那些事件会把 session 换成新对象；跟着它一起重铺，
   * 人正填的字就被人擦了。
   */
  useEffect(() => {
    if (!current) {
      filledKindRef.current = '';
      setArgs({});
      return;
    }
    if (filledKindRef.current === current.kind) return;
    filledKindRef.current = current.kind;
    const next: Record<string, string> = {};
    for (const field of current.fields ?? []) {
      if (field.defaultValue !== undefined) next[field.key] = field.defaultValue;
    }
    setArgs(next);
  }, [current]);

  /** 打开时默认选第一条命令 */
  useEffect(() => {
    if (!open) return;
    if (!kind && builds.length) setKind(builds[0].kind);
  }, [open, kind, builds]);

  /** 对端变了就跟着换：多终端时发错终端比不发更糟 */
  useEffect(() => {
    if (peers.length === 0) {
      setPeer('');
      return;
    }
    if (!peer || !peers.includes(peer)) setPeer(peers[0]);
  }, [peers, peer]);

  const submit = (): void => {
    if (!current) {
      toast.error('还没选要组哪条命令');
      return;
    }
    const missing = (current.fields ?? []).filter(
      (f) => f.required && !(args[f.key] ?? '').trim(),
    );
    if (missing.length) {
      toast.error(`还差：${missing.map((f) => f.label).join('、')}`);
      return;
    }
    onBuild(current.kind, args, peer || undefined);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-[15px]">组包下发</DialogTitle>
          <DialogDescription className="text-[12px]">
            按协议规则把参数组装成字节帧发出去：校验码、转义、包头包尾都由服务端处理。
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-2.5">
          {/* 要组哪条命令 */}
          <label className="flex flex-col gap-1">
            <span className="text-[11px] text-muted-foreground">命令</span>
            <select
              value={kind}
              onChange={(e) => setKind(e.target.value)}
              className={CONTROL_CLASS}
            >
              {builds.map((b) => (
                <option key={b.kind} value={b.kind}>
                  {b.code ? `${b.name} · ${b.code}` : b.name}
                </option>
              ))}
            </select>
          </label>

          {/* 消息 ID：组包发的是「协议里的哪一条消息」，那个 ID 得看得见 */}
          {current?.code ? (
            <div className="flex items-center gap-1.5">
              <span className="text-[11px] text-muted-foreground">消息 ID</span>
              <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]">
                {current.code}
              </code>
            </div>
          ) : null}

          {current?.desc ? (
            <p className="text-[10px] leading-relaxed text-muted-foreground/80">{current.desc}</p>
          ) : null}

          {/* 这条命令要填的参数 */}
          {current?.fields?.length ? (
            <div className="grid grid-cols-2 gap-2">
              {current.fields.map((field) => (
                <label
                  key={field.key}
                  className={`flex flex-col gap-1 ${field.key === 'text' ? 'col-span-2' : ''}`}
                >
                  <span className="text-[11px] text-muted-foreground">
                    {field.label}
                    {field.required ? <span className="text-rose-500"> *</span> : null}
                  </span>
                  <input
                    value={args[field.key] ?? ''}
                    onChange={(e) =>
                      setArgs((prev) => ({ ...prev, [field.key]: e.target.value }))
                    }
                    placeholder={field.placeholder}
                    className={CONTROL_CLASS}
                  />
                  {field.help ? (
                    <span className="text-[10px] leading-relaxed text-muted-foreground/80">
                      {field.help}
                    </span>
                  ) : null}
                </label>
              ))}
            </div>
          ) : null}

          {/* 发给谁 */}
          {peers.length ? (
            <label className="flex flex-col gap-1">
              <span className="text-[11px] text-muted-foreground">
                发给
                {peers.length > 1 ? <span className="text-rose-500"> *</span> : null}
              </span>
              <select
                value={peer}
                onChange={(e) => setPeer(e.target.value)}
                className={CONTROL_CLASS}
              >
                {peers.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
              <span className="text-[10px] leading-relaxed text-muted-foreground/80">
                一个连接就是一个终端；发错了终端，比发不出去更麻烦。
              </span>
            </label>
          ) : (
            <p className="text-[10px] text-amber-600">
              还没有对端连上来——终端得先连上平台端口（JT/T 808 常用 7612）。
            </p>
          )}
        </div>

        <DialogFooter>
          <Button size="sm" className="h-7" onClick={submit} disabled={!running || building}>
            {building ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Send className="h-3.5 w-3.5" />
            )}
            组包并发送
          </Button>
          <Button size="sm" variant="ghost" className="h-7" onClick={() => onOpenChange(false)}>
            <Package className="h-3.5 w-3.5" />
            关闭
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
