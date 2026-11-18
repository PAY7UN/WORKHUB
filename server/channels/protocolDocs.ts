/**
 * 协议说明书的「仓库里那份」。
 *
 * 说明书现在住在记录区的内置目录里（见 server/builtinDocs.ts）——
 * 「看文档」只有一处，工具区只拿一个引用。
 * 但仓库里还得留一份：那才是**内置版**，改它等于改协议说明，
 * 要走代码评审；现场版则以它为基线做同步。
 *
 * 协议 id 会拼进文件路径，所以必须先校验：
 * 只放行字母数字与 `._-`，其余一律拒绝——这是防路径穿越的第一道门。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { APP_ROOT } from '../paths.ts';

/** 协议 id 的合法形态：字母数字开头，可带 . _ - */
const ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

/**
 * 旧版导入目录：曾经导入的说明书落在那里。
 *
 * 现在导入的内容直接写进记录区的节点，这个目录不再是数据源；
 * 它只留到「旧数据搬进记录区」那一步搬空为止。
 */
export const DEFAULT_PROTOCOL_DOCS_DIR = join(APP_ROOT, 'data', 'protocol-docs');

/** 内置文档目录：随代码发布的那一份 */
export const BUILTIN_PROTOCOL_DOCS_DIR = join(APP_ROOT, 'docs', 'protocols');

/** 解析导入文档目录 */
export function resolveProtocolDocsDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.PROTOCOL_DOCS_DIR?.trim() || DEFAULT_PROTOCOL_DOCS_DIR;
}

/** 解析内置文档目录 */
export function resolveBuiltinProtocolDocsDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.BUILTIN_PROTOCOL_DOCS_DIR?.trim() || BUILTIN_PROTOCOL_DOCS_DIR;
}

/** 协议 id 合不合法 */
export function isValidProtocolId(id: string): boolean {
  return ID_PATTERN.test(id);
}

/** 文档文件名 */
function docFileName(protocolId: string): string {
  return `${protocolId}.md`;
}

/** 从一段 Markdown 里取出标题（第一行 # 标题） */
function titleOf(markdown: string, fallback: string): string {
  const match = markdown.match(/^#\s+(.+)$/m);
  return match ? match[1].trim() : fallback;
}

/**
 * 读仓库里那份说明书。
 *
 * 读不出来就当没有：文档是加分项，不该把整页拖垮。
 */
export function readBuiltinProtocolDoc(
  protocolId: string,
  env: NodeJS.ProcessEnv = process.env,
): { title: string; markdown: string } | undefined {
  if (!isValidProtocolId(protocolId)) return undefined;
  const builtin = join(resolveBuiltinProtocolDocsDir(env), docFileName(protocolId));
  if (!existsSync(builtin)) return undefined;
  try {
    const markdown = readFileSync(builtin, 'utf8');
    return { title: titleOf(markdown, protocolId), markdown };
  } catch {
    return undefined;
  }
}

/** 仓库里有说明书的协议 id */
export function listBuiltinProtocolDocIds(env: NodeJS.ProcessEnv = process.env): string[] {
  const dir = resolveBuiltinProtocolDocsDir(env);
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter((name) => name.endsWith('.md'))
      .map((name) => name.slice(0, -3))
      .sort();
  } catch {
    return [];
  }
}
