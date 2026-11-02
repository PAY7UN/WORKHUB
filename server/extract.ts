/**
 * 从附件二进制里抽出纯文本，供 RAG 检索使用。
 *
 * 附件「存下来」与「能检索」是两件事：
 * - 存的门槛很低：任何格式的字节都能落盘；
 * - 检索的门槛高一些：要能把字节还原成模型读得懂的文字。
 *
 * 这里覆盖三类：
 * 1. 纯文本与源码——直接按 UTF-8 解码，最省事也最可靠；
 * 2. OOXML 办公文档（docx/pptx/xlsx/odt…）——它们是 zip 容器，
 *    自带一个最小 zip 读取器即可解出正文，不引入第三方依赖；
 * 3. PDF——能否抽文本取决于运行环境里有没有解析器。
 *    没装 pdfjs-dist 时标记为「不可检索」而不是报错：
 *    附件照存不误，只是暂时进不了检索范围。
 */
import { inflateRawSync } from 'node:zlib';
import { extOf } from '../shared/attachments.ts';
import type { AttachmentTextStatus } from '../shared/types.ts';

/** 抽出的文本最多留这么多字符。多于它的部分对检索没有增量价值，只会撑大数据库。 */
export const MAX_EXTRACTED_CHARS = 200_000;

/* ------------------------------ zip 最小实现 ------------------------------ */

interface ZipEntry {
  name: string;
  method: number;
  compSize: number;
  uncompSize: number;
  localOffset: number;
}

const EOCD_SIG = 0x06054b50;
const CD_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

/**
 * 读 zip 的中央目录。
 *
 * 只解析「尾部 EOCD → 中央目录 → 本地头」这条固定路径，
 * 不处理 zip64 与加密压缩包——办公文档用不到那些，
 * 真遇到时返回空表，上层按「抽不出文本」处理，不至于崩掉。
 */
function readZipEntries(buf: Buffer): ZipEntry[] {
  // EOCD 可能在尾部有注释，长度最多 65535 字节，从后往前找签名
  let eocd = -1;
  const minPos = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= minPos; i -= 1) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return [];

  const total = buf.readUInt16LE(eocd + 10);
  let ptr = buf.readUInt32LE(eocd + 16);
  const entries: ZipEntry[] = [];

  for (let i = 0; i < total; i += 1) {
    if (ptr + 46 > buf.length || buf.readUInt32LE(ptr) !== CD_SIG) break;
    const method = buf.readUInt16LE(ptr + 10);
    const compSize = buf.readUInt32LE(ptr + 20);
    const uncompSize = buf.readUInt32LE(ptr + 24);
    const nameLen = buf.readUInt16LE(ptr + 28);
    const extraLen = buf.readUInt16LE(ptr + 30);
    const commentLen = buf.readUInt16LE(ptr + 32);
    const localOffset = buf.readUInt32LE(ptr + 42);
    const name = buf.toString('utf8', ptr + 46, ptr + 46 + nameLen);
    entries.push({ name, method, compSize, uncompSize, localOffset });
    ptr += 46 + nameLen + extraLen + commentLen;
  }

  return entries;
}

/** 读出某个 zip 条目的内容 */
function readZipEntry(buf: Buffer, entry: ZipEntry): Buffer | null {
  const off = entry.localOffset;
  if (off + 30 > buf.length || buf.readUInt32LE(off) !== LOCAL_SIG) return null;
  const nameLen = buf.readUInt16LE(off + 26);
  const extraLen = buf.readUInt16LE(off + 28);
  const start = off + 30 + nameLen + extraLen;
  const end = start + entry.compSize;
  if (end > buf.length) return null;
  const raw = buf.subarray(start, end);
  try {
    if (entry.method === 0) return Buffer.from(raw);
    if (entry.method === 8) return inflateRawSync(raw);
    return null;
  } catch {
    return null;
  }
}

/* ------------------------------ XML 转纯文本 ------------------------------ */

const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
  '&#39;': "'",
  '&nbsp;': ' ',
};

/** 把 XML 片段转成可读纯文本：保留段落换行，剥掉所有标签 */
function xmlToText(xml: string): string {
  return (
    xml
      // 段落与换行标签转成换行，避免整篇挤成一行
      .replace(/<\/(w:p|a:p|text:p|si|p|row)\s*>/g, '\n')
      .replace(/<w:br\s*\/?>/g, '\n')
      .replace(/<a:br\s*\/?>/g, '\n')
      .replace(/<text:line-break\s*\/?>/g, '\n')
      // 其余标签连同属性一起去掉
      .replace(/<[^>]+>/g, '')
      .replace(/&(amp|lt|gt|quot|apos|nbsp|#39);/g, (m) => ENTITIES[m] ?? m)
      .replace(/\r/g, '')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  );
}

/* ------------------------------ OOXML 抽取 ------------------------------ */

/**
 * 从 OOXML 容器里抽出文本。
 *
 * docx 看 word/document.xml；pptx 看 ppt/slides/slideN.xml；
 * xlsx 看 xl/sharedStrings.xml（数值单元格没有语义，不取）；
 * odt/odp/ods 看 content.xml。
 */
function extractFromZip(buf: Buffer, ext: string): string {
  const entries = readZipEntries(buf);
  if (entries.length === 0) return '';

  const wanted: string[] = [];
  if (ext === '.docx') {
    wanted.push('word/document.xml');
  } else if (ext === '.pptx') {
    entries
      .filter((e) => /^ppt\/slides\/slide\d+\.xml$/.test(e.name))
      .sort((a, b) => a.name.localeCompare(b.name))
      .forEach((e) => wanted.push(e.name));
  } else if (ext === '.xlsx') {
    wanted.push('xl/sharedStrings.xml');
  } else {
    // odt / odp / ods 统一看 content.xml
    wanted.push('content.xml');
  }

  const parts: string[] = [];
  for (const name of wanted) {
    const entry = entries.find((e) => e.name === name);
    if (!entry) continue;
    const data = readZipEntry(buf, entry);
    if (!data) continue;
    const text = xmlToText(data.toString('utf8'));
    if (text) parts.push(text);
  }
  return parts.join('\n\n').trim();
}

/* ------------------------------ PDF 抽取 ------------------------------ */

/** pdfjs-dist 里一页里最小可用到的部分 */
interface PDFDoc {
  numPages: number;
  getPage: (n: number) => Promise<{ getTextContent: () => Promise<{ items: unknown[] }> }>;
}

/**
 * PDF 解析器是否可用。
 *
 * 用运行期探测而不是编译期 import：项目不强制装这个依赖，
 * 没装时附件照存，只是标记为不可检索；装了就自动启用，无需改代码。
 */
let pdfParser: { extract: (buf: Buffer) => Promise<string> } | null | undefined;

async function getPdfParser() {
  if (pdfParser !== undefined) return pdfParser;
  try {
    const specifier = 'pdfjs-dist/legacy/build/pdf.mjs';
    const mod = (await import(specifier)) as {
      getDocument?: (src: { data: Uint8Array }) => { promise: Promise<PDFDoc> };
    };
    if (typeof mod?.getDocument !== 'function') {
      pdfParser = null;
      return pdfParser;
    }
    const getDocument = mod.getDocument;
    pdfParser = {
      extract: async (buf: Buffer) => {
        const doc = await getDocument({ data: new Uint8Array(buf) }).promise;
        const chunks: string[] = [];
        for (let i = 1; i <= doc.numPages; i += 1) {
          const page = await doc.getPage(i);
          const content = await page.getTextContent();
          chunks.push(
            content.items
              .map((it) => ('str' in (it as { str?: string }) ? (it as { str: string }).str : ''))
              .join(' ')
              .trim(),
          );
        }
        return chunks.join('\n\n');
      },
    };
  } catch {
    pdfParser = null;
  }
  return pdfParser;
}

/* ------------------------------ 对外接口 ------------------------------ */

export interface ExtractResult {
  status: AttachmentTextStatus;
  text: string;
}

/** 可直接按 UTF-8 读出正文的扩展名 */
const TEXT_EXTS = new Set([
  '.txt', '.text', '.log', '.ini', '.conf', '.cfg', '.env', '.json', '.jsonl', '.ndjson',
  '.csv', '.tsv', '.yaml', '.yml', '.toml', '.md', '.markdown', '.mdx', '.html', '.htm',
  '.xml', '.svg', '.rst', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.java',
  '.kt', '.go', '.rs', '.rb', '.php', '.c', '.h', '.cpp', '.hpp', '.cc', '.cs', '.swift',
  '.scala', '.sh', '.bash', '.zsh', '.ps1', '.bat', '.sql', '.css', '.scss', '.less',
  '.vue', '.svelte', '.r', '.m', '.lua', '.dart', '.gradle', '.dockerfile', '.makefile',
]);

/**
 * 抽取附件正文。
 *
 * 抽不出文本不报错，只如实标记状态——附件的价值首先在「留存」，
 * 检索是加分项，不能因为抽不出文本就判定上传失败。
 */
export async function extractText(buf: Buffer, filename: string): Promise<ExtractResult> {
  const ext = extOf(filename);

  try {
    if (TEXT_EXTS.has(ext)) {
      const text = buf.toString('utf8');
      return { status: 'ok', text: text.slice(0, MAX_EXTRACTED_CHARS) };
    }

    if (['.docx', '.pptx', '.xlsx', '.odt', '.odp', '.ods'].includes(ext)) {
      const text = extractFromZip(buf, ext);
      return text ? { status: 'ok', text: text.slice(0, MAX_EXTRACTED_CHARS) } : { status: 'failed', text: '' };
    }

    if (ext === '.pdf') {
      const parser = await getPdfParser();
      if (!parser) return { status: 'unsupported', text: '' };
      const text = await parser.extract(buf);
      return text ? { status: 'ok', text: text.slice(0, MAX_EXTRACTED_CHARS) } : { status: 'failed', text: '' };
    }

    return { status: 'unsupported', text: '' };
  } catch {
    return { status: 'failed', text: '' };
  }
}
