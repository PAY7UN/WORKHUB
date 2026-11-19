/**
 * 载入开发者发布的解析插件。
 *
 * 一个插件就是一个目录：
 *
 *   plugins/<插件目录>/manifest.json   清单：id、名字、发布者、版本、协议
 *   plugins/<插件目录>/index.mjs        实现：导出 createParser() 与 decode(frame)
 *
 * 装载器只做三件事：读清单、载入模块、核对它该有的两个函数。
 * 别的都不管——插件自己坏掉（清单写错、模块报错、函数缺失），
 * 只记一条警告：别的插件照常用，服务照常起。
 *
 * 为什么插件能自己带协议：
 * 协议类型与解析实现是两回事。插件既可以自带一套协议
 * （「就我们厂认这套」），也可以挂在已有协议下
 * （「同一套协议，我们还有另一种读法」）。两种都要支持，
 * 否则开发者只能改代码重新打包。
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';
import type { PluginManifest } from '../../../shared/plugins.ts';
import type {
  FrameSegment,
  ProtocolBuild,
  ProtocolTemplate,
  ToolKind,
  TransportScope,
} from '../../../shared/tools.ts';
import type { DecodedFrame, EncodeRequest, FrameSource } from '../parser.ts';

/** 一个已载入的插件 */
export interface LoadedPlugin {
  /** 清单原文 */
  manifest: PluginManifest;
  /** 插件自带的协议（可选） */
  template?: ProtocolTemplate;
  /** 插件自带的说明书（可选）：由调用方种进记录区的内置目录 */
  doc?: { title: string; markdown: string };
  /** 切帧器：自己决定一帧到哪儿为止 */
  createParser(): FrameSource;
  /** 解一帧：读成文本与字段 */
  decode(frame: Buffer): DecodedFrame;
  /** 组包（可选）：把一条命令组装成字节帧 */
  encode?(request: EncodeRequest): Buffer | null;
  /** 能组哪些命令（可选）：界面照着渲染表单 */
  builds?: ProtocolBuild[];
  /** 把组出来的帧按协议结构切成几段（可选）：界面逐段核对用 */
  describeFrame?(frame: Buffer): FrameSegment[];
}

/** 载入结果 */
export interface PluginLoadResult {
  plugins: LoadedPlugin[];
  /** 装载过程中的问题：插件坏了不该让服务起不来，得让人看得见 */
  warnings: string[];
}

/** 插件 id 的合法形态：字母数字开头，可带 . _ - */
const ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

/**
 * 插件目录在哪。
 *
 * 三个候选依次找，谁存在用谁：
 * 1. 环境变量 WORKHUB_PLUGIN_DIR（开发时最常用）；
 * 2. 仓库根下的 plugins/（开发时服务跑在 server/ 里）；
 * 3. 打包后服务所在目录的上一级 plugins/（安装包里 plugins/ 与服务同级）。
 *
 * 为什么不写死一个相对路径：开发时是 server/channels/plugins/loader.ts，
 * 打包后是 server/index.js——同一个相对路径在两处指向不同的地方。
 */
export function pluginDirCandidates(): string[] {
  const list: string[] = [];
  const custom = process.env.WORKHUB_PLUGIN_DIR?.trim();
  if (custom) list.push(custom);
  list.push(join(process.cwd(), 'plugins'));
  list.push(fileURLToPath(new URL('../../../plugins', import.meta.url)));
  list.push(fileURLToPath(new URL('../plugins', import.meta.url)));
  return list;
}

/** 实际生效的插件目录：没有就返回空串（没装插件是正常状态，不是错） */
export function resolvePluginDir(): string {
  for (const dir of pluginDirCandidates()) {
    try {
      if (existsSync(dir)) return dir;
    } catch {
      /* 读不到就当它不存在，继续看下一个 */
    }
  }
  return '';
}

/** 把异常翻译成一句人话 */
function reason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 校验清单：不合格的插件直接不载入 */
function validateManifest(raw: unknown): PluginManifest {
  if (!raw || typeof raw !== 'object') throw new Error('清单不是一个对象');
  const manifest = raw as Partial<PluginManifest>;
  const id = typeof manifest.id === 'string' ? manifest.id.trim() : '';
  if (!id) throw new Error('清单缺少 id');
  if (!ID_PATTERN.test(id)) throw new Error(`插件 id 不合法：${id}`);
  const name = typeof manifest.name === 'string' ? manifest.name.trim() : '';
  if (!name) throw new Error('清单缺少 name');
  if (manifest.protocol && typeof manifest.protocol !== 'object') {
    throw new Error('protocol 写得不对');
  }
  if (manifest.protocol && !manifest.protocol.framing) {
    throw new Error('自带协议必须写清 framing（怎么切帧）');
  }
  return {
    ...manifest,
    id,
    name,
    publisher: manifest.publisher?.trim() || '未署名',
    version: manifest.version?.trim() || '0.0.0',
    entry: manifest.entry?.trim() || 'index.mjs',
    transports: parseTransports(manifest.transports),
  };
}

/**
 * 读清单里的适用范围。
 *
 * 写错了就当这个插件没装——半个字都比不让装强：
 * 插件作者得知道自己写错了什么，而不是装上了却在界面上不出现。
 */
function parseTransports(raw: unknown): TransportScope | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) throw new Error('transports 必须是数组');
  const out: ToolKind[] = [];
  for (const item of raw) {
    if (item !== 'serial' && item !== 'tcp') {
      throw new Error(`transports 里只能是 serial 或 tcp，收到的是「${String(item)}」`);
    }
    if (!out.includes(item)) out.push(item);
  }
  return out.length ? out : undefined;
}

/**
 * 插件自带的协议文档。
 *
 * 清单里写 `doc: "protocol.md"`，就取插件目录下的这个 Markdown。
 *
 * 两条讲究：
 * - 只能读插件目录里的文件，不让它往外翻；
 * - 读不到就当没有——文档是加分项，不该把整个插件卡住。
 */
function loadPluginDoc(dir: string, manifest: PluginManifest): { title: string; markdown: string } | undefined {
  const name = manifest.doc?.trim();
  if (!name) return undefined;
  const base = resolve(dir);
  const target = resolve(base, name);
  if (!target.startsWith(base + sep)) return undefined;
  if (!existsSync(target)) return undefined;
  try {
    const markdown = readFileSync(target, 'utf8');
    return { title: manifest.name, markdown };
  } catch {
    return undefined;
  }
}

/**
 * 载入一个插件目录。
 *
 * 清单里的 protocol 决定它是不是自带协议：
 * - 自带：生成一条协议模板（id 取 protocolId 或插件自己的 id）。
 * - 不自带：挂在 protocolId 说的那套协议下（由调用方核对协议存不存在）。
 */
async function loadOne(dir: string): Promise<LoadedPlugin> {
  const manifestPath = join(dir, 'manifest.json');
  if (!existsSync(manifestPath)) throw new Error('目录里没有 manifest.json');

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (err) {
    throw new Error(`manifest.json 解析不了：${reason(err)}`);
  }
  const manifest = validateManifest(raw);

  const entryPath = join(dir, manifest.entry ?? 'index.mjs');
  if (!existsSync(entryPath)) throw new Error(`入口模块不存在：${manifest.entry}`);

  let mod: Record<string, unknown>;
  try {
    mod = (await import(pathToFileURL(entryPath).href)) as Record<string, unknown>;
  } catch (err) {
    throw new Error(`入口模块加载失败：${reason(err)}`);
  }

  const createParser = mod.createParser;
  const decode = mod.decode;
  if (typeof createParser !== 'function') throw new Error('入口模块没有导出 createParser()');
  if (typeof decode !== 'function') throw new Error('入口模块没有导出 decode(frame)');

  const template: ProtocolTemplate | undefined = manifest.protocol
    ? {
        id: manifest.protocolId?.trim() || manifest.id,
        name: manifest.protocol.name,
        summary: manifest.protocol.summary ?? manifest.summary ?? '',
        framing: manifest.protocol.framing,
        encoding: manifest.protocol.encoding ?? 'utf8',
        // 自带协议的默认解析插件就是它自己
        decoder: manifest.id,
        // 适用范围跟着插件走：这套协议在哪种口上用得上
        transports: manifest.transports,
        defaults: manifest.protocol.defaults,
      }
    : undefined;

  return {
    manifest,
    template,
    doc: loadPluginDoc(dir, manifest),
    createParser: () => (createParser as () => FrameSource)(),
    decode: (frame: Buffer) => (decode as (f: Buffer) => DecodedFrame)(frame),
    // 组包是可选能力：插件导出了 encode 才算数，
    // 没导出就只是「只能读不能写」，不影响它照常工作。
    encode:
      typeof mod.encode === 'function'
        ? (request: EncodeRequest) => (mod.encode as (r: EncodeRequest) => Buffer | null)(request)
        : undefined,
    builds: Array.isArray(mod.builds) ? (mod.builds as ProtocolBuild[]) : undefined,
    describeFrame:
      typeof mod.describeFrame === 'function'
        ? (frame: Buffer) => (mod.describeFrame as (f: Buffer) => FrameSegment[])(frame)
        : undefined,
  };
}

/**
 * 载入一个目录下的全部插件。
 *
 * 目录不存在 = 没装插件（正常）；目录里有坏插件 = 记警告、跳过它。
 */
export async function loadPlugins(dir: string): Promise<PluginLoadResult> {
  const plugins: LoadedPlugin[] = [];
  const warnings: string[] = [];
  if (!dir || !existsSync(dir)) return { plugins, warnings };

  let names: string[];
  try {
    names = readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch (err) {
    warnings.push(`插件目录读不了：${reason(err)}`);
    return { plugins, warnings };
  }

  for (const name of names) {
    // 目录名以 . 或 _ 开头的是编辑器/系统留下的，不当插件看
    if (name.startsWith('.') || name.startsWith('_')) continue;
    try {
      plugins.push(await loadOne(join(dir, name)));
    } catch (err) {
      warnings.push(`插件 ${name} 没装上：${reason(err)}`);
    }
  }
  return { plugins, warnings };
}
