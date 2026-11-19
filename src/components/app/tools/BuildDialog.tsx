import { useEffect, useMemo, useRef, useState } from 'react';
import { Eye, Loader2, Package, Plus, Send, Trash2 } from 'lucide-react';
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
import type {
  BuildFieldType,
  CustomBuildField,
  FrameSegment,
  ProtocolBuild,
  ProtocolBuildField,
} from '../../../../shared/tools';

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
  /** 组一条并发出去，返回发出去的那几字节（十六进制）与按结构切开的几段 */
  onBuild: (
    kind: string,
    args: Record<string, string>,
    peer?: string,
  ) => Promise<{ frame: string; segments?: FrameSegment[] } | void>;
  /** 只组不发，看一眼这帧长什么样 */
  onPreview: (
    kind: string,
    args: Record<string, string>,
    peer?: string,
  ) => Promise<{ frame: string; segments?: FrameSegment[] }>;
}

/** 字段占几个字节：写清楚了，人填的时候才知道该填几位 */
function fieldSize(field: ProtocolBuildField): string {
  if (field.bytes !== undefined) return `${field.bytes} 字节`;
  if (field.maxBytes !== undefined) return `≤ ${field.maxBytes} 字节`;
  return '';
}

/** 字段的类型：给人看的名字 */
function fieldTypeName(field: ProtocolBuildField): string {
  switch (field.type) {
    case 'u8':
      return '无符号整数';
    case 'u16':
      return '无符号整数';
    case 'u32':
      return '无符号整数';
    case 'hexU8':
      return '十六进制整数';
    case 'hexU16':
      return '十六进制整数';
    case 'hexU32':
      return '十六进制整数';
    case 'hex':
      return '十六进制';
    case 'text':
      return '文本';
    default:
      return '';
  }
}

/** 校验一个值需要知道的事：它是什么类型、最宽几个字节 */
interface ValueSpec {
  type?: BuildFieldType;
  /** 定长字段占几个字节 */
  bytes?: number;
  /** 变长字段最多几个字节 */
  maxBytes?: number;
}

/**
 * 这个值填得对不对。
 *
 * 当场说清楚比发出去等终端不理强——「序列号」填了 70000，
 * 静默截断成 4464 发出去，人还以为发出去了。
 *
 * 协议清单里的字段与自定义消息里人自己定义的字段，
 * 走的是同一套校验：规则一样，人就不用记两套。
 */
function valueError(spec: ValueSpec, value: string): string | null {
  const raw = value.trim();
  if (!raw) return null;
  const type = spec.type ?? 'text';

  if (type === 'u8' || type === 'u16' || type === 'u32') {
    const bits = type === 'u8' ? 8 : type === 'u16' ? 16 : 32;
    const max = bits === 8 ? 0xff : bits === 16 ? 0xffff : 0xffffffff;
    const num = raw.toLowerCase().startsWith('0x')
      ? Number.parseInt(raw.slice(2), 16)
      : Number(raw);
    if (!Number.isFinite(num)) return '不是数字';
    if (num < 0 || num > max) return `超出 ${bits} 位范围（0 ~ ${max}）`;
    return null;
  }

  // 十六进制整数：消息 ID 这类字段历来写成 0x8101，
  // 按十进制解会把 8101 当成 33025——合法，却完全不是那个意思。
  if (type === 'hexU8' || type === 'hexU16' || type === 'hexU32') {
    const bits = type === 'hexU8' ? 8 : type === 'hexU16' ? 16 : 32;
    const max = bits === 8 ? 0xff : bits === 16 ? 0xffff : 0xffffffff;
    const body = raw.toLowerCase().startsWith('0x') ? raw.slice(2) : raw;
    if (!/^[0-9a-fA-F]+$/.test(body)) return '不是十六进制';
    const num = Number.parseInt(body, 16);
    if (!Number.isFinite(num)) return '不是十六进制';
    if (num < 0 || num > max) {
      return `超出 ${bits} 位范围（0x0 ~ 0x${max.toString(16).toUpperCase()}）`;
    }
    return null;
  }

  if (type === 'hex') {
    const cleaned = raw.replace(/[\s,]/g, '');
    if (!/^[0-9a-fA-F]*$/.test(cleaned)) return '里面有不是十六进制的字符';
    if (cleaned.length % 2 !== 0) return '十六进制要成对写（两个字符一个字节）';
    const bytes = cleaned.length / 2;
    const limit = spec.maxBytes ?? spec.bytes;
    if (limit !== undefined && bytes > limit) {
      return `最多 ${limit} 字节，现在 ${bytes} 字节`;
    }
    return null;
  }

  // 文本：协议限的是字节数，不是字数
  const bytes = new TextEncoder().encode(raw).length;
  const limit = spec.maxBytes ?? spec.bytes;
  if (limit !== undefined && bytes > limit) {
    return `最多 ${limit} 字节，现在 ${bytes} 字节`;
  }
  return null;
}

/** 协议清单里的一个字段：填得对不对 */
function fieldError(field: ProtocolBuildField, value: string): string | null {
  return valueError(field, value);
}

/** 自定义消息里人自己定义的一个字段：填得对不对 */
function customFieldError(field: CustomBuildField): string | null {
  return valueError({ type: field.type, bytes: field.bytes }, field.value);
}

/** 自定义字段的类型选项 */
const CUSTOM_TYPES: { value: CustomBuildField['type']; label: string; bytes: number }[] = [
  { value: 'u8', label: '整数 1 字节', bytes: 1 },
  { value: 'u16', label: '整数 2 字节', bytes: 2 },
  { value: 'u32', label: '整数 4 字节', bytes: 4 },
  { value: 'hexU8', label: '十六进制整数 1 字节', bytes: 1 },
  { value: 'hexU16', label: '十六进制整数 2 字节', bytes: 2 },
  { value: 'hexU32', label: '十六进制整数 4 字节', bytes: 4 },
  { value: 'hex', label: '十六进制', bytes: 0 },
  { value: 'text', label: '文本', bytes: 0 },
];

/**
 * 组包下发：把「要发什么」按协议规则组装成字节帧发出去。
 *
 * 「解析」是把收到的字节读成人话，「组包」反过来：
 * 人填几个参数（终端编号、应答序列号、文本内容……），
 * 服务端按这套协议组装、算校验码、转义，再发到指定的对端。
 *
 * 表单是照着协议给的清单渲染的：能组什么、每条要填哪些参数，
 * 界面不自己猜——猜错了发出去的是废帧。
 *
 * 可靠靠三件事：字段按字节填（错当场拦）、发之前能预览这帧长什么样、
 * 发出去的是哪几个字节明明白白摆着。
 */
export function BuildDialog({
  open,
  onOpenChange,
  builds,
  peers,
  running,
  building,
  onBuild,
  onPreview,
}: BuildDialogProps) {
  const [kind, setKind] = useState('');
  const [args, setArgs] = useState<Record<string, string>>({});
  const [peer, setPeer] = useState('');
  /** 自定义消息的字段定义：协议里没有这条消息，人自己按字节定义 */
  const [customFields, setCustomFields] = useState<CustomBuildField[]>([]);
  /** 预览出来的字节 */
  const [preview, setPreview] = useState<{ frame: string; segments?: FrameSegment[] } | null>(null);
  /** 已经发出去的字节 */
  const [sent, setSent] = useState<{ frame: string; segments?: FrameSegment[] } | null>(null);
  /** 预览中 */
  const [previewing, setPreviewing] = useState(false);
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
    setCustomFields([]);
    setPreview(null);
    setSent(null);
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

  /** 填得不对的字段 */
  const badFields = useMemo(() => {
    const bad: { key: string; label: string; error: string }[] = [];
    for (const field of current?.fields ?? []) {
      const error = fieldError(field, args[field.key] ?? '');
      if (error) bad.push({ key: field.key, label: field.label, error });
    }
    return bad;
  }, [current, args]);

  /** 缺的必填项 */
  const missing = useMemo(
    () =>
      (current?.fields ?? []).filter((f) => f.required && !(args[f.key] ?? '').trim()),
    [current, args],
  );

  /** 自定义消息里人自己定义的字段：填错的那几个 */
  const badCustomFields = useMemo(() => {
    const bad: { index: number; name: string; error: string }[] = [];
    customFields.forEach((field, index) => {
      const error = customFieldError(field);
      if (error) bad.push({ index, name: field.name.trim() || `第 ${index + 1} 个字段`, error });
    });
    return bad;
  }, [customFields]);

  /** 交给服务端的参数：自定义消息的字段定义跟着一起走 */
  const buildArgs = (): Record<string, string> => {
    const next = { ...args };
    if (current?.custom && customFields.length) {
      next.customFields = JSON.stringify(customFields);
    }
    return next;
  };

  const previewFrame = async (): Promise<void> => {
    if (!current) return;
    if (badCustomFields.length) {
      toast.error(`${badCustomFields[0].name}：${badCustomFields[0].error}`);
      return;
    }
    setPreviewing(true);
    try {
      setPreview(await onPreview(current.kind, buildArgs(), peer || undefined));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setPreviewing(false);
    }
  };

  const submit = async (): Promise<void> => {
    if (!current) {
      toast.error('还没选要组哪条命令');
      return;
    }
    if (missing.length) {
      toast.error(`还差：${missing.map((f) => f.label).join('、')}`);
      return;
    }
    if (badFields.length) {
      toast.error(badFields[0].error);
      return;
    }
    if (badCustomFields.length) {
      toast.error(`${badCustomFields[0].name}：${badCustomFields[0].error}`);
      return;
    }
    const result = await onBuild(current.kind, buildArgs(), peer || undefined);
    if (result) setSent(result);
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

        <div className="flex max-h-[60vh] flex-col gap-2.5 overflow-y-auto pr-1">
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

          {current?.desc ? (
            <p className="text-[10px] leading-relaxed text-muted-foreground/80">{current.desc}</p>
          ) : null}

          {/* 这条消息的定义：消息 ID、方向、每个字段占几个字节 */}
          {current ? (
            <div className="rounded-md border border-border/60 bg-muted/30 p-2">
              <div className="mb-1 flex items-center gap-2 text-[11px]">
                <span className="text-muted-foreground">消息 ID</span>
                <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]">
                  {current.code ?? '—'}
                </code>
                <span className="text-muted-foreground">方向</span>
                <span className="text-[11px]">平台 → 终端</span>
              </div>
              {current.fields?.length ? (
                <table className="w-full text-[10px]">
                  <thead>
                    <tr className="text-left text-muted-foreground/70">
                      <th className="font-normal">字段</th>
                      <th className="w-16 font-normal">类型</th>
                      <th className="w-16 font-normal">字节</th>
                      <th className="font-normal">说明</th>
                    </tr>
                  </thead>
                  <tbody>
                    {current.fields.map((field) => (
                      <tr key={field.key} className="align-top">
                        <td className="py-0.5 pr-2">{field.label}</td>
                        <td className="py-0.5 pr-2 text-muted-foreground/80">
                          {fieldTypeName(field)}
                        </td>
                        <td className="py-0.5 pr-2 text-muted-foreground/80">{fieldSize(field)}</td>
                        <td className="py-0.5 text-muted-foreground/80">{field.help ?? ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <p className="text-[10px] text-muted-foreground/80">这条消息没有正文。</p>
              )}
            </div>
          ) : null}

          {/* 这条命令要填的参数 */}
          {current?.fields?.length ? (
            <div className="grid grid-cols-2 gap-2">
              {current.fields.map((field) => {
                const error = fieldError(field, args[field.key] ?? '');
                return (
                  <label
                    key={field.key}
                    className={`flex flex-col gap-1 ${field.key === 'text' ? 'col-span-2' : ''}`}
                  >
                    <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
                      {field.label}
                      {field.required ? <span className="text-rose-500">*</span> : null}
                      {fieldSize(field) ? (
                        <span className="text-[10px] text-muted-foreground/60">
                          {fieldSize(field)}
                        </span>
                      ) : null}
                    </span>
                    <input
                      value={args[field.key] ?? ''}
                      onChange={(e) =>
                        setArgs((prev) => ({ ...prev, [field.key]: e.target.value }))
                      }
                      placeholder={field.placeholder}
                      className={`${CONTROL_CLASS} ${error ? 'border-rose-500' : ''}`}
                    />
                    {error ? (
                      <span className="text-[10px] leading-relaxed text-rose-500">{error}</span>
                    ) : field.help ? (
                      <span className="text-[10px] leading-relaxed text-muted-foreground/80">
                        {field.help}
                      </span>
                    ) : null}
                  </label>
                );
              })}
            </div>
          ) : null}

          {/* 自定义消息：协议里没有这条消息，正文按字节自己定义 */}
          {current?.custom ? (
            <div className="flex flex-col gap-1.5 rounded-md border border-border/60 p-2">
              <div className="flex items-center justify-between">
                <span className="text-[11px] text-muted-foreground">正文字段（按顺序拼）</span>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 px-2 text-[10px]"
                  onClick={() =>
                    setCustomFields((prev) => [
                      ...prev,
                      { name: '', type: 'hex', bytes: 1, value: '' },
                    ])
                  }
                >
                  <Plus className="h-3 w-3" />
                  加一个字段
                </Button>
              </div>
              {customFields.length === 0 ? (
                <p className="text-[10px] leading-relaxed text-muted-foreground/80">
                  没定义字段时，正文按下面那整段十六进制发。
                </p>
              ) : null}
              {customFields.map((field, index) => {
                const option = CUSTOM_TYPES.find((t) => t.value === field.type);
                const fixed = option && option.bytes > 0;
                return (
                  <div key={index} className="flex flex-wrap items-center gap-1.5">
                    <input
                      value={field.name}
                      onChange={(e) =>
                        setCustomFields((prev) =>
                          prev.map((f, i) => (i === index ? { ...f, name: e.target.value } : f)),
                        )
                      }
                      placeholder="字段名"
                      className={`${CONTROL_CLASS} h-7 flex-1`}
                    />
                    <select
                      value={field.type}
                      onChange={(e) => {
                        const type = e.target.value as CustomBuildField['type'];
                        const next = CUSTOM_TYPES.find((t) => t.value === type);
                        setCustomFields((prev) =>
                          prev.map((f, i) =>
                            i === index
                              ? { ...f, type, bytes: next && next.bytes > 0 ? next.bytes : f.bytes }
                              : f,
                          ),
                        );
                      }}
                      className={`${CONTROL_CLASS} h-7 w-28`}
                    >
                      {CUSTOM_TYPES.map((t) => (
                        <option key={t.value} value={t.value}>
                          {t.label}
                        </option>
                      ))}
                    </select>
                    {fixed ? (
                      <span className="w-10 shrink-0 text-center text-[10px] text-muted-foreground/70">
                        {option?.bytes} 字节
                      </span>
                    ) : (
                      <input
                        value={field.bytes ?? ''}
                        onChange={(e) =>
                          setCustomFields((prev) =>
                            prev.map((f, i) =>
                              i === index
                                ? { ...f, bytes: Number(e.target.value) || undefined }
                                : f,
                            ),
                          )
                        }
                        placeholder="上限"
                        className={`${CONTROL_CLASS} h-7 w-14`}
                      />
                    )}
                    <input
                      value={field.value}
                      onChange={(e) =>
                        setCustomFields((prev) =>
                          prev.map((f, i) => (i === index ? { ...f, value: e.target.value } : f)),
                        )
                      }
                      placeholder="值"
                      className={`${CONTROL_CLASS} h-7 flex-1 font-mono ${
                        customFieldError(field) ? 'border-rose-500' : ''
                      }`}
                    />
                    <button
                      type="button"
                      aria-label="删掉这个字段"
                      onClick={() =>
                        setCustomFields((prev) => prev.filter((_, i) => i !== index))
                      }
                      className="shrink-0 rounded p-1 text-muted-foreground hover:text-rose-500"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                    {/* 填错当场说清楚，别等发出去才发现 */}
                    {customFieldError(field) ? (
                      <span className="basis-full text-[10px] leading-relaxed text-rose-500">
                        {customFieldError(field)}
                      </span>
                    ) : null}
                  </div>
                );
              })}
              <label className="flex flex-col gap-1">
                <span className="text-[11px] text-muted-foreground">
                  整段正文（没定义字段时用）
                </span>
                <input
                  value={args.body ?? ''}
                  onChange={(e) => setArgs((prev) => ({ ...prev, body: e.target.value }))}
                  placeholder="十六进制，可留空"
                  className={`${CONTROL_CLASS} font-mono`}
                />
              </label>
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

          {/* 组出来的字节：发之前能看，发完也摆着 */}
          {preview || sent ? (
            <div className="flex flex-col gap-1.5 rounded-md border border-border/60 bg-muted/30 p-2">
              <span className="text-[11px] text-muted-foreground">
                {sent ? '已发出的字节' : '将要发出的字节'}
              </span>
              {(sent ?? preview)?.segments?.length ? (
                <table className="w-full text-[10px]">
                  <tbody>
                    {(sent ?? preview)?.segments?.map((seg, index) => (
                      <tr key={`${seg.name}-${index}`} className="align-top">
                        <td className="w-20 shrink-0 py-0.5 pr-2 text-muted-foreground/80">
                          {seg.name}
                        </td>
                        <td className="py-0.5 font-mono">
                          {seg.hex.replace(/(.{2})(?=.)/g, '$1 ')}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <code className="break-all font-mono text-[10px] leading-relaxed">
                  {(sent ?? preview)?.frame.replace(/(.{2})(?=.)/g, '$1 ')}
                </code>
              )}
              <span className="text-[10px] leading-relaxed text-muted-foreground/80">
                逐段核对：消息 ID 对不对、长度填得对不对、校验码算得对不对。
                校验码与转义由服务端按协议处理；发出去之后，终端的应答在记录区里能看见。
              </span>
            </div>
          ) : null}
        </div>

        <DialogFooter>
          <Button
            size="sm"
            variant="outline"
            className="h-7"
            onClick={() => void previewFrame()}
            disabled={!running || building || previewing || !current}
          >
            {previewing ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Eye className="h-3.5 w-3.5" />
            )}
            预览字节
          </Button>
          <Button size="sm" className="h-7" onClick={() => void submit()} disabled={!running || building}>
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
