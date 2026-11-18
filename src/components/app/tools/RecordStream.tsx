import { useEffect, useMemo, useRef, useState } from 'react';
import { Copy, Download, Eraser, Radio, Send, Upload, Wand2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { saveBlob } from '@/utils';
import type { ChannelRecord } from '../../../../shared/tools';

export interface RecordStreamProps {
  /** 记录（最新的在最后） */
  records: ChannelRecord[];
  /** 通道在跑吗 */
  running: boolean;
  /** 清屏（只清眼前这一屏，服务端记着的还在） */
  onClear: () => void;
  /** 打开发送面板 */
  onSend: () => void;
  /** 打开解 HEX 面板 */
  onDecodeHex: () => void;
  /** 导入别处抓来的记录 */
  onImport: (records: ChannelRecord[]) => void;
  /** 外部给的类名（排版用） */
  className?: string;
}

/** 时间：到秒就够 */
function timeText(ts: number): string {
  return new Date(ts).toLocaleTimeString('zh-CN', { hour12: false });
}

/** 文件名洗一遍：Windows 不让用 : \ / ? * < > | " 这些字符 */
function safeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim() || '收发记录';
}

/** 记录 → CSV 行 */
function toRows(records: ChannelRecord[]): string[][] {
  return [
    ['时间', '方向', '字节', 'HEX', '解析'],
    ...records.map((record) => [
      new Date(record.ts).toLocaleString('zh-CN', { hour12: false }),
      record.direction === 'out' ? '发出' : '收到',
      String(record.bytes),
      record.hex ?? '',
      record.summary ?? record.text ?? '',
    ]),
  ];
}

/**
 * 导成 CSV：现场要拿去跟别的工具对帧，Excel 直接能开。
 *
 * 带 BOM——不然 Excel 打开中文全是乱码。
 */
function exportCsv(records: ChannelRecord[], fileName: string): void {
  if (records.length === 0) {
    toast.error('没有可导出的记录');
    return;
  }
  const csv = toRows(records)
    .map((row) => row.map((cell) => `"${cell.replace(/"/g, '""')}"`).join(','))
    .join('\r\n');
  saveBlob(new Blob(['\uFEFF', csv], { type: 'text/csv;charset=utf-8' }), fileName);
  toast.success(`已导出 ${records.length} 条`);
}

/**
 * 一条记录。
 *
 * **解析结果直接摊在这儿**——不用点选了才看得见：
 * 服务端收下字节那一刻就按协议解好了（字段、摘要都在记录里），
 * 这里只是把它摆出来。
 */
function RecordItem({ record }: { record: ChannelRecord }) {
  const [copied, setCopied] = useState(false);
  const out = record.direction === 'out';
  const fields = record.fields ?? [];
  /** 一句话说清这条是什么 */
  const title = record.summary || record.text || (fields.length ? '已解析' : '原始字节');

  /** 复制原始字节 */
  const copyHex = async (): Promise<void> => {
    if (!record.hex) return;
    try {
      await navigator.clipboard.writeText(record.hex);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      toast.error('复制失败：浏览器不让写剪贴板');
    }
  };

  return (
    <li className="px-3 py-2">
      {/* 第一行：什么时候来的、什么内容、原始字节 */}
      <div className="flex items-baseline gap-2">
        <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
          {timeText(record.ts)}
        </span>
        <span className={`shrink-0 text-[10px] ${out ? 'text-amber-600' : 'text-emerald-600'}`}>
          {out ? '发' : '收'}
        </span>
        <span className="shrink-0 text-[12px] font-medium">{title}</span>
        <button
          type="button"
          onClick={() => void copyHex()}
          title="复制原始字节"
          className="flex min-w-0 shrink items-center gap-1 font-mono text-[10px] text-muted-foreground/70 transition-colors hover:text-foreground"
        >
          {copied ? <Copy className="h-3 w-3 text-emerald-500" /> : null}
          <span className="max-w-[26rem] truncate">{record.hex || '—'}</span>
        </button>
        <span className="ml-auto shrink-0 text-[10px] text-muted-foreground/70">{record.bytes}B</span>
      </div>

      {/* 第二行：解出来的字段（自动解析的结果就在这儿） */}
      {fields.length ? (
        <dl className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 pl-14 text-[11px]">
          {fields.map((field) => (
            <div key={field.key} className="flex min-w-0 max-w-[24rem] items-baseline gap-1.5">
              <dt className="shrink-0 text-muted-foreground">{field.key}</dt>
              <dd className="min-w-0 truncate" title={field.value}>
                {field.value}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
    </li>
  );
}

/**
 * 实时数据流：串口读到的字节，进来一条显示一条。
 *
 * 这一屏只干这一件事，所以它占了大半屏：
 * 收什么、解析成什么，全在这儿摊着——不用点开别处才看得到。
 */
export function RecordStream({
  records,
  running,
  onClear,
  onSend,
  onDecodeHex,
  onImport,
  className,
}: RecordStreamProps) {
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const totalBytes = useMemo(
    () => records.reduce((sum, record) => sum + record.bytes, 0),
    [records],
  );

  /** 导出用的默认文件名 */
  const fileName = useMemo(
    () => safeFileName(`串口记录-${new Date().toISOString().slice(0, 10)}.csv`),
    [],
  );

  /** 新数据来了就往下滚——但人在往上翻历史时不抢他的滚动条 */
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    if (nearBottom) bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [records.length]);

  /** 导入别处抓来的 CSV：时间、方向、HEX 三列够用 */
  const importCsv = async (file: File): Promise<void> => {
    try {
      const text = await file.text();
      const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter((l) => l.trim());
      const imported: ChannelRecord[] = [];
      lines.forEach((line, index) => {
        const cells = line.split(',').map((c) => c.trim().replace(/^"|"$/g, ''));
        const hex = cells.find((c) => /^[0-9a-fA-F]+$/.test(c) && c.length % 2 === 0 && c.length > 4);
        if (!hex) return;
        const dirCell = cells.find((c) => c === '发出' || c === '收到' || c === 'out' || c === 'in');
        imported.push({
          id: -(index + 1),
          ts: Date.now(),
          direction: dirCell === '发出' || dirCell === 'out' ? 'out' : 'in',
          bytes: Math.floor(hex.length / 2),
          hex: hex.toUpperCase(),
          text: '',
          summary: '导入的记录',
        });
      });
      if (imported.length === 0) {
        toast.error('这个文件里没认出十六进制列');
        return;
      }
      onImport(imported);
      toast.success(`导入了 ${imported.length} 条`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '导入失败');
    }
  };

  return (
    <section className={`flex min-h-0 flex-col ${className ?? ''}`}>
      <header className="flex h-10 shrink-0 items-center gap-2 border-b border-border/70 px-3">
        <Radio className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="text-[12px] font-medium">实时数据</span>
        <span className="text-[10px] text-muted-foreground">
          {records.length} 条 · {totalBytes} 字节
        </span>
        {running ? (
          <span className="flex items-center gap-1 text-[10px] text-emerald-600">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500" />
            接收中
          </span>
        ) : null}

        <div className="ml-auto flex items-center gap-1">
          <Button
            size="sm"
            variant="ghost"
            className="h-7 px-2 text-[11px]"
            onClick={onClear}
            title="只清眼前这一屏，服务端记着的还在"
          >
            <Eraser className="h-3.5 w-3.5" />
            清空
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 px-2 text-[11px]"
            disabled={records.length === 0}
            onClick={() => exportCsv(records, fileName)}
          >
            <Download className="h-3.5 w-3.5" />
            导出
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 px-2 text-[11px]"
            onClick={() => fileRef.current?.click()}
          >
            <Upload className="h-3.5 w-3.5" />
            导入
          </Button>
          <Button size="sm" variant="ghost" className="h-7 px-2 text-[11px]" onClick={onSend}>
            <Send className="h-3.5 w-3.5" />
            发送
          </Button>
          <Button size="sm" variant="ghost" className="h-7 px-2 text-[11px]" onClick={onDecodeHex}>
            <Wand2 className="h-3.5 w-3.5" />
            解 HEX
          </Button>
          <input
            ref={fileRef}
            type="file"
            accept=".csv,text/csv"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void importCsv(file);
              e.target.value = '';
            }}
          />
        </div>
      </header>

      <div ref={listRef} className="min-h-0 flex-1 overflow-auto">
        {records.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-1.5 px-6 text-center">
            <p className="text-[12px] text-muted-foreground">还没有数据。</p>
            <p className="text-[11px] leading-relaxed text-muted-foreground/80">
              左边选好端口与协议类型，点右上角「启动」。
              收到的字节会实时按协议解析，一条条摊在这儿。
            </p>
          </div>
        ) : (
          <ul className="divide-y divide-border/60">
            {records.map((record) => (
              <RecordItem key={record.id} record={record} />
            ))}
          </ul>
        )}
        <div ref={bottomRef} />
      </div>
    </section>
  );
}
