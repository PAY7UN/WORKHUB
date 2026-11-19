import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { BookOpen, ChevronDown, FileText, Loader2, Search, Terminal } from 'lucide-react';
import { toast } from 'sonner';
import { api, type ToolsCatalog } from '@/lib/api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { PluginSummary } from '../../../../shared/plugins';
import type { ProtocolTemplate, ToolKind } from '../../../../shared/tools';
import { TOOL_KIND_LABELS } from '../../../../shared/tools';
import { docOriginLabel, framingText } from './protocolBits';

/**
 * 支持的协议：**一页索引，就地展开**。
 *
 * 这一页只干一件事：挑一套协议。别的都不在这儿摊开——
 *
 * - **帧结构、命令码不在这里**。它们是文档，住在记录区的内置目录里：
 *   由记录区渲染、由记录区检索，全站只有一份正文、一处渲染器。
 *   这里只给一个入口：「在记录区看说明书」。
 * - **怎么接不在这里**。波特率、校验位那些是接入页的事。
 *   这一行只留一句「怎么切帧」，那是挑协议时唯一要看的。
 *
 * 展开的那一行＝这套协议的说明书入口 + 由谁实现（解析插件）。
 */
export function ProtocolListPage() {
  const navigate = useNavigate();
  const [catalog, setCatalog] = useState<ToolsCatalog | null>(null);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  /** 展开中的协议 id：同一时刻只摊开一行，页面不至于被撑成两屏 */
  const [expandedId, setExpandedId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const cat = await api.tools.catalog();
        if (!cancelled) setCatalog(cat);
      } catch (err) {
        if (!cancelled) toast.error(err instanceof Error ? err.message : '读取工具目录失败');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /** 每套协议 + 它下面的解析插件 */
  const rows = useMemo(() => {
    const plugins = catalog?.plugins ?? [];
    return (catalog?.protocols ?? []).map((template) => ({
      template,
      plugins: plugins.filter((p) => p.protocolId === template.id),
    }));
  }, [catalog]);

  /** 按名字或摘要筛一下：协议多了以后光靠翻不合适 */
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(
      ({ template }) =>
        template.name.toLowerCase().includes(q) || template.summary.toLowerCase().includes(q),
    );
  }, [rows, query]);

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-[12px] text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        正在读取协议清单…
      </div>
    );
  }

  return (
    <div className="mx-auto flex h-full w-full max-w-4xl flex-col gap-4 overflow-y-auto px-6 py-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold tracking-tight">支持的协议</h1>
        <p className="text-[13px] leading-relaxed text-muted-foreground">
          接进来的字节按哪一套切帧、按哪一套读。点一行看它的说明书与解析插件。
        </p>
        <p className="text-[11px] text-muted-foreground/80">
          {rows.length} 套协议 · {catalog?.plugins?.length ?? 0} 个解析插件
        </p>
      </header>

      {rows.length > 4 ? (
        <div className="relative max-w-sm">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="按名字或说明找协议"
            className="h-8 pl-8 text-[12px]"
          />
        </div>
      ) : null}

      <div className="flex flex-col gap-1.5">
        {shown.map(({ template, plugins }) => {
          const expanded = expandedId === template.id;
          const doc = template.doc;

          return (
            <div
              key={template.id}
              className="rounded-lg border border-border/70 bg-card/30 transition-colors"
            >
              <button
                type="button"
                aria-expanded={expanded}
                onClick={() => setExpandedId(expanded ? null : template.id)}
                className="group flex w-full items-center gap-3 px-3.5 py-2.5 text-left transition-colors hover:bg-card/60"
              >
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-[13px] font-medium">{template.name}</span>
                    {template.id === 'raw' ? (
                      <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">
                        不解析
                      </Badge>
                    ) : null}
                    {doc ? (
                      <Badge variant="outline" className="px-1.5 py-0 text-[10px]">
                        <FileText className="h-2.5 w-2.5" />
                        {docOriginLabel(doc.origin)}文档
                      </Badge>
                    ) : null}
                    {doc?.hasUpdate ? (
                      <Badge
                        variant="outline"
                        className="border-amber-500/60 px-1.5 py-0 text-[10px] text-amber-600"
                      >
                        代码里有新版
                      </Badge>
                    ) : null}
                    {plugins.length ? (
                      <Badge variant="outline" className="px-1.5 py-0 text-[10px]">
                        {plugins.length} 个解析插件
                      </Badge>
                    ) : null}
                    {/* 这套协议接在哪种口上：串口的车载屏协议与网口的 808 终端不是一回事 */}
                    {template.transports?.length ? (
                      <Badge variant="outline" className="px-1.5 py-0 text-[10px]">
                        {template.transports.map((k) => TOOL_KIND_LABELS[k]).join(' / ')}
                      </Badge>
                    ) : null}
                  </div>
                  <p className="truncate text-[11px] text-muted-foreground">{template.summary}</p>
                </div>
                <span className="hidden shrink-0 text-[11px] text-muted-foreground sm:block">
                  {framingText(template)}
                </span>
                <ChevronDown
                  className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform ${
                    expanded ? 'rotate-180' : ''
                  }`}
                />
              </button>

              {expanded ? (
                <ProtocolExpandedPanel
                  template={template}
                  plugins={plugins}
                  onOpenDoc={() => {
                    if (!doc) return;
                    // 说明书住在记录区：深链过去，落在这篇文档上
                    navigate(`/?doc=${encodeURIComponent(doc.nodeId)}`);
                  }}
                  onUseParser={(plugin, kind) =>
                    navigate(`/tools/${kind}?parser=${encodeURIComponent(plugin.id)}`)
                  }
                />
              ) : null}
            </div>
          );
        })}
        {shown.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border/70 px-4 py-8 text-center text-[12px] text-muted-foreground">
            没有匹配的协议。
          </p>
        ) : null}
      </div>

      {catalog?.pluginWarnings?.length ? (
        <section className="flex flex-col gap-1 rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3">
          <span className="text-[12px] font-medium text-amber-700">有插件没装上</span>
          {catalog.pluginWarnings.map((warn) => (
            <p key={warn} className="text-[10px] leading-relaxed text-amber-700/90">
              {warn}
            </p>
          ))}
        </section>
      ) : null}
    </div>
  );
}

/**
 * 这个插件能在哪种接入方式上用。
 *
 * 没写适用范围 = 不挑，两种口都给入口；
 * 写了就只给那种口——串口的车载屏协议与网口的 808 终端不是一回事。
 */
function transportsOf(plugin: PluginSummary): ToolKind[] {
  return plugin.transports?.length ? plugin.transports : ['serial', 'tcp'];
}

/** 展开后的内容：说明书在哪儿、这套协议由谁实现 */
function ProtocolExpandedPanel({
  template,
  plugins,
  onOpenDoc,
  onUseParser,
}: {
  template: ProtocolTemplate;
  plugins: PluginSummary[];
  onOpenDoc: () => void;
  onUseParser: (plugin: PluginSummary, kind: ToolKind) => void;
}) {
  const doc = template.doc;
  return (
    <div className="flex flex-col gap-3 border-t border-border/60 px-3.5 py-3">
      {/* 说明书在记录区：这里只给入口，不摊开正文 */}
      <div className="flex flex-wrap items-center gap-2">
        <BookOpen className="h-3.5 w-3.5 text-indigo-500" />
        <span className="text-[12px]">
          {doc ? doc.title || `${template.name} 说明书` : '这套协议还没有说明书'}
        </span>
        {doc ? (
          <Button
            size="sm"
            variant="outline"
            className="h-7 px-2 text-[11px]"
            onClick={onOpenDoc}
          >
            在记录区看说明书
          </Button>
        ) : null}
        {doc?.origin === 'local' ? (
          <span className="text-[10px] text-muted-foreground">现场改过，代码更新不会覆盖</span>
        ) : null}
      </div>

      {/* 这套协议默认怎么接（切帧方式在标题那一行已经写着，不重复） */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
        <span>解码 {template.encoding}</span>
        {template.defaults
          ? Object.entries(template.defaults).map(([key, value]) => (
              <span key={key}>
                · {key} {value}
              </span>
            ))
          : null}
      </div>

      {/* 解析插件：这套协议由谁实现 */}
      {plugins.length ? (
        <section className="flex flex-col gap-2">
          <h3 className="text-[12px] font-medium">解析插件</h3>
          <div className="grid gap-2 sm:grid-cols-2">
            {plugins.map((plugin) => (
              <article
                key={plugin.id}
                className="flex flex-col gap-1.5 rounded-lg border border-border/70 bg-card/30 p-3"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[12px] font-medium">{plugin.name}</span>
                  <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">
                    {plugin.builtin ? '内置' : '开发者发布'}
                  </Badge>
                </div>
                <p className="text-[10px] text-muted-foreground/80">
                  {plugin.publisher} · v{plugin.version}
                </p>
                {plugin.summary ? (
                  <p className="text-[11px] leading-relaxed text-muted-foreground">{plugin.summary}</p>
                ) : null}
                <div className="mt-auto flex flex-wrap gap-1.5 pt-1">
                  {/* 插件在哪种口上用得上，就给哪种口一个入口：
                      串口的协议别把人领到网口去 */}
                  {transportsOf(plugin).map((kind) => (
                    <Button
                      key={kind}
                      size="sm"
                      variant="outline"
                      className="h-7 px-2 text-[11px]"
                      onClick={() => onUseParser(plugin, kind)}
                    >
                      <Terminal className="h-3 w-3" />
                      用{TOOL_KIND_LABELS[kind]}调试
                    </Button>
                  ))}
                </div>
              </article>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}
