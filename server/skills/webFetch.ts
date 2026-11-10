/**
 * 网页请求：把一个 URL 变成能读、能交给下游继续处理的内容。
 *
 * 为什么不让模型直接看原始响应：
 * - HTML 里大半是标签、脚本和样式，模型读了既费钱又容易把导航菜单当成正文；
 * - 接口返回可能有几百 KB，模型只需要其中几个字段。
 *
 * 所以这里做三件事：按内容类型分流、抽正文、限大小。
 * 抽出来的正文既给人看，也喂给后面的数据分析。
 */

/** 一次网页请求的参数 */
export interface WebFetchParams {
  /** 目标地址：必须是 http/https */
  url: string;
  /** 请求方法，默认 GET */
  method?: string;
  /** 请求头，JSON 对象字符串 */
  headers?: string;
  /** 请求体 */
  body?: string;
  /** 超时秒数，默认 20，上限 60 */
  timeoutSec?: number;
  /** 正文最多留多少字符，默认 20000 */
  maxChars?: number;
}

/** 一次网页请求的结果 */
export interface WebFetchResult {
  /** 请求的地址 */
  url: string;
  /** 跟随重定向后的最终地址 */
  finalUrl: string;
  status: number;
  statusText: string;
  /** 响应头里的内容类型 */
  contentType: string;
  /** 内容的形态 */
  kind: 'json' | 'html' | 'text';
  /** 页面标题（HTML 才有） */
  title?: string;
  /** 抽出来的正文 */
  text: string;
  /** 正文是否被截断过 */
  truncated: boolean;
  /** 实际读到的字节数 */
  bytes: number;
  /** JSON 内容的解析结果 */
  data?: unknown;
}

/** 单次请求最多读多少字节：超了说明不是给人看的东西 */
const MAX_BYTES = 2 * 1024 * 1024;
/** 默认正文长度上限 */
const DEFAULT_MAX_CHARS = 20000;

/** 网页请求失败：message 是给用户看的原因 */
export class WebFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebFetchError';
  }
}

/** 校验并规整地址：只放 http/https 过 */
function normalizeUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) throw new WebFetchError('请给出要请求的地址');
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new WebFetchError(`地址不合法：${trimmed}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new WebFetchError(`只支持 http/https 地址，收到的是 ${url.protocol.replace(':', '')}`);
  }
  return url.toString();
}

/** 解析请求头：写错了就说清楚是哪个键 */
function parseHeaders(raw?: string): Record<string, string> {
  if (!raw || !raw.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new WebFetchError('请求头不是合法的 JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new WebFetchError('请求头要是一个 JSON 对象，例如 {"Authorization":"Bearer xxx"}');
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (value === null || value === undefined) continue;
    if (typeof value === 'object') {
      throw new WebFetchError(`请求头 ${key} 的值得是字符串`);
    }
    out[key] = String(value);
  }
  return out;
}

/** HTML 实体：常见的几个解掉就够了 */
function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&amp;/gi, '&');
}

/**
 * HTML 正文抽取。
 *
 * 不用 DOM 解析器：服务端不装 jsdom 那种重家伙，
 * 而这里要的只是「把标签去掉、把换行留住」，正则够用。
 * 顺序有讲究：先去脚本样式（它们的内容不是正文），
 * 再把块级标签换成换行（不然整篇会糊成一行），最后才去标签。
 */
export function htmlToText(html: string): { title?: string; text: string } {
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const title = titleMatch?.[1] ? decodeEntities(titleMatch[1].replace(/<[^>]+>/g, '')).trim() : undefined;

  let body = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|noscript|svg|iframe|template)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<(br|hr)\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|section|article|header|footer|li|tr|h[1-6]|blockquote|pre)\s*>/gi, '\n')
    .replace(/<(p|div|section|article|header|footer|li|tr|h[1-6]|blockquote|pre)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');

  body = decodeEntities(body)
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return { title, text: body };
}

/** 读响应体：超过上限就停，并如实报告读了多少 */
async function readBody(res: Response, limit: number): Promise<{ buffer: Buffer; bytes: number; truncated: boolean }> {
  if (!res.body) {
    const buffer = Buffer.from(await res.arrayBuffer());
    return { buffer, bytes: buffer.byteLength, truncated: false };
  }
  const reader = res.body.getReader();
  const chunks: Buffer[] = [];
  let bytes = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    bytes += value.byteLength;
    if (bytes > limit) {
      const keep = Math.max(0, value.byteLength - (bytes - limit));
      chunks.push(Buffer.from(value.subarray(0, keep)));
      truncated = true;
      await reader.cancel().catch(() => undefined);
      break;
    }
    chunks.push(Buffer.from(value));
  }
  return { buffer: Buffer.concat(chunks), bytes, truncated };
}

/**
 * 请求一个地址并把内容整理好。
 *
 * 失败时抛 WebFetchError——错误信息是给模型看的，
 * 得让它知道是地址不对还是超时，这样它才知道下一步该换什么。
 */
export async function fetchWeb(params: WebFetchParams, signal?: AbortSignal): Promise<WebFetchResult> {
  const url = normalizeUrl(params.url);
  const method = (params.method || 'GET').toUpperCase();
  const headers = parseHeaders(params.headers);
  const timeoutMs = Math.min(Math.max(Number(params.timeoutSec) || 20, 1), 60) * 1000;
  const maxChars = Math.max(Number(params.maxChars) || DEFAULT_MAX_CHARS, 200);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort);

  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: method === 'GET' || method === 'HEAD' ? undefined : params.body || undefined,
      signal: controller.signal,
      redirect: 'follow',
    });
  } catch (err) {
    if (signal?.aborted) throw new WebFetchError('请求被中止了');
    if (controller.signal.aborted) throw new WebFetchError(`请求超时（${Math.round(timeoutMs / 1000)} 秒）`);
    throw new WebFetchError(`请求失败：${(err as Error).message}`);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }

  const contentType = (res.headers.get('content-type') || '').toLowerCase();
  const { buffer, bytes, truncated: sizeTruncated } = await readBody(res, MAX_BYTES);
  const raw = buffer.toString('utf8');

  const isJson = contentType.includes('json') || /^\s*[[{]/.test(raw);
  const isHtml = contentType.includes('html') || /^\s*<(!doctype|html)/i.test(raw);

  let kind: WebFetchResult['kind'] = 'text';
  let text = raw;
  let title: string | undefined;
  let data: unknown;

  if (isJson) {
    kind = 'json';
    try {
      data = JSON.parse(raw);
      text = JSON.stringify(data, null, 2);
    } catch {
      // 内容说是 JSON 却解析不了：按纯文本给出去，别把整段丢掉
      kind = 'text';
      text = raw;
    }
  } else if (isHtml) {
    kind = 'html';
    const extracted = htmlToText(raw);
    title = extracted.title;
    text = extracted.text;
  }

  const truncated = sizeTruncated || text.length > maxChars;
  if (text.length > maxChars) text = text.slice(0, maxChars);

  return {
    url,
    finalUrl: res.url || url,
    status: res.status,
    statusText: res.statusText,
    contentType: contentType || '未知',
    kind,
    title,
    text,
    truncated,
    bytes,
    data,
  };
}
