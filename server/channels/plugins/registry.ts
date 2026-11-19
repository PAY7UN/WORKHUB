/**
 * 解析插件注册表。
 *
 * 一处真相：界面上「解析插件类型」那个下拉、协议模板的默认解析插件、
 * 会话运行时用哪个切帧器与解码器，全从这里出。
 *
 * 注册表里有两种插件：
 * - **内置插件**：随安装包发布（通达 LED2 就是），署名是项目自己。
 * - **开发者发布的插件**：装在 plugins/ 目录里，署名是发布者。
 *
 * 两种在界面上长得一样，只有署名与来源不同——
 * 用的人不该关心解析是谁写的，但该知道是谁写的。
 */
import type { PluginSummary } from '../../../shared/plugins.ts';
import type { ProtocolBuild, ProtocolTemplate } from '../../../shared/tools.ts';
import { BUILTIN_TEMPLATES } from '../../../shared/tools.ts';
import { BUILTIN_DECODERS } from '../decoders/index.ts';
import type { DecodedFrame, EncodeRequest, FrameSource } from '../parser.ts';
import { listBuiltinDocRefs, seedPluginDoc } from '../../builtinDocs.ts';
import { seedSpecDoc } from '../specDocs.ts';
import { loadPlugins, resolvePluginDir } from './loader.ts';

/** 一个可用的插件：既有给界面看的身份，也有干活的实现 */
export interface PluginEntry extends PluginSummary {
  /** 切帧器 */
  createParser(): FrameSource;
  /** 解一帧 */
  decode(frame: Buffer): DecodedFrame;
  /**
   * 组包：把一条命令组装成字节帧。
   *
   * 「解析」是把收到的字节读成人话，「组包」反过来。
   * 能组什么、每条要填哪些参数，都由插件的解码器说了算——
   * 界面照着 builds 渲染表单，不自己猜协议。
   */
  encode?(request: EncodeRequest): Buffer | null;
  /** 能组哪些命令（给界面渲染表单用） */
  builds?: ProtocolBuild[];
}

/** 注册表的整体状态 */
export interface PluginRegistryState {
  plugins: PluginEntry[];
  /** 协议类型清单：内置的 + 插件自带的 */
  templates: ProtocolTemplate[];
  /** 装载过程中的问题（插件坏了、服务照跑，但要让人看见） */
  warnings: string[];
}

/** 已建好的状态（进程内只建一次） */
let state: PluginRegistryState | null = null;
/** 正在建的那一次：并发调用共用同一个 Promise */
let building: Promise<PluginRegistryState> | null = null;

/** 把异常翻译成一句人话 */
function reason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 内置插件：解码器就是内置插件 */
function builtinPlugins(): PluginEntry[] {
  return BUILTIN_DECODERS.map((decoder) => ({
    id: decoder.id,
    name: decoder.name,
    publisher: decoder.publisher ?? 'WorkHub 内置',
    version: decoder.version ?? '1.0.0',
    summary: decoder.summary,
    protocolId: decoder.protocolId ?? decoder.id,
    transports: decoder.transports,
    spec: decoder.spec,
    builtin: true,
    createParser: () => decoder.createParser(),
    decode: (frame: Buffer) => decoder.decode(frame),
    encode: decoder.encode ? (request: EncodeRequest) => decoder.encode?.(request) ?? null : undefined,
    builds: decoder.builds,
  }));
}

/**
 * 把外部插件并进注册表。
 *
 * 两条绑定规则：
 * - 插件自带协议 → 多出一种协议类型，协议类型的默认解析插件就是它；
 * - 插件挂在已有协议下 → 同一套协议的第二种读法（协议类型是别人的，解析是自己的）。
 *
 * 冲突一律以警告收场，不覆盖别人的东西：
 * 内置的协议不能被外部插件顶掉，同名插件也不能有两个。
 */
function mergeExternal(
  builtin: PluginEntry[],
  templates: ProtocolTemplate[],
  external: Awaited<ReturnType<typeof loadPlugins>>,
): PluginRegistryState {
  const warnings = [...external.warnings];
  const plugins = [...builtin];
  const templateIds = new Set(templates.map((t) => t.id));
  const pluginIds = new Set(plugins.map((p) => p.id));
  /** 插件 id → 它声明要挂的协议 id（自带协议的不算） */
  const attached = new Map<string, string | undefined>();

  for (const loaded of external.plugins) {
    const manifest = loaded.manifest;
    if (pluginIds.has(manifest.id)) {
      warnings.push(`插件 ${manifest.id} 没装上：已经有同名的插件了`);
      continue;
    }
    if (loaded.template) {
      if (templateIds.has(loaded.template.id)) {
        warnings.push(`插件 ${manifest.id} 没装上：协议 id「${loaded.template.id}」已经被占了`);
        continue;
      }
      templateIds.add(loaded.template.id);
      templates.push(loaded.template);
    }
    const entry: PluginEntry = {
      id: manifest.id,
      name: manifest.name,
      publisher: manifest.publisher ?? '未署名',
      version: manifest.version ?? '0.0.0',
      summary: manifest.summary,
      protocolId: loaded.template?.id ?? manifest.protocolId ?? manifest.id,
      transports: loaded.template?.transports ?? manifest.transports,
      spec: manifest.spec,
      builtin: false,
      source: manifest.id,
      createParser: () => loaded.createParser(),
      decode: (frame: Buffer) => loaded.decode(frame),
      encode: loaded.encode ? (request: EncodeRequest) => loaded.encode?.(request) ?? null : undefined,
      builds: loaded.builds,
    };
    plugins.push(entry);
    pluginIds.add(manifest.id);
    attached.set(manifest.id, manifest.protocolId?.trim() || undefined);

    // 插件自带的说明书也进记录区的内置目录——
    // 「看文档」全站只有一处，插件也不例外
    if (loaded.doc && loaded.template) {
      try {
        seedPluginDoc(loaded.template.id, loaded.doc.markdown, loaded.doc.title);
      } catch (err) {
        warnings.push(`插件 ${manifest.id} 的说明书没能进记录区：${reason(err)}`);
      }
    }

    // 没有说明书、却有协议详情 → 用详情生成一份速查放进记录区。
    // 协议详情不是界面上的东西了：它住在记录区，跟说明书住在一起。
    if (loaded.template && manifest.spec) {
      seedSpecDoc(loaded.template.id, loaded.template.name, manifest.spec);
    }
  }

  // 挂着别人协议上的插件：协议得存在，否则它没地方可挂
  const kept = plugins.filter((plugin) => {
    if (plugin.builtin) return true;
    const target = attached.get(plugin.id);
    if (!target) return true;
    if (!templateIds.has(target)) {
      warnings.push(`插件 ${plugin.id} 没装上：找不到它要挂的协议「${target}」`);
      return false;
    }
    plugin.protocolId = target;
    return true;
  });

  return { plugins: kept, templates: attachDocs(templates), warnings };
}

/**
 * 给协议模板补上说明书的引用。
 *
 * 说明书住在记录区的内置目录里，工具区只拿一个引用——
 * 「看文档」全站只有一处，不必在这儿再抄一份正文。
 * 插件自带的文档已经在装载时挂上去了，这里不覆盖。
 */
function attachDocs(templates: ProtocolTemplate[]): ProtocolTemplate[] {
  const refs = listBuiltinDocRefs();
  return templates.map((template) => {
    if (template.doc) return template;
    const ref = refs.find((r) => r.protocolId === template.id);
    if (!ref) return template;
    return {
      ...template,
      doc: {
        nodeId: ref.nodeId,
        title: ref.title,
        origin: ref.origin,
        hasUpdate: ref.hasUpdate,
      },
    };
  });
}

/** 建注册表：内置插件 + 开发者发布的插件 */
async function build(): Promise<PluginRegistryState> {
  const builtin = builtinPlugins();
  const templates = [...BUILTIN_TEMPLATES];
  const dir = resolvePluginDir();
  if (!dir) return { plugins: builtin, templates: attachDocs(templates), warnings: [] };
  try {
    const external = await loadPlugins(dir);
    return mergeExternal(builtin, templates, external);
  } catch (err) {
    // 装载整个目录都失败（权限、路径不是目录……）：内置插件照常用
    return { plugins: builtin, templates: attachDocs(templates), warnings: [`插件目录读不了：${reason(err)}`] };
  }
}

/** 注册表（进程内只建一次） */
export async function pluginRegistry(): Promise<PluginRegistryState> {
  if (state) return state;
  if (!building) {
    building = build().then((next) => {
      state = next;
      return next;
    });
  }
  return building;
}

/**
 * 重建注册表。
 *
 * 导入协议文档、装了新插件之后用：注册表是进程内缓存，
 * 不重建的话，界面上还是旧的协议清单。
 */
export async function refreshPluginRegistry(): Promise<PluginRegistryState> {
  state = null;
  building = null;
  return pluginRegistry();
}

/** 全部插件（给界面用） */
export async function listPlugins(): Promise<PluginSummary[]> {
  const { plugins } = await pluginRegistry();
  return plugins.map((p) => ({
    id: p.id,
    name: p.name,
    publisher: p.publisher,
    version: p.version,
    summary: p.summary,
    protocolId: p.protocolId,
    transports: p.transports,
    spec: p.spec,
    builtin: p.builtin,
    source: p.source,
  }));
}

/** 按 id 找插件 */
export async function findPlugin(id: string | undefined | null): Promise<PluginEntry | undefined> {
  if (!id) return undefined;
  const { plugins } = await pluginRegistry();
  return plugins.find((p) => p.id === id);
}

/** 协议类型清单：内置的 + 插件自带的 */
export async function listTemplates(): Promise<ProtocolTemplate[]> {
  const { templates } = await pluginRegistry();
  return templates;
}

/** 按 id 找协议类型 */
export async function findTemplateById(id: string | undefined | null): Promise<ProtocolTemplate | undefined> {
  if (!id) return undefined;
  const { templates } = await pluginRegistry();
  return templates.find((t) => t.id === id);
}

/** 装载警告：插件坏了要让人看见，但不该拦住别的功能 */
export async function pluginWarnings(): Promise<string[]> {
  const { warnings } = await pluginRegistry();
  return warnings;
}
