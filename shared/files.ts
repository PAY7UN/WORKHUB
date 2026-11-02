/**
 * 「原件」语义：任意格式的文件本身。
 *
 * 放在 shared 是因为两侧必须对同一个问题给出同一个答案：
 * 这个文件是什么 MIME？能不能内联预览？下载回来该叫什么名字？
 * 前端说是图片、后端说是二进制，两边就会各做各的，最后谁也说不清
 * 那个 zip 到底是「压缩包」还是「二进制」。
 *
 * 关键立场：**文件不需要配一份 Markdown 备注**。
 * 上传一个 zip，树上就该出现这个 zip 本身，而不是一篇叫「xxx.zip」
 * 的空笔记再外挂一个附件——那是在给一个自解释的东西强行加注释。
 */
import { extOf, kindOf } from './attachments.ts';

/** 常见扩展名 → MIME */
const MIME_BY_EXT: Record<string, string> = {
  // 文本与标记
  '.md': 'text/markdown; charset=utf-8',
  '.markdown': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.text': 'text/plain; charset=utf-8',
  '.log': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.tsv': 'text/tab-separated-values; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jsonl': 'application/x-ndjson; charset=utf-8',
  '.ndjson': 'application/x-ndjson; charset=utf-8',
  '.yaml': 'text/yaml; charset=utf-8',
  '.yml': 'text/yaml; charset=utf-8',
  '.toml': 'text/plain; charset=utf-8',
  '.ini': 'text/plain; charset=utf-8',
  '.conf': 'text/plain; charset=utf-8',
  '.cfg': 'text/plain; charset=utf-8',
  '.env': 'text/plain; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.rst': 'text/plain; charset=utf-8',
  // 源码
  '.ts': 'text/plain; charset=utf-8',
  '.tsx': 'text/plain; charset=utf-8',
  '.js': 'text/plain; charset=utf-8',
  '.jsx': 'text/plain; charset=utf-8',
  '.mjs': 'text/plain; charset=utf-8',
  '.cjs': 'text/plain; charset=utf-8',
  '.py': 'text/plain; charset=utf-8',
  '.java': 'text/plain; charset=utf-8',
  '.kt': 'text/plain; charset=utf-8',
  '.go': 'text/plain; charset=utf-8',
  '.rs': 'text/plain; charset=utf-8',
  '.rb': 'text/plain; charset=utf-8',
  '.php': 'text/plain; charset=utf-8',
  '.c': 'text/plain; charset=utf-8',
  '.h': 'text/plain; charset=utf-8',
  '.cpp': 'text/plain; charset=utf-8',
  '.hpp': 'text/plain; charset=utf-8',
  '.cs': 'text/plain; charset=utf-8',
  '.swift': 'text/plain; charset=utf-8',
  '.scala': 'text/plain; charset=utf-8',
  '.sh': 'text/plain; charset=utf-8',
  '.bash': 'text/plain; charset=utf-8',
  '.zsh': 'text/plain; charset=utf-8',
  '.ps1': 'text/plain; charset=utf-8',
  '.bat': 'text/plain; charset=utf-8',
  '.sql': 'text/plain; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.scss': 'text/plain; charset=utf-8',
  '.less': 'text/plain; charset=utf-8',
  '.vue': 'text/plain; charset=utf-8',
  '.svelte': 'text/plain; charset=utf-8',
  '.r': 'text/plain; charset=utf-8',
  '.m': 'text/plain; charset=utf-8',
  '.lua': 'text/plain; charset=utf-8',
  '.dart': 'text/plain; charset=utf-8',
  '.gradle': 'text/plain; charset=utf-8',
  // 图片
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.heic': 'image/heic',
  '.avif': 'image/avif',
  // 文档
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.odt': 'application/vnd.oasis.opendocument.text',
  '.odp': 'application/vnd.oasis.opendocument.presentation',
  '.ods': 'application/vnd.oasis.opendocument.spreadsheet',
  // 压缩包
  '.zip': 'application/zip',
  '.tar': 'application/x-tar',
  '.gz': 'application/gzip',
  '.tgz': 'application/gzip',
  '.bz2': 'application/x-bzip2',
  '.xz': 'application/x-xz',
  '.7z': 'application/x-7z-compressed',
  '.rar': 'application/vnd.rar',
  '.jar': 'application/java-archive',
  '.war': 'application/java-archive',
};

/** 兜底 MIME */
export const DEFAULT_FILE_MIME = 'application/octet-stream';

/**
 * 猜一个文件的 MIME。
 *
 * 优先用扩展名表，其次用调用方给的 MIME，最后兜底 octet-stream。
 * 顺序不能反：浏览器给的 `application/octet-stream` 往往是「我不知道」，
 * 而扩展名表里往往有更准确的答案。
 */
export function guessMime(filename: string, provided?: string): string {
  const ext = extOf(filename);
  const fromExt = MIME_BY_EXT[ext];
  if (fromExt) return fromExt;
  const given = (provided ?? '').trim();
  if (given && given !== DEFAULT_FILE_MIME && given !== 'application/octet-stream') {
    return given;
  }
  return DEFAULT_FILE_MIME;
}

/** 该扩展名能否用 <img> 直接内联预览 */
export function isInlineImage(ext: string): boolean {
  const e = (ext ?? '').toLowerCase();
  return e === '.png' || e === '.jpg' || e === '.jpeg' || e === '.gif' || e === '.webp' || e === '.bmp' || e === '.svg';
}

/** 该扩展名能否用内置 PDF 阅读器内联预览 */
export function isInlinePdf(ext: string): boolean {
  return (ext ?? '').toLowerCase() === '.pdf';
}

/**
 * 该扩展名能否按文本读出来预览。
 *
 * 与附件那条链路（isTextSearchable）不是一回事：那边问的是
 * 「能不能抽文本进检索」，这边问的是「能不能直接读出来给人看」，
 * 所以办公文档（docx 是 zip 容器）在这里不算。
 */
export function isInlineText(ext: string): boolean {
  const k = kindOf(ext);
  // markup（md / html / xml / rst）也算：它们同样是 UTF-8 文本，
  // 只是「抽纯文本进检索」那一步需要剥标签。
  // 「直接读出来给人看」并不要求剥——原样呈现反而更贴近原件。
  // （svg 也归 markup，但它是图片，previewModeOf 里图片优先。）
  return k === 'text' || k === 'code' || k === 'markup';
}

/** 原件在界面上的形态分类 */
export type FilePreviewMode = 'image' | 'pdf' | 'text' | 'generic';

/**
 * 决定一个原件该怎么预览。
 *
 * 分档而不是「一律当二进制」：能看的就直接看，
 * 不能看的给一张说清是什么、多大、怎么下载的卡片，
 * 而不是丢一个打不开的图标让用户猜。
 */
export function previewModeOf(ext: string): FilePreviewMode {
  if (isInlineImage(ext)) return 'image';
  if (isInlinePdf(ext)) return 'pdf';
  if (isInlineText(ext)) return 'text';
  return 'generic';
}

/** 原件形态的中文名，用于界面标签 */
export const FILE_PREVIEW_LABELS: Record<FilePreviewMode, string> = {
  image: '图片',
  pdf: 'PDF',
  text: '文本',
  generic: '文件',
};

