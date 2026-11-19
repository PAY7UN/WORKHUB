/**
 * 内置文档的存放约定。
 *
 * 记录区里有一类文档是「系统自带」的：协议说明书跟着代码走版本管理——
 * 改它等于改协议说明，要走代码评审；现场改坏了也有备份。
 *
 * 它们住在 vault 的一个保留段里。为什么用路径而不是给 nodes 表加一列
 * is_builtin：这张表结构一旦对不上就会拒绝启动，要求所有人重建库
 * （见 schema.ts 的 assertWritableSchema）。加一个保留路径段是零成本的替代：
 * 「这个节点受不受保护」翻一眼路径就知道，不用查库也不用改表。
 *
 * 保留段以 ~ 开头：界面不允许用 ~ 开头的名字建目录或文件，
 * 所以这一段不可能被用户的目录撞上。
 */
import type { ToolKind } from '../../../shared/tools.ts';

/** 保留路径段：内置文档全在这个段下面 */
export const BUILTIN_ROOT_SEGMENT = '~builtin';

/** 内置工具目录的节点 id（固定，跨启动不变） */
export const BUILTIN_TOOLS_DIR_ID = 'builtin-tools';

/** 内置工具目录在记录区里的显示名 */
export const BUILTIN_TOOLS_DIR_NAME = '工具';

/**
 * 工具目录下的子目录：按接入方式分。
 *
 * 串口接的车载屏与网口接的定位终端不是一类东西，两边的说明书
 * 混在一个目录里翻起来费劲。各归各的目录，找的时候一眼就知道该翻哪边。
 *
 * 节点 id 是固定的（跨启动不变）：否则每次启动都会多出一对新目录。
 */
export interface BuiltinToolsSubdir {
  /** 节点 id */
  id: string;
  /** 显示名 */
  name: string;
  /** 对应的接入方式 */
  kind: ToolKind;
}

/** 按接入方式分的子目录 */
export const BUILTIN_TOOLS_SUBDIRS: BuiltinToolsSubdir[] = [
  { id: 'builtin-tools-serial', name: '串口', kind: 'serial' },
  { id: 'builtin-tools-tcp', name: '网口', kind: 'tcp' },
];

/** 某个接入方式对应的子目录 */
export function builtinToolsSubdirOf(kind: ToolKind): BuiltinToolsSubdir | undefined {
  return BUILTIN_TOOLS_SUBDIRS.find((d) => d.kind === kind);
}

/**
 * 路径是不是落在保留段里。
 *
 * 只比第一段：`~builtin` 本身，以及 `~builtin/...`。
 */
export function isBuiltinPath(path: string | undefined | null): boolean {
  if (!path) return false;
  return path === BUILTIN_ROOT_SEGMENT || path.startsWith(`${BUILTIN_ROOT_SEGMENT}/`);
}

/**
 * 内置文档的节点 id：由协议 id 推出来。
 *
 * 固定 id 是有意的：协议改名、说明书换名之后，
 * 下次启动认的还是同一个节点，不会「多出一份新的、旧的还留着」。
 */
export function builtinDocNodeId(protocolId: string): string {
  return `builtin-doc-${protocolId}`;
}

/**
 * 从节点 id 反推协议 id。
 *
 * 节点 id 是固定前缀拼出来的，所以反推是确定的；认不出来的（非内置节点）
 * 返回 null，调用方据此判断「这不是内置文档」。
 */
export function protocolIdOfBuiltinNode(nodeId: string | undefined | null): string | null {
  if (!nodeId) return null;
  const prefix = 'builtin-doc-';
  if (!nodeId.startsWith(prefix)) return null;
  return nodeId.slice(prefix.length) || null;
}
