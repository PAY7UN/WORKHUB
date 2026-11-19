import { useMemo, type ReactElement } from 'react';
import { PackageCheck, RefreshCw } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import type { ToolsCatalog } from '@/lib/api';
import type { SerialPortInfo, ToolDef, ToolField } from '../../../../shared/tools';
import { appliesToTransport, transportScopeText } from '../../../../shared/tools';
import type { PluginSummary } from '../../../../shared/plugins';

/** 原生 select 的统一样式 */
const SELECT_CLASS =
  'h-8 w-full rounded-md border border-border/80 bg-background px-2 text-[12px] outline-none focus:border-indigo-500 focus:ring-2 focus:ring-ring/50';

/** 原生 input 的统一样式 */
const INPUT_CLASS =
  'h-8 w-full rounded-md border border-border/80 bg-background px-2 text-[12px] outline-none focus:border-indigo-500 focus:ring-2 focus:ring-ring/50';

export interface AccessConfigPanelProps {
  /** 接入方式（串口监听、网口监听） */
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
  /** 这条通道能组包吗（开着通道、且这套协议能组） */
  canBuild: boolean;
  /** 为什么不能组——说清楚，别让人对着灰按钮猜 */
  buildHint: string;
  /** 打开组包面板 */
  onOpenBuild: () => void;
  /** 这台机器的串口能不能用（不能就把原因摆出来） */
  serialAvailable: boolean;
  /** 不能用时的原因 */
  serialReason: string;
}

/**
 * 左栏「基本信息」：接哪儿、按哪套协议读。
 *
 * 字段**不是写死的**：工具定义里有什么就摆什么——
 * 串口是端口与线参数，网口是方式、地址与端口。
 * 加一种新的接入方式，界面这边不用动。
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
  canBuild,
  buildHint,
  onOpenBuild,
  serialAvailable,
  serialReason,
}: AccessConfigPanelProps) {
  /**
   * 协议按插件分组：下拉里一层是协议，层内是能读懂它的解析插件。
   *
   * 之所以这样摆，是因为「选协议类型」和「选解析插件」本来就是一次选择——
   * 插件自己带着协议 id，选中它，协议也就定了。
   * 同一个协议下有多把钥匙时（各家各写了一套读法），才需要人挑一把。
   *
   * **只摆当前接入方式用得上的那些**：串口页不该出现 JT/T 808，
   * 网口页不该出现通达 LED2——选错了只会解出乱码。
   */
  const groups = useMemo(() => {
    const byProtocol = new Map<string, PluginSummary[]>();
    for (const p of catalog.plugins ?? []) {
      if (!appliesToTransport(p.transports, tool.id)) continue;
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
  }, [catalog.plugins, catalog.protocols, tool.id]);

  const plugin = (catalog.plugins ?? []).find((p) => p.id === pluginId);
  /** 选中的插件跟当前接入方式对不上（从别的页带过来的）：得说出来 */
  const pluginMismatch = plugin ? !appliesToTransport(plugin.transports, tool.id) : false;
  /** 这一栏是不是串口：串口才有「本机口列表」与「串口不可用」这回事 */
  const isSerial = tool.fields.some((f) => f.dynamic === 'serial-ports');

  /** 串口字段：扫到口就用下拉，扫不到就手填路径 */
  const renderSerialPort = (field: ToolField): ReactElement => {
    const byHand = serialPorts.length === 0;
    return (
      <section key={field.key} className="col-span-2 flex flex-col gap-1.5">
        <div className="flex items-center gap-2">
          <Label className="text-[11px] text-muted-foreground" htmlFor="port-pick">
            {field.label} <span className="text-rose-500">*</span>
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
        {byHand ? (
          <input
            id="port-pick"
            value={values[field.key] ?? ''}
            onChange={(e) => onChange(field.key, e.target.value)}
            placeholder={field.placeholder ?? 'COM3'}
            className={INPUT_CLASS}
          />
        ) : (
          <select
            id="port-pick"
            value={values[field.key] ?? ''}
            onChange={(e) => onChange(field.key, e.target.value)}
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
        {field.help ? (
          <p className="text-[10px] leading-relaxed text-muted-foreground/80">{field.help}</p>
        ) : null}
      </section>
    );
  };

  /** 一个普通字段：下拉、数字或文本 */
  const renderField = (field: ToolField): ReactElement => (
    <label
      key={field.key}
      className={`flex flex-col gap-1 ${field.wide ? 'col-span-2' : ''}`}
    >
      <span className="text-[11px] text-muted-foreground">
        {field.label}
        {field.required ? <span className="text-rose-500"> *</span> : null}
      </span>
      {field.type === 'select' ? (
        <select
          value={values[field.key] ?? field.defaultValue ?? ''}
          onChange={(e) => onChange(field.key, e.target.value)}
          className={SELECT_CLASS}
        >
          {(field.options ?? []).map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      ) : (
        <input
          type={field.type === 'number' ? 'number' : 'text'}
          value={values[field.key] ?? field.defaultValue ?? ''}
          onChange={(e) => onChange(field.key, e.target.value)}
          placeholder={field.placeholder}
          className={INPUT_CLASS}
        />
      )}
      {field.help ? (
        <span className="text-[10px] leading-relaxed text-muted-foreground/80">{field.help}</span>
      ) : null}
    </label>
  );

  return (
    <div className="flex flex-col gap-3">
      {/* 串口不可用：把原因摆出来，别让人对着「启动」按钮猜 */}
      {isSerial && !serialAvailable ? (
        <div className="flex items-start gap-1.5 rounded-md border border-amber-500/40 bg-amber-500/10 px-2.5 py-1.5 text-[10px] leading-relaxed text-amber-700">
          <span className="shrink-0">串口不可用：</span>
          <span>{serialReason || '这台机器上读不到串口'}</span>
        </div>
      ) : null}

      {/* 接入参数：字段由工具定义给出，界面照着摆 */}
      <section className="grid grid-cols-2 gap-2">
        {tool.fields.map((field) =>
          field.dynamic === 'serial-ports' ? renderSerialPort(field) : renderField(field),
        )}
      </section>

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
            {plugin.transports?.length ? (
              <span className="text-[10px] text-muted-foreground/80">
                · 用于{transportScopeText(plugin.transports)}
              </span>
            ) : null}
          </div>
        ) : (
          <p className="text-[10px] leading-relaxed text-muted-foreground/80">
            不解析——收到什么算什么，空闲 200ms 切一条。
          </p>
        )}

        {/* 插件跟接入方式对不上：说清楚，别让人以为已经选上了 */}
        {pluginMismatch && plugin ? (
          <p className="text-[10px] leading-relaxed text-amber-600">
            「{plugin.name}」不适用于{tool.name}（它适用于：{transportScopeText(plugin.transports)}），
            换个接入方式才能用。
          </p>
        ) : null}

        {groups.length === 0 ? (
          <p className="text-[10px] leading-relaxed text-muted-foreground/80">
            {tool.name}暂时还没有专用的解析插件——只能先看着原始字节。
          </p>
        ) : null}
      </section>

      {/* 组包下发：选完协议就能在这儿组一条发出去。
          以前这个入口只在右下角记录区的工具栏里，选完协议得自己找过去——
          选协议、填字段、发送，本该是一气呵成的一条路。 */}
      <section className="flex flex-col gap-1.5 border-t border-border/60 pt-3">
        <Button
          size="sm"
          variant="outline"
          className="h-8 w-full text-[12px]"
          onClick={onOpenBuild}
          disabled={!canBuild}
        >
          <PackageCheck className="h-3.5 w-3.5" />
          组包下发
        </Button>
        <p className="text-[10px] leading-relaxed text-muted-foreground/80">{buildHint}</p>
      </section>
    </div>
  );
}
