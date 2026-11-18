import { useMemo } from 'react';
import { RefreshCw } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import type { ToolsCatalog } from '@/lib/api';
import type { SerialPortInfo, ToolDef } from '../../../../shared/tools';
import type { PluginSummary } from '../../../../shared/plugins';

/** 原生 select 的统一样式 */
const SELECT_CLASS =
  'h-8 w-full rounded-md border border-border/80 bg-background px-2 text-[12px] outline-none focus:border-indigo-500 focus:ring-2 focus:ring-ring/50';

export interface AccessConfigPanelProps {
  /** 接入方式（串口监听） */
  tool: ToolDef;
  /** 工具目录 */
  catalog: ToolsCatalog;
  /** 本机串口 */
  serialPorts: SerialPortInfo[];
  /** 正在扫串口 */
  scanning: boolean;
  /** 重扫串口 */
  onRescan: () => void;
  /** 接入参数 */
  values: Record<string, string>;
  /** 改一个参数 */
  onChange: (key: string, value: string) => void;
  /**
   * 选中的解析插件 id（空串 = 不解析）。
   *
   * 协议类型与解析插件是同一件事：选插件就是选协议——
   * 插件自己知道它属于哪套协议，所以这一个 id 定下了两件事。
   */
  pluginId: string;
  /** 换解析插件（连带换了协议） */
  onPluginChange: (id: string) => void;
  /** 去看全部支持的协议 */
  onBrowseProtocols: () => void;
  /** 这台机器的串口能不能用（不能就把原因摆出来） */
  serialAvailable: boolean;
  /** 不能用时的原因 */
  serialReason: string;
}

/**
 * 左栏「基本信息」：接哪儿、跑多快、按哪套协议读。
 *
 * 只留三件事，一件一段：
 * 1. **端口**：线插在哪个口上（扫不到就手填路径）。
 * 2. **波特率 / 数据位 / 停止位 / 校验 / 流控**：这根线跑多快、怎么说话。
 * 3. **协议类型**：这套字节长什么样——选它就是选读懂它的那套解析插件。
 *
 * 参数跟着协议走：选了带推荐的协议（LED2 要 38400/8N1），
 * 没手动改过的字段自动跟上；人改过的不动——
 * 端口是物理事实，协议是解读方式，换协议不该把线拔了。
 */
export function AccessConfigPanel({
  tool,
  catalog,
  serialPorts,
  scanning,
  onRescan,
  values,
  onChange,
  pluginId,
  onPluginChange,
  onBrowseProtocols,
  serialAvailable,
  serialReason,
}: AccessConfigPanelProps) {
  /**
   * 协议按插件分组：下拉里一层是协议，层内是能读懂它的解析插件。
   *
   * 之所以这样摆，是因为「选协议类型」和「选解析插件」本来就是一次选择——
   * 插件自己带着协议 id，选中它，协议也就定了。
   * 同一个协议下有多把钥匙时（各家各写了一套读法），才需要人挑一把。
   */
  const groups = useMemo(() => {
    const byProtocol = new Map<string, PluginSummary[]>();
    for (const p of catalog.plugins ?? []) {
      const list = byProtocol.get(p.protocolId) ?? [];
      list.push(p);
      byProtocol.set(p.protocolId, list);
    }
    return [...byProtocol.entries()].map(([protocolId, plugins]) => ({
      protocolId,
      protocolName:
        catalog.protocols.find((t) => t.id === protocolId)?.name ?? protocolId,
      plugins,
    }));
  }, [catalog.plugins, catalog.protocols]);

  const plugin = (catalog.plugins ?? []).find((p) => p.id === pluginId);
  const serialField = tool.fields.find((f) => f.dynamic === 'serial-ports');
  /** 本机一个口都没扫到 → 只能手填 */
  const serialByHand = !serialField || serialPorts.length === 0;

  /** 两个一组的参数（截图里也是这么排的：波特率/数据位一行，停止位/校验一行） */
  const field = (key: string): ToolDef['fields'][number] | undefined =>
    tool.fields.find((f) => f.key === key);

  return (
    <div className="flex flex-col gap-3">
      {/* 串口不可用：把原因摆出来，别让人对着「启动」按钮猜 */}
      {!serialAvailable ? (
        <div className="flex items-start gap-1.5 rounded-md border border-amber-500/40 bg-amber-500/10 px-2.5 py-1.5 text-[10px] leading-relaxed text-amber-700">
          <span className="shrink-0">串口不可用：</span>
          <span>{serialReason || '这台机器上读不到串口'}</span>
        </div>
      ) : null}

      {/* 端口 */}
      <section className="flex flex-col gap-1.5">
        <div className="flex items-center gap-2">
          <Label className="text-[11px] text-muted-foreground" htmlFor="port-pick">
            端口 <span className="text-rose-500">*</span>
          </Label>
          <button
            type="button"
            onClick={onRescan}
            title="重新扫一遍本机串口"
            className="ml-auto flex h-6 w-6 items-center justify-center rounded-full border border-border/70 text-muted-foreground transition-colors hover:border-indigo-500 hover:text-indigo-500"
          >
            <RefreshCw className={`h-3 w-3 ${scanning ? 'animate-spin' : ''}`} />
          </button>
        </div>
        {serialByHand ? (
          <input
            id="port-pick"
            value={values.port ?? ''}
            onChange={(e) => onChange('port', e.target.value)}
            placeholder="COM3"
            className={SELECT_CLASS}
          />
        ) : (
          <select
            id="port-pick"
            value={values.port ?? ''}
            onChange={(e) => onChange('port', e.target.value)}
            className={SELECT_CLASS}
          >
            <option value="">选一个串口</option>
            {serialPorts.map((p) => (
              <option key={p.path} value={p.path}>
                {p.path}
                {p.manufacturer ? ` · ${p.manufacturer}` : ''}
              </option>
            ))}
          </select>
        )}
      </section>

      {/* 波特率 / 数据位 */}
      <section className="grid grid-cols-2 gap-2">
        {(['baudRate', 'dataBits'] as const).map((key) => {
          const f = field(key);
          if (!f) return null;
          return (
            <label key={key} className="flex flex-col gap-1">
              <span className="text-[11px] text-muted-foreground">{f.label}</span>
              <select
                value={values[key] ?? f.defaultValue ?? ''}
                onChange={(e) => onChange(key, e.target.value)}
                className={SELECT_CLASS}
              >
                {(f.options ?? []).map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
          );
        })}
      </section>

      {/* 停止位 / 校验 */}
      <section className="grid grid-cols-2 gap-2">
        {(['stopBits', 'parity'] as const).map((key) => {
          const f = field(key);
          if (!f) return null;
          return (
            <label key={key} className="flex flex-col gap-1">
              <span className="text-[11px] text-muted-foreground">{f.label}</span>
              <select
                value={values[key] ?? f.defaultValue ?? ''}
                onChange={(e) => onChange(key, e.target.value)}
                className={SELECT_CLASS}
              >
                {(f.options ?? []).map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
          );
        })}
      </section>

      {/* 流控 */}
      {(() => {
        const f = field('flowControl');
        if (!f) return null;
        return (
          <section className="flex flex-col gap-1.5">
            <Label className="text-[11px] text-muted-foreground">{f.label}</Label>
            <select
              value={values.flowControl ?? f.defaultValue ?? ''}
              onChange={(e) => onChange('flowControl', e.target.value)}
              className={SELECT_CLASS}
            >
              {(f.options ?? []).map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </section>
        );
      })()}

      {/* 协议类型：选它就是选解析插件 */}
      <section className="flex flex-col gap-1.5 border-t border-border/60 pt-3">
        <div className="flex items-center gap-2">
          <Label className="text-[11px] text-muted-foreground" htmlFor="parser-pick">
            协议类型
          </Label>
          <button
            type="button"
            onClick={onBrowseProtocols}
            className="ml-auto text-[10px] text-indigo-500 hover:underline"
          >
            看全部支持的协议
          </button>
        </div>
        <select
          id="parser-pick"
          value={pluginId}
          onChange={(e) => onPluginChange(e.target.value)}
          className={SELECT_CLASS}
        >
          <option value="">不解析（只看原始字节）</option>
          {groups.map((group) => (
            <optgroup key={group.protocolId} label={group.protocolName}>
              {group.plugins.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} · {p.publisher} v{p.version}
                </option>
              ))}
            </optgroup>
          ))}
        </select>

        {plugin ? (
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">
              {plugin.builtin ? '内置' : '开发者发布'}
            </Badge>
            <span className="text-[11px] font-medium">{plugin.name}</span>
            <span className="text-[10px] text-muted-foreground">
              {plugin.publisher} · v{plugin.version}
            </span>
          </div>
        ) : (
          <p className="text-[10px] leading-relaxed text-muted-foreground/80">
            不解析——收到什么算什么，空闲 200ms 切一条。
          </p>
        )}
      </section>
    </div>
  );
}
