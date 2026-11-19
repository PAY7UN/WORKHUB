import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { AlertTriangle, ArrowLeft, Loader2, Play, RotateCcw, Square } from 'lucide-react';
import { toast } from 'sonner';
import { api, type ToolsCatalog } from '@/lib/api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import type { ChannelRecord, SerialPortInfo } from '../../../../shared/tools';
import { appliesToTransport } from '../../../../shared/tools';
import { AccessConfigPanel } from './AccessConfigPanel';
import { RecordStream } from './RecordStream';
import { BuildDialog } from './BuildDialog';
import { HexDecodeDialog, SendDialog } from './ChannelDialogs';
import { useChannelStream } from './useChannelStream';

/** 记录表最多渲染多少条：再多的滚动也看不出来，只会把界面拖慢 */
const VISIBLE_RECORDS = 300;

/**
 * 接入页：**一屏之内把所有事做完**，不再跳来跳去。
 *
 * 这一屏只分两半：
 *
 * - **左边「基本信息」**：接哪儿、按哪套协议读（端口与线参数，或网口的方式与地址）。
 * - **右边「实时数据」**：读到的字节，切好帧、解好，直接摊在这儿。
 *
 * 串口与网口是同一屏、同一套流水线——区别只在「字节从哪儿来」：
 * 串口是插在本机上的线，网口是等设备连进来的端口（JT/T 808 终端就是这样）。
 *
 * 以前解析结果藏在右边的「接收详单」里，得点中某一条才看得见；
 * 现在收进来就解出来、就摆出来——现场盯着这一列就知道设备此刻在说什么。
 */
export function AccessPage() {
  const navigate = useNavigate();
  const { category } = useParams();
  const [searchParams] = useSearchParams();
  const [catalog, setCatalog] = useState<ToolsCatalog | null>(null);
  const [serialPorts, setSerialPorts] = useState<SerialPortInfo[]>([]);
  const [scanning, setScanning] = useState(false);
  /** 接入参数 */
  const [values, setValues] = useState<Record<string, string>>({});
  /** 人手动改过的字段：换协议时不覆盖这些 */
  const [touched, setTouched] = useState<Set<string>>(new Set());
  /**
   * 选中的解析插件 id（空串 = 不解析）。
   *
   * 协议类型与解析插件是一件事：一个 id 顶两件事——
   * 插件自己带着协议 id，选了它协议也就定了。
   */
  const [pluginId, setPluginId] = useState('');
  /** 当前这条通道（不开就在这儿待着） */
  const [sessionId, setSessionId] = useState<string | null>(searchParams.get('session'));
  const [busy, setBusy] = useState(false);
  const [sending, setSending] = useState(false);
  /** 组包中 */
  const [building, setBuilding] = useState(false);
  /** 清屏的时间点：这一时刻之前的记录不显示了（服务端还记着） */
  const [clearedBefore, setClearedBefore] = useState(0);
  /** 从 CSV 导入的记录：只摊在这一屏，不进服务端记录表 */
  const [imported, setImported] = useState<ChannelRecord[]>([]);
  /** 发送面板 / 解 HEX 面板 / 组包面板 */
  const [sendOpen, setSendOpen] = useState(false);
  const [hexOpen, setHexOpen] = useState(false);
  const [buildOpen, setBuildOpen] = useState(false);

  const { records, session, peers, error, refresh } = useChannelStream(sessionId);
  const running = session?.status === 'running';

  /** 插件 id 的最新值：重置表单时要读它，但不因此重建表单 */
  const pluginIdRef = useRef(pluginId);
  pluginIdRef.current = pluginId;
  /** 从协议清单点「调试」跳过来时带的插件 */
  const parserParam = searchParams.get('parser') ?? '';

  /** 读工具目录 */
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const cat = await api.tools.catalog();
        if (cancelled) return;
        setCatalog(cat);
      } catch (err) {
        if (!cancelled) toast.error(err instanceof Error ? err.message : '读取工具目录失败');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /** 扫本机串口：设备会被拔插，所以要能重扫 */
  const scanSerialPorts = useCallback(async () => {
    setScanning(true);
    try {
      setSerialPorts(await api.tools.serialPorts());
    } catch {
      /* 扫不到就空着，界面会让人手填 */
    } finally {
      setScanning(false);
    }
  }, []);

  useEffect(() => {
    void scanSerialPorts();
  }, [scanSerialPorts]);

  /**
   * 接入方式：路由里的大类（/tools/serial、/tools/tcp）对应哪一种。
   *
   * 大类与接入方式是一对一的，但仍然是两件事——
   * 目录里先摆大类，点进去才见具体参数。
   */
  const tool = useMemo(
    () => catalog?.tools.find((t) => t.id === category) ?? catalog?.tools[0],
    [catalog, category],
  );
  /** 接入大类：标题、说明都用它 */
  const categoryDef = useMemo(
    () => catalog?.categories.find((c) => c.id === tool?.id),
    [catalog, tool],
  );

  /**
   * 接入参数初值。
   *
   * 顺序：工具自己的默认值 → 协议推荐的参数（人没动过的）。
   * 协议推荐值优先于工具默认值——选了通达 LED2，波特率就该是 38400 而不是 115200。
   */
  useEffect(() => {
    if (!tool) return;
    const initial: Record<string, string> = {};
    for (const field of tool.fields) {
      if (field.defaultValue) initial[field.key] = field.defaultValue;
    }
    const plugin = (catalog?.plugins ?? []).find((p) => p.id === pluginIdRef.current);
    const template = catalog?.protocols.find((t) => t.id === plugin?.protocolId);
    for (const [key, value] of Object.entries(template?.defaults ?? {})) {
      initial[key] = value;
    }
    setValues(initial);
    setTouched(new Set());
  }, [tool, catalog]);

  /** 串口默认挑第一个本机扫到的口。只在值为空时补，人手动选过就不再插手。 */
  useEffect(() => {
    if (!tool || serialPorts.length === 0) return;
    if (!tool.fields.some((f) => f.dynamic === 'serial-ports')) return;
    setValues((prev) => (prev.port ? prev : { ...prev, port: serialPorts[0].path }));
  }, [serialPorts, tool]);

  /** 选解析插件：协议推荐的参数填进去，但不碰人改过的 */
  const handlePickParser = useCallback(
    (next: string) => {
      setPluginId(next);
      const plugin = (catalog?.plugins ?? []).find((p) => p.id === next);
      const template = catalog?.protocols.find((t) => t.id === plugin?.protocolId);
      const defaults = template?.defaults ?? {};
      setValues((prev) => {
        const merged = { ...prev };
        for (const [key, value] of Object.entries(defaults)) {
          if (!touched.has(key)) merged[key] = value;
        }
        return merged;
      });
    },
    [catalog, touched],
  );

  /** 从协议清单页跳过来时，把那边选中的插件带上 */
  useEffect(() => {
    if (!parserParam || !catalog) return;
    if (pluginIdRef.current) return;
    const plugin = catalog.plugins.find((p) => p.id === parserParam);
    if (!plugin) return;
    // 串口的协议别带到网口页来：那边根本用不了
    if (tool && !appliesToTransport(plugin.transports, tool.id)) return;
    handlePickParser(parserParam);
  }, [parserParam, catalog, handlePickParser, tool]);

  /**
   * 换接入方式时，把对不上的解析插件撤掉。
   *
   * 串口页选的通达 LED2 切到网口页就用不了了——留着会让界面显示一个
   * 「选了却用不上」的插件，不如直接撤掉，让它回到「不解析」。
   */
  useEffect(() => {
    if (!tool || !catalog || !pluginId) return;
    const plugin = catalog.plugins.find((p) => p.id === pluginId);
    if (!plugin) return;
    if (appliesToTransport(plugin.transports, tool.id)) return;
    handlePickParser('');
  }, [tool, catalog, pluginId, handlePickParser]);

  /** 改一个参数 */
  const handleChange = useCallback((key: string, value: string) => {
    setValues((prev) => ({ ...prev, [key]: value }));
    setTouched((prev) => new Set(prev).add(key));
  }, []);

  /** 选中的插件 */
  const pickedPlugin = useMemo(
    () => (catalog?.plugins ?? []).find((p) => p.id === pluginId),
    [catalog, pluginId],
  );

  /**
   * 从工具页点「打开控制台」进来：把那条通道的配置搬回左栏。
   *
   * 搬的是服务端记着的那份（端口、波特率、用的哪套协议），
   * 不是页面上临时填的——这样进来看到的跟跑着的一模一样。
   */
  const adoptedRef = useRef(false);
  useEffect(() => {
    if (adoptedRef.current || !session || !catalog) return;
    if (!session.config) return;
    adoptedRef.current = true;
    setValues(session.config);
    if (session.pluginId) setPluginId(session.pluginId);
  }, [session, catalog]);

  /**
   * 启动：开了就在这一屏上看着数据进来，不跳走。
   */
  const handleStart = useCallback(async () => {
    if (!tool) return;
    const missing = tool.fields.filter((f) => f.required && !values[f.key]?.trim());
    if (missing.length) {
      toast.error(`还差：${missing.map((f) => f.label).join('、')}`);
      return;
    }
    setBusy(true);
    try {
      const next = await api.tools.startSession({
        tool: tool.id,
        protocolId: pickedPlugin?.protocolId ?? '',
        pluginId,
        config: values,
      });
      setSessionId(next.id);
      setClearedBefore(0);
      setImported([]);
      toast.success(`${tool.name}已打开`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [tool, values, pickedPlugin, pluginId]);

  /** 停掉这条通道 */
  const handleStop = useCallback(async () => {
    if (!session) return;
    try {
      await api.tools.stopSession(session.id);
      await refresh();
      toast.success('已停止');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }, [session, refresh]);

  /**
   * 按当前参数重开这条通道。
   *
   * 端口、波特率、协议这些是「怎么接、怎么读」的事，
   * 开着通道改不动——只能关掉重开。
   */
  const handleRestart = useCallback(async () => {
    if (!session || !tool) return;
    setBusy(true);
    try {
      await api.tools.stopSession(session.id);
      const next = await api.tools.startSession({
        tool: tool.id,
        protocolId: pickedPlugin?.protocolId ?? '',
        pluginId,
        config: values,
      });
      setSessionId(next.id);
      setClearedBefore(0);
      toast.success('已按新参数重开');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
      await refresh();
    } finally {
      setBusy(false);
    }
  }, [session, tool, values, pickedPlugin, pluginId, refresh]);

  /** 发一帧出去 */
  const handleSend = useCallback(
    async (data: string, format: 'text' | 'hex', peer?: string) => {
      if (!session) return;
      setSending(true);
      try {
        await api.tools.send(session.id, data, format, peer);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err));
      } finally {
        setSending(false);
      }
    },
    [session],
  );

  /**
   * 组一条命令并发出去。
   *
   * 组包与发送是同一件事的两面：「发送」是给字节，
   * 「组包」是给参数——由协议决定字节长什么样。
   */
  const handleBuild = useCallback(
    async (kind: string, args: Record<string, string>, peer?: string) => {
      if (!session) return;
      setBuilding(true);
      try {
        const result = await api.tools.build(session.id, kind, args, peer);
        toast.success(`已发出 ${result.bytes} 字节`);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err));
      } finally {
        setBuilding(false);
      }
    },
    [session],
  );

  /** 只渲染最近一段记录：再多也看不出区别 */
  const shown = useMemo(() => records.slice(-VISIBLE_RECORDS), [records]);
  /** 清屏之后还在的那些 */
  const tableRecords = useMemo(
    () => shown.filter((r) => r.ts > clearedBefore),
    [shown, clearedBefore],
  );
  /** 导入的排在前面，方便跟刚收到的对 */
  const streamRecords = useMemo(() => [...imported, ...tableRecords], [imported, tableRecords]);

  /** 这条通道能组哪些命令（由解析插件说了算） */
  const builds = session?.builds ?? [];

  /**
   * 参数改了但通道还开着——跑着的通道不会自己换协议、换波特率，
   * 得重开才生效。这儿把这件事说出来，别让人以为改了已经算了。
   */
  const dirty = useMemo(() => {
    if (!session || !running) return false;
    if ((session.pluginId ?? '') !== pluginId) return true;
    const cfg = session.config ?? {};
    const keys = new Set([...Object.keys(cfg), ...Object.keys(values)]);
    for (const key of keys) {
      if ((cfg[key] ?? '') !== (values[key] ?? '')) return true;
    }
    return false;
  }, [session, running, pluginId, values]);

  return (
    <div className="flex h-full flex-col overflow-hidden bg-background text-foreground">
      {/* 顶栏：一句话说清这页是干什么的 */}
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border/70 px-3">
        <Button
          size="sm"
          variant="ghost"
          className="h-8 px-2 text-muted-foreground"
          onClick={() => navigate('/tools')}
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          工具
        </Button>
        <span className="h-5 w-px bg-border/70" />
        <span className="rounded bg-indigo-500/10 px-2 py-0.5 text-[12px] font-medium text-indigo-600">
          {categoryDef?.name ?? tool?.name ?? '接入'}
        </span>
        <Badge
          variant={running ? 'secondary' : 'outline'}
          className={`px-1.5 py-0 text-[10px] ${running ? 'text-emerald-600' : ''}`}
        >
          {running ? '已连接' : '未连接'}
        </Badge>
        <p className="ml-1 hidden text-[11px] text-muted-foreground lg:block">
          {categoryDef?.summary ?? '把它读出来的字节，按协议解析成一条条记录。'}
        </p>

        <div className="ml-auto flex items-center gap-2">
          {error ? (
            <span className="flex items-center gap-1 text-[11px] text-rose-600">
              <AlertTriangle className="h-3.5 w-3.5" />
              {error}
            </span>
          ) : null}
          {peers.length ? (
            <span className="text-[11px] text-muted-foreground">
              对端 {peers.length} 个
            </span>
          ) : null}
          {session ? (
            <span className="tabular-nums text-[11px] text-muted-foreground">
              收 {session.bytesIn} / 发 {session.bytesOut} 字节
            </span>
          ) : null}
          {dirty ? (
            <>
              <span className="text-[11px] text-amber-600">参数已改，重启生效</span>
              <Button
                size="sm"
                variant="outline"
                className="h-8"
                disabled={busy}
                onClick={() => void handleRestart()}
              >
                <RotateCcw className="h-3.5 w-3.5" />
                重启
              </Button>
            </>
          ) : null}
          {running ? (
            <Button size="sm" variant="outline" className="h-8" onClick={() => void handleStop()}>
              <Square className="h-3.5 w-3.5" />
              停止
            </Button>
          ) : (
            <Button size="sm" className="h-8" onClick={() => void handleStart()} disabled={busy}>
              {busy ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Play className="h-3.5 w-3.5" />
              )}
              启动
            </Button>
          )}
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* 左：基本信息 */}
        <aside className="flex w-[17rem] shrink-0 flex-col overflow-auto border-r border-border/70 px-3 py-3">
          <div className="mb-3 flex items-center gap-2">
            <span className="text-[12px] font-medium">基本信息</span>
            {tool ? (
              <Badge variant="outline" className="px-1.5 py-0 text-[10px]">
                {tool.name}
              </Badge>
            ) : null}
          </div>
          {tool ? (
            <AccessConfigPanel
              tool={tool}
              catalog={
                catalog ?? {
                  tools: [],
                  protocols: [],
                  plugins: [],
                  categories: [],
                  groups: {},
                  pluginWarnings: [],
                  serial: { available: false, reason: '还没读目录' },
                }
              }
              serialPorts={serialPorts}
              scanning={scanning}
              onRescan={() => void scanSerialPorts()}
              values={values}
              onChange={handleChange}
              pluginId={pluginId}
              onPluginChange={handlePickParser}
              onBrowseProtocols={() => navigate('/tools/protocols')}
              canBuild={builds.length > 0}
              buildHint={
                !running
                  ? '先把通道开了，才能组包发出去。'
                  : builds.length > 0
                    ? '按上面这套协议组一条消息发出去。'
                    : '这套协议只能读、不能组——换个解析插件试试。'
              }
              onOpenBuild={() => setBuildOpen(true)}
              serialAvailable={catalog?.serial.available ?? false}
              serialReason={catalog?.serial.reason ?? ''}
            />
          ) : (
            <p className="text-[11px] text-muted-foreground">正在读工具目录…</p>
          )}
        </aside>

        {/* 右：实时数据（进来就解析，直接摊着） */}
        <RecordStream
          className="min-w-0 flex-1"
          records={streamRecords}
          running={running}
          onClear={() => setClearedBefore(Date.now())}
          onSend={() => setSendOpen(true)}
          onDecodeHex={() => setHexOpen(true)}
          canBuild={builds.length > 0}
          onBuild={() => setBuildOpen(true)}
          onImport={(next) => setImported(next)}
        />
      </div>

      {/* 发送 / 解 HEX / 组包：各自一个弹窗，不占主屏 */}
      <SendDialog
        open={sendOpen}
        onOpenChange={setSendOpen}
        running={running}
        sending={sending}
        peers={peers}
        onSend={(data, format, peer) => void handleSend(data, format, peer)}
      />
      <HexDecodeDialog open={hexOpen} onOpenChange={setHexOpen} pluginId={pluginId} />
      <BuildDialog
        open={buildOpen}
        onOpenChange={setBuildOpen}
        builds={builds}
        peers={peers}
        running={running}
        building={building}
        onBuild={(kind, args, peer) => void handleBuild(kind, args, peer)}
      />
    </div>
  );
}
