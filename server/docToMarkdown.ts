/**
 * 文档 → Markdown。
 *
 * 厂家给的协议文档有各种形态：PDF、Word、网页、Excel、纯文本。
 * 这一层把它们统一转成 Markdown——协议文档就该是 Markdown：
 * 能贴进任何编辑器，能被检索，能跟着代码走版本管理。
 *
 * 转换分两步：
 * 1. 拿到正文（PDF/Word 靠 server/extract.ts，网页靠抓取，文本直接读）；
 * 2. 把正文整理成 Markdown（HTML 保留标题、列表、表格这些结构，
 *    纯文本按段落切开、明显的标题行提上来）。
 *
 * 转换是有损的，所以每一步都带 warnings：
 * 哪些结构没能转过来、哪些地方要人再核一遍，必须说清楚，
 * 不能装作转好了——一份看着整齐实则丢了一半的文档，比没有更坏。
 */
import { extname } from 'node:path';
import { extractText } from './extract.ts';

/** 换行符：源码里写成常量，免得到处是转义 */
const NL = String.fromCharCode(10);
/** 制表符 */
const TAB = String.fromCharCode(9);
/** 回车 */
const CR = String.fromCharCode(13);

/** 抓网页最多读多少字节 */
const MAX_FETCH_BYTES = 8 * 1024 * 1024;
/** 抓网页超时 */
const FETCH_TIMEOUT_MS = 20000;

/** 转换入参 */
export interface ConvertDocumentInput {
  /** 上传的原始字节 */
  bytes?: Buffer;
  /** 文件名：决定按什么格式处理 */
  filename?: string;
  /** 网址：抓这个页面 */
  url?: string;
  /** 文档标题 */
  title?: string;
}

/** 转换结果 */
export interface ConvertDocumentResult {
  /** 转出来的 Markdown */
  markdown: string;
  /** 标题 */
  title: string;
  /** 走了哪条路 */
  kind: 'html' | 'csv' | 'text' | 'markdown' | 'docx' | 'pdf' | 'url';
  /** 哪里可能没转好，要人再核一遍 */
  warnings: string[];
}

/**
 * 文档转 Markdown。
 *
 * 文件与网址二选一：给了网址就抓网页，给了字节就按文件名判断格式。
 */
export async function convertDocumentToMarkdown(
  input: ConvertDocumentInput,
): Promise<ConvertDocumentResult> {
  if (input.url?.trim()) {
    return convertUrlToMarkdown(input.url.trim(), input.title);
  }

  const bytes = input.bytes;
  if (!bytes || !bytes.length) throw new Error('没有内容可转换');
  const filename = input.filename?.trim() || 'document.txt';
  const ext = extname(filename).toLowerCase();

  if (ext === '.html' || ext === '.htm' || ext === '.xhtml') {
    const { markdown, warnings, pageTitle } = htmlToMarkdown(bytes.toString('utf8'));
    // 网页自己的 <title> 就是文档名，比「文档」这个占位词有用
    return {
      markdown,
      title: input.title?.trim() || pageTitle || '文档',
      kind: 'html',
      warnings,
    };
  }

  if (ext === '.md' || ext === '.markdown') {
    const markdown = tidyMarkdown(bytes.toString('utf8'));
    return { markdown, title: input.title?.trim() || '文档', kind: 'markdown', warnings: [] };
  }

  if (ext === '.csv' || ext === '.tsv') {
    const delimiter = ext === '.tsv' ? TAB : ',';
    const markdown = csvToMarkdown(bytes.toString('utf8'), delimiter);
    return { markdown, title: input.title?.trim() || '文档', kind: 'csv', warnings: [] };
  }

  if (ext === '.txt' || ext === '.text' || ext === '.log') {
    const markdown = textToMarkdown(bytes.toString('utf8'));
    return { markdown, title: input.title?.trim() || '文档', kind: 'text', warnings: [] };
  }

  if (ext === '.docx' || ext === '.odt' || ext === '.xlsx' || ext === '.pptx' || ext === '.odp') {
    const extracted = await extractText(bytes, filename);
    if (extracted.status !== 'ok' || !extracted.text.trim()) {
      throw new Error('这份文档里没抽到文字，先在电脑上另存为 Word 或纯文本再导入');
    }
    const markdown = textToMarkdown(extracted.text);
    return {
      markdown,
      title: input.title?.trim() || '文档',
      kind: 'docx',
      warnings: ['Word/表格里的排版和图片没有转成 Markdown 结构，字段顺序需要再核一遍'],
    };
  }

  if (ext === '.pdf') {
    const extracted = await extractText(bytes, filename);
    if (extracted.status === 'unsupported') {
      throw new Error(
        '这个 PDF 抽不出文字（可能是扫描件或缺 PDF 解析器）：先在电脑上另存为 Word 或纯文本再导入',
      );
    }
    if (extracted.status !== 'ok' || !extracted.text.trim()) {
      throw new Error('这个 PDF 里没抽到文字，先在电脑上另存为 Word 或纯文本再导入');
    }
    const markdown = textToMarkdown(extracted.text);
    return {
      markdown,
      title: input.title?.trim() || '文档',
      kind: 'pdf',
      warnings: ['PDF 抽的是纯文本，跨页的表格和图可能错位，字段顺序需要再核一遍'],
    };
  }

  // 不认识的格式：先当 UTF-8 文本处理，至少别把内容弄丢
  const markdown = textToMarkdown(bytes.toString('utf8'));
  return {
    markdown,
    title: input.title?.trim() || '文档',
    kind: 'text',
    warnings: [`不认识的格式（${ext || '无扩展名'}），按纯文本处理了`],
  };
}

/** 抓网页转 Markdown */
async function convertUrlToMarkdown(
  rawUrl: string,
  title?: string,
): Promise<ConvertDocumentResult> {
  const url = normalizeHttpUrl(rawUrl);
  const res = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`抓取失败：HTTP ${res.status} ${res.statusText}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length > MAX_FETCH_BYTES) throw new Error('这个页面太大了，转不下');

  const contentType = (res.headers.get('content-type') || '').toLowerCase();
  const raw = buffer.toString('utf8');

  if (contentType.includes('json')) {
    return {
      markdown: '```json\n' + raw + '\n```',
      title: title?.trim() || '文档',
      kind: 'url',
      warnings: ['这是一个 JSON 接口，按代码块原样存下来了'],
    };
  }

  const isHtml = contentType.includes('html') || /^\s*<(!doctype|html)/i.test(raw);
  if (isHtml) {
    const { markdown, warnings, pageTitle } = htmlToMarkdown(raw);
    return {
      markdown,
      title: title?.trim() || pageTitle || '文档',
      kind: 'url',
      warnings,
    };
  }

  return {
    markdown: textToMarkdown(raw),
    title: title?.trim() || '文档',
    kind: 'url',
    warnings: [],
  };
}

/** 只放行 http/https */
function normalizeHttpUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error('请给出要抓取的地址');
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(`地址不合法：${trimmed}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`只支持 http/https 地址，收到的是 ${url.protocol.replace(':', '')}`);
  }
  return url.toString();
}

/** HTML 实体：常见的几个解掉就够了 */
function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&amp;/gi, '&')
    .replace(/&#(\d+);/g, (_m, code: string) => String.fromCharCode(Number(code)));
}

/** 去标签，留文本 */
function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, '');
}

/** 折叠空白：一行里连续的空格、换行都压成一个空格 */
function collapse(text: string): string {
  return text.replace(/[ \t\r\n]+/g, ' ').trim();
}

/** HTML → Markdown */
export function htmlToMarkdown(html: string): {
  markdown: string;
  warnings: string[];
  pageTitle?: string;
} {
  const warnings: string[] = [];

  // 页面标题
  const titleMatch = /<title[^>]*>([^]*?)<\/title>/i.exec(html);
  const pageTitle = titleMatch ? collapse(decodeEntities(stripTags(titleMatch[1]))) : undefined;

  // 去掉不是正文的东西
  let body = html
    .replace(/<!--[^]*?-->/g, '')
    // doctype 不是标签，正则扫不到它，得单独去掉，不然会混进正文第一行
    .replace(/<!doctype[^>]*>/gi, ' ')
    .replace(/<(script|style|noscript|svg|iframe|template|head)(?:\s[^>]*)?>[^]*?<\/\1>/gi, ' ')
    .replace(/<(script|style|noscript|svg|iframe|template|head)(?:\s[^>]*)?>/gi, ' ');

  // 表格与代码块先摘出来：这两块的结构靠流式扫描还原不了
  const chunks: string[] = [];
  const placeholder = (index: number): string => ` ${'%%MDCHUNK' + index + '%%'} `;
  body = body.replace(/<table(?:\s[^>]*)?>[^]*?<\/table>/gi, (match) => {
    const table = tableToMarkdown(match);
    if (!table) {
      warnings.push('有一张表没能转成 Markdown 表格');
      return ' ';
    }
    chunks.push(table);
    return placeholder(chunks.length - 1);
  });
  body = body.replace(/<pre(?:\s[^>]*)?>([^]*?)<\/pre>/gi, (_match, code: string) => {
    chunks.push('```' + NL + decodeEntities(stripTags(code)).replace(/[\r\n]+$/, '') + NL + '```');
    return placeholder(chunks.length - 1);
  });

  // 剩下的按标签流式扫一遍
  const blocks: { text: string; list: boolean }[] = [];
  let buf = '';
  let heading = 0;
  let strong = 0;
  let em = 0;
  let code = 0;
  let quote = 0;
  const listStack: { ordered: boolean; count: number }[] = [];
  let linkHref: string | null = null;
  let linkStart = -1;

  const flush = (isList = false): void => {
    const text = buf.trim();
    buf = '';
    if (!text) return;
    blocks.push({ text: quote > 0 ? text.split(NL).map((line) => `> ${line}`).join(NL) : text, list: isList });
  };

  const appendText = (raw: string): void => {
    if (!raw) return;
    let text = decodeEntities(raw);
    if (!text.trim() && !buf.trim()) return;
    if (code > 0) text = '`' + text + '`';
    if (em > 0) text = '*' + text + '*';
    if (strong > 0) text = '**' + text + '**';
    buf += text;
    if (linkHref === null) linkStart = buf.length;
  };

  const tagRe = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:\s[^>]*?)?)(\/?)>/g;
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = tagRe.exec(body))) {
    appendText(body.slice(last, match.index));
    last = tagRe.lastIndex;

    const closing = match[1] === '/';
    const tag = match[2].toLowerCase();
    const attrs = match[3] || '';

    if (tag === 'br') {
      buf += NL;
      continue;
    }
    if (tag === 'hr') {
      flush();
      blocks.push({ text: '---', list: false });
      continue;
    }

    if (/^h[1-6]$/.test(tag)) {
      if (closing) {
        flush();
        heading = 0;
      } else {
        flush();
        heading = Number(tag.slice(1));
        buf += '#'.repeat(heading) + ' ';
      }
      continue;
    }

    if (tag === 'p' || tag === 'div' || tag === 'section' || tag === 'article' ||
        tag === 'header' || tag === 'footer' || tag === 'main' || tag === 'aside' ||
        tag === 'figure' || tag === 'figcaption' || tag === 'form' || tag === 'dl' ||
        tag === 'dt' || tag === 'dd') {
      flush();
      continue;
    }

    if (tag === 'ul' || tag === 'ol') {
      if (closing) {
        listStack.pop();
        flush();
      } else {
        flush();
        listStack.push({ ordered: tag === 'ol', count: 0 });
      }
      continue;
    }

    if (tag === 'li') {
      if (closing) {
        flush(true);
      } else {
        flush();
        const level = listStack.length ? listStack[listStack.length - 1] : undefined;
        const indent = '  '.repeat(Math.max(0, listStack.length - 1));
        if (level?.ordered) {
          level.count += 1;
          buf += `${indent}${level.count}. `;
        } else {
          buf += `${indent}- `;
        }
      }
      continue;
    }

    if (tag === 'blockquote') {
      if (closing) {
        quote = Math.max(0, quote - 1);
        flush();
      } else {
        flush();
        quote += 1;
      }
      continue;
    }

    if (tag === 'strong' || tag === 'b') {
      if (closing) strong = Math.max(0, strong - 1);
      else strong += 1;
      continue;
    }
    if (tag === 'em' || tag === 'i') {
      if (closing) em = Math.max(0, em - 1);
      else em += 1;
      continue;
    }
    if (tag === 'code' || tag === 'kbd' || tag === 'samp') {
      if (closing) code = Math.max(0, code - 1);
      else code += 1;
      continue;
    }

    if (tag === 'a') {
      if (closing) {
        if (linkHref !== null && linkStart >= 0) {
          const label = buf.slice(linkStart);
          buf = buf.slice(0, linkStart) + `[${label}](${linkHref})`;
        }
        linkHref = null;
        linkStart = -1;
      } else {
        const href = /href\s*=\s*["']([^"']*)["']/i.exec(attrs);
        linkHref = href ? href[1] : '';
        linkStart = buf.length;
      }
      continue;
    }

    // td/th/tr 属于表格（已单独处理），其余标签直接忽略
  }
  appendText(body.slice(last));
  flush();

  // 拼回去：列表项之间用单换行，其余用空行
  let markdown = '';
  let previousList = false;
  for (const block of blocks) {
    if (!markdown) {
      markdown = block.text;
    } else {
      markdown += (block.list && previousList ? NL : NL + NL) + block.text;
    }
    previousList = block.list;
  }

  // 把表格、代码块放回原位
  markdown = markdown.replace(/%%MDCHUNK(\d+)%%/g, (_m, index: string) => {
    const chunk = chunks[Number(index)];
    return chunk === undefined ? '' : chunk;
  });

  if (/<img\b/i.test(html)) warnings.push('文档里的图片没有转过来，Markdown 里只留了位置');

  return { markdown: tidyMarkdown(markdown), warnings, pageTitle };
}

/** 一段 HTML 表格 → Markdown 表格 */
function tableToMarkdown(html: string): string {
  const rows: string[][] = [];
  const rowRe = /<tr(?:\s[^>]*)?>([^]*?)<\/tr>/gi;
  let rowMatch: RegExpExecArray | null;
  while ((rowMatch = rowRe.exec(html))) {
    const cells: string[] = [];
    const cellRe = /<(t[dh])(?:\s[^>]*)?>([^]*?)<\/\1>/gi;
    let cellMatch: RegExpExecArray | null;
    while ((cellMatch = cellRe.exec(rowMatch[1]))) {
      cells.push(collapse(decodeEntities(stripTags(cellMatch[2]))));
    }
    if (cells.length) rows.push(cells);
  }
  if (!rows.length) return '';

  const width = rows.reduce((max, row) => Math.max(max, row.length), 0);
  const line = (cells: string[]): string =>
    `| ${Array.from({ length: width }, (_, i) => cells[i] ?? '').join(' | ')} |`;

  const lines = [line(rows[0]), `| ${Array.from({ length: width }, () => '---').join(' | ')} |`];
  for (const row of rows.slice(1)) lines.push(line(row));
  return lines.join(NL);
}

/** CSV/TSV → Markdown 表格 */
export function csvToMarkdown(text: string, delimiter = ','): string {
  const rows = parseDelimited(text, delimiter);
  if (!rows.length) return '';
  const width = rows.reduce((max, row) => Math.max(max, row.length), 0);
  const line = (cells: string[]): string =>
    `| ${Array.from({ length: width }, (_, i) => cells[i] ?? '').join(' | ')} |`;

  const lines = [line(rows[0]), `| ${Array.from({ length: width }, () => '---').join(' | ')} |`];
  for (const row of rows.slice(1)) lines.push(line(row));
  return lines.join(NL);
}

/** 解析带引号的分隔文本 */
function parseDelimited(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"') {
      quoted = true;
      continue;
   
    }
    if (ch === delimiter) {
      row.push(cell);
      cell = '';
      continue;
    }
    if (ch === CR) continue;
    if (ch === NL) {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      continue;
    }
    cell += ch;
  }
  if (cell.length || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

/**
 * 纯文本 → Markdown。
 *
 * 厂家文档里大量是「一、帧结构」这样的行，把它提上来当标题，
 * 整篇才有骨架；剩下的按空行分段。
 */
export function textToMarkdown(text: string): string {
  const normalized = text.replace(/\r\n?/g, NL).replace(/\u00a0/g, ' ');
  const blocks = normalized.split(/\n{2,}/);
  const out: string[] = [];

  for (const block of blocks) {
    const lines = block.split(NL).map((line) => line.replace(/[ \t]+$/, ''));
    while (lines.length && !lines[0].trim()) lines.shift();
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    if (!lines.length) continue;

    const single = lines.length === 1 ? lines[0].trim() : '';
    const looksLikeHeading =
      single.length > 0 &&
      single.length <= 40 &&
      /^(#{1,6}\s+|[一二三四五六七八九十]+[、.．]|[0-9]+[、.．)）]|第[一二三四五六七八九十百]+[章节部分])/.test(
        single,
      );
    if (looksLikeHeading) {
      out.push('## ' + single.replace(/^#{1,6}\s+/, ''));
      continue;
    }
    out.push(lines.join(NL));
  }

  return tidyMarkdown(out.join(NL + NL));
}

/** 收拾一下 Markdown：去 BOM、压掉多余空行 */
export function tidyMarkdown(markdown: string): string {
  return markdown
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, NL)
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, NL + NL)
    .trim();
}