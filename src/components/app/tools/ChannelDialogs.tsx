import { useState } from 'react';
import { Loader2, Play, Send } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import type { DecodedField } from '../../../../shared/tools';

export interface SendDialogProps {
  /** 开着吗 */
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 通道在跑吗 */
  running: boolean;
  /** 发送中 */
  sending: boolean;
  /** 发一帧出去 */
  onSend: (data: string, format: 'text' | 'hex') => void;
}

/**
 * 发送：往通道里写一帧。
 *
 * 十六进制与文本两种：设备要字节就给字节，要人话就给文本。
 */
export function SendDialog({ open, onOpenChange, running, sending, onSend }: SendDialogProps) {
  const [format, setFormat] = useState<'hex' | 'text'>('hex');
  const [payload, setPayload] = useState('');

  const send = (): void => {
    const text = payload.trim();
    if (!text) {
      toast.error('要发什么还没填');
      return;
    }
    onSend(text, format);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-[15px]">发送</DialogTitle>
          <DialogDescription className="text-[12px]">
            {running ? '发出去的内容也会记进实时数据。' : '串口没打开，发不了。'}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <div className="flex h-7 overflow-hidden rounded-md border border-border/70">
              {(['hex', 'text'] as const).map((f) => (
                <button
                  key={f}
                  type="button"
                  onClick={() => setFormat(f)}
                  className={`px-2.5 text-[11px] ${
                    format === f
                      ? 'bg-indigo-500 text-white'
                      : 'text-muted-foreground hover:bg-accent hover:text-foreground'
                  }`}
                >
                  {f === 'hex' ? '十六进制' : '文本'}
                </button>
              ))}
            </div>
            <span className="text-[10px] text-muted-foreground">
              {format === 'hex' ? '如 BB0206E6AA980155（不含 0x 与空格）' : '直接输入要发的内容'}
            </span>
          </div>
          <Textarea
            value={payload}
            onChange={(e) => setPayload(e.target.value)}
            placeholder={format === 'hex' ? 'BB02…' : '要发出去的内容'}
            className="min-h-[7rem] resize-none font-mono text-[11px]"
          />
        </div>

        <DialogFooter>
          <Button size="sm" className="h-7" onClick={send} disabled={!running || sending}>
            {sending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Send className="h-3.5 w-3.5" />
            )}
            发送
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export interface HexDecodeDialogProps {
  /** 开着吗 */
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 按哪套协议解 */
  pluginId: string;
}

/**
 * 解 HEX：手上有一段字节，先看看它被解成什么。
 *
 * 不接串口也能用——现场从别处抓来的字节，粘进来就知道该按哪套协议读。
 */
export function HexDecodeDialog({ open, onOpenChange, pluginId }: HexDecodeDialogProps) {
  const [hex, setHex] = useState('');
  const [decoded, setDecoded] = useState<{ fields?: DecodedField[]; summary?: string } | null>(null);
  const [decoding, setDecoding] = useState(false);

  const decodeHex = async (): Promise<void> => {
    if (!hex.trim()) {
      toast.error('还没有十六进制可解');
      return;
    }
    setDecoding(true);
    try {
      setDecoded(await api.tools.decode(pluginId, hex));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setDecoding(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="text-[15px]">解 HEX</DialogTitle>
          <DialogDescription className="text-[12px]">
            粘一段十六进制，按左边选中的协议类型解一遍。
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-2">
          <Textarea
            value={hex}
            onChange={(e) => setHex(e.target.value)}
            placeholder="BB0206E6AA980155（可直接粘贴抓到的字节）"
            className="h-16 resize-none font-mono text-[11px]"
          />
          <div className="flex items-center gap-2">
            <Button size="sm" variant="outline" className="h-7" onClick={() => void decodeHex()}>
              {decoding ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Play className="h-3.5 w-3.5" />
              )}
              解码
            </Button>
          </div>
          {decoded ? (
            <div className="flex flex-col gap-1.5">
              {decoded.summary ? (
                <p className="text-[11px] font-medium">{decoded.summary}</p>
              ) : null}
              {decoded.fields?.length ? (
                <table className="w-full border-collapse text-[11px]">
                  <tbody>
                    {decoded.fields.map((field) => (
                      <tr key={field.key} className="border-b border-border/30">
                        <td className="w-28 py-1 pr-2 text-muted-foreground">{field.key}</td>
                        <td className="py-1 pr-2 break-all">{field.value}</td>
                        <td className="w-20 py-1 font-mono text-[10px] text-muted-foreground">
                          {field.raw ?? ''}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <p className="text-[11px] text-muted-foreground">
                  这段字节没解出字段（当前是「不解析」模式，只给原始字节）。
                </p>
              )}
            </div>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
