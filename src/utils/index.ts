// 文件大小格式化
export function formatBytes(bytes?: number): string {
  if (bytes === undefined || bytes === null) return '-';
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// 时间格式化
export function formatRelativeTime(timestamp: number): string {
  const now = Date.now();
  const diff = now - timestamp;
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (seconds < 60) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  if (hours < 24) return `${hours} 小时前`;
  if (days < 7) return `${days} 天前`;
  if (days < 30) return `${Math.floor(days / 7)} 周前`;
  if (days < 365) return `${Math.floor(days / 30)} 个月前`;
  return `${Math.floor(days / 365)} 年前`;
}

import { marked } from 'marked';

/** 文档大纲条目 */
export interface DocHeading {
  /** 标题层级，1~6 */
  depth: number;
  /** 已剥离行内标记的纯文本，可直接渲染 */
  text: string;
  /** 标题在源码中的起始行号（1 起），编辑态按行跳转用 */
  line: number;
}

/**
 * 从 Markdown 提取标题层级，供文档目录使用。
 *
 * 走 marked.lexer 而不用正则 /^#{1,6}\s/：正则扫全文时分不清代码块内外，
 * 文档里任何一处 `#!/bin/bash`、`# 安装依赖`、YAML 的 `#` 注释都会被算成
 * 一级标题，目录当场失真。lexer 是词法分析，能正确跳过代码块。
 *
 * 顺序一致性是这里的关键：lexer 产出的 heading 顺序，与 MarkdownPreview
 * 渲染出的 <h1>~<h6> 在 DOM 中的顺序完全一致。目录点击时据此用
 * 「第 n 个标题节点」定位，因此不必往 HTML 里注入 id。
 */
export function extractHeadings(source: string): DocHeading[] {
  if (!source) return [];
  let tokens;
  try {
    tokens = marked.lexer(source);
  } catch {
    return []; // 半截语法不能连累整个文档渲染
  }
  const out: DocHeading[] = [];
  // 逐个 token 累加它占掉的换行数，就得到每个标题在源码里的起始行号。
  // token.raw 是该 token 在原文里占的那一段（含尾部换行），所有 raw 加起来
  // 正好是原文全长，因此行号不会漂。编辑态点目录要按行跳回源码，靠的就是它。
  let line = 1;
  for (const tok of tokens) {
    if (tok.type === 'heading') {
      out.push({ depth: tok.depth, text: stripInlineMarks(tok.text), line });
    }
    for (let i = 0; i < tok.raw.length; i++) {
      if (tok.raw.charCodeAt(i) === 10) line++;
    }
  }
  return out;
}

/**
 * 剥掉标题里的行内标记，留下可直接显示的纯文本。
 *
 * 用 parseInline 而非正则去符号：MarkdownPreview 给 marked 装了自定义扩展
 * （^上标^ 与 ~下标~），正则剥不干净。正文与目录用同一套解析规则，
 * 目录里的文案才和正文渲染出来的一致。
 */
function stripInlineMarks(text: string): string {
  try {
    const html = marked.parseInline(text, { async: false }) as string;
    return html.replace(/<[^>]*>/g, '').trim();
  } catch {
    return text.trim();
  }
}

// 下载文件
export function downloadAsFile(filename: string, content: string) {
  const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename.endsWith('.md') ? filename : `${filename}.md`;
  document.body.appendChild(a);
  a.click();
  // 先把点击发出去再摘掉临时节点：同步摘掉有可能让浏览器把这笔下载当成取消
  setTimeout(() => {
    a.remove();
    URL.revokeObjectURL(url);
  }, 0);
}

/**
 * 把服务端回传的字节存成文件。
 *
 * 原件下载走它：字节是原样回来的，文件名也得是原样落地的
 * （不是 .md 就不擅自加后缀——那个 .md 是笔记导出才有的规矩）。
 */
export function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  // 同 downloadAsFile：点击发出去之后再摘节点，别在同一步里把下载取消掉
  setTimeout(() => {
    a.remove();
    URL.revokeObjectURL(url);
  }, 0);
}

// 防抖
export function debounce<T extends (...args: unknown[]) => void>(fn: T, delay: number) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return (...args: Parameters<T>) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}
