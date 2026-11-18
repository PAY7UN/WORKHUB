/**
 * 协议详情 → Markdown。
 *
 * 协议详情（帧结构、命令码、地址表）是解析器给的，形状是结构化的；
 * 文档是人读的，形状是散文与表格。两者对不上，所以要人翻一遍。
 *
 * 为什么翻好之后要放进记录区，而不是留在工具区就地摊开：
 * - 工具区只办事（接进来、看协议清单）。摊开一堆帧结构与命令码，
 *   那一页就变成了手册，工具区该有的「选一套」反而被淹没；
 * - 记录区是文档的归宿：它有渲染器、有检索、有版本管理。
 *   协议详情放进去，和说明书住在一起，一处渲染、一处检索。
 *
 * 内容一个字段都不改：这里只做翻译，不做取舍——
 * 省略哪些内容是人的决定，不是生成器的决定。
 */
import type { ProtocolSpec } from '../../shared/tools.ts';

/**
 * 表格单元格里不能出现的字符。
 *
 * 竖线是表格的分隔符，正文里的竖线不转义会把表格撑歪；
 * 换行会让一行内容断成两行，表格就散了。
 */
function cell(text: string): string {
  return text
    .replace(/\|/g, '\\|')
    .replace(/\r?\n\s*/g, ' ')
    .trim();
}

/** 一节：小标题 + 内容 */
function section(title: string, body: string[]): string {
  return [`## ${title}`, ...body].join('\n');
}

/** 帧结构：一帧由哪几段拼起来 */
function frameSection(spec: ProtocolSpec): string {
  const parts = spec.frame ?? [];
  if (!parts.length) return '';
  return section('帧结构', [
    '| 段 | 长度 | 说明 |',
    '| --- | --- | --- |',
    ...parts.map((part) => `| ${cell(part.name)} | ${cell(part.bytes ?? '')} | ${cell(part.desc)} |`),
  ]);
}

/** 命令码：这条消息讲什么、数据区里有什么 */
function commandSection(spec: ProtocolSpec): string {
  const commands = spec.commands ?? [];
  if (!commands.length) return '';
  return section('命令码', [
    '| 码值 | 命令 | 数据区字段 |',
    '| --- | --- | --- |',
    ...commands.map((cmd) => {
      const fields = (cmd.fields ?? [])
        .map((field) => `${field.name}（${field.desc}）`)
        .join('；');
      const note = cmd.note ? `${cmd.note}` : '';
      const third = [fields, note].filter(Boolean).join('；');
      return `| ${cell(cmd.code)} | ${cell(cmd.name)} | ${cell(third)} |`;
    }),
  ]);
}

/** 地址表：硬件地址、寄存器号…… */
function addressSection(spec: ProtocolSpec): string {
  const addresses = spec.addresses ?? [];
  if (!addresses.length) return '';
  return section('地址', [
    '| 地址 | 名称 | 说明 |',
    '| --- | --- | --- |',
    ...addresses.map(
      (addr) => `| ${cell(addr.code)} | ${cell(addr.name)} | ${cell(addr.note ?? '')} |`,
    ),
  ]);
}

/** 通用说明：校验方式、编码约定…… */
function notesSection(spec: ProtocolSpec): string {
  const notes = spec.notes ?? [];
  if (!notes.length) return '';
  return section('说明', notes.map((note) => `- ${cell(note)}`));
}

/**
 * 把协议详情写成一份 Markdown 文档。
 *
 * 标题是协议名（不是文件名）：文档正文里的 H1 是给人读的标题。
 * 内容为空时返回空串——没有东西就别造一份空文档。
 */
export function specMarkdown(spec: ProtocolSpec, title: string): string {
  const body = [frameSection(spec), commandSection(spec), addressSection(spec), notesSection(spec)]
    .filter(Boolean)
    .join('\n\n');
  if (!body) return '';
  return [
    `# ${title}`,
    '> 这份速查由解析插件的协议详情生成：帧结构、命令码、地址表都在这儿。',
    body,
  ].join('\n\n');
}
