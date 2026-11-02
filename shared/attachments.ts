/**
 * 附件格式的分类与判定，前后端共用。
 *
 * 放在 shared 而不是服务端，是因为前端也要用同一份判定来决定
 * 「这个文件能不能传」「上传后能不能检索」，两侧口径必须一致：
 * 前端放行、服务端拒绝，用户只会看到一个没有解释的失败。
 */

/** 附件的粗分类，用于界面上的图标与提示 */
export type AttachmentKind =
  | 'text' // 纯文本
  | 'code' // 源码
  | 'markup' // html / xml / markdown
  | 'office' // docx / pptx / xlsx
  | 'pdf'
  | 'image'
  | 'archive'
  | 'binary'; // 其余一律按二进制处理

/** 可直接按 UTF-8 读出正文的扩展名 */
const TEXT_EXTS = [
  '.txt', '.text', '.log', '.ini', '.conf', '.cfg', '.env',
  '.json', '.jsonl', '.ndjson', '.csv', '.tsv',
  '.yaml', '.yml', '.toml',
];

/** 标记类：结构接近纯文本，只是需要剥标签才可读 */
const MARKUP_EXTS = ['.md', '.markdown', '.mdx', '.html', '.htm', '.xml', '.svg', '.rst'];

/** 源码类 */
const CODE_EXTS = [
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.java', '.kt', '.go', '.rs', '.rb',
  '.php', '.c', '.h', '.cpp', '.hpp', '.cc', '.cs', '.swift', '.scala', '.sh', '.bash', '.zsh',
  '.ps1', '.bat', '.sql', '.css', '.scss', '.less', '.vue', '.svelte', '.r', '.m', '.lua',
  '.dart', '.gradle', '.dockerfile', '.makefile',
];

/** OOXML 办公文档：zip 容器，能抽出文本 */
const OFFICE_EXTS = ['.docx', '.pptx', '.xlsx', '.odt', '.odp', '.ods'];

/** 图片：只存档，不检索 */
const IMAGE_EXTS = [
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.tif', '.tiff', '.heic', '.avif',
];

/** 压缩包：只存档，不检索 */
const ARCHIVE_EXTS = ['.zip', '.tar', '.gz', '.tgz', '.bz2', '.xz', '.7z', '.rar', '.jar', '.war'];

const PDF_EXTS = ['.pdf'];

/** 取小写扩展名（含点）；无扩展名返回空串 */
export function extOf(name: string): string {
  const base = (name ?? '').split(/[\\/]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  if (dot <= 0 || dot === base.length - 1) return '';
  return base.slice(dot).toLowerCase();
}

/** 粗分类 */
export function kindOf(ext: string): AttachmentKind {
  const e = (ext ?? '').toLowerCase();
  if (OFFICE_EXTS.includes(e)) return 'office';
  if (PDF_EXTS.includes(e)) return 'pdf';
  if (IMAGE_EXTS.includes(e)) return 'image';
  if (ARCHIVE_EXTS.includes(e)) return 'archive';
  if (MARKUP_EXTS.includes(e)) return 'markup';
  if (CODE_EXTS.includes(e)) return 'code';
  if (TEXT_EXTS.includes(e)) return 'text';
  return 'binary';
}

/** 该扩展名能否抽出纯文本（决定附件能否进 RAG） */
export function isTextSearchable(ext: string): boolean {
  const e = (ext ?? '').toLowerCase();
  return (
    TEXT_EXTS.includes(e) ||
    MARKUP_EXTS.includes(e) ||
    CODE_EXTS.includes(e) ||
    OFFICE_EXTS.includes(e)
  );
}

/**
 * PDF 能否检索取决于运行环境里有没有装解析器。
 *
 * 服务端做探测（见 server/extract.ts），前端只能给出「视解析器而定」的提示。
 */
export function isPdf(ext: string): boolean {
  return (ext ?? '').toLowerCase() === '.pdf';
}

/**
 * 常见扩展名的清单，供「允许格式」设置界面下拉选择。
 *
 * 刻意不全量罗列：真实项目的格式组合千变万化，界面上给一份「常见的」，
 * 其余靠手填扩展名补齐。
 */
export const COMMON_EXTENSIONS: string[] = [
  '.md', '.txt', '.pdf', '.docx', '.xlsx', '.pptx', '.csv', '.json', '.html',
  '.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.zip',
];

/** 分类的中文名，用于界面提示 */
export const KIND_LABELS: Record<AttachmentKind, string> = {
  text: '纯文本',
  code: '源码',
  markup: '标记文本',
  office: '办公文档',
  pdf: 'PDF',
  image: '图片',
  archive: '压缩包',
  binary: '二进制',
};

/** 单文件体积的可读化显示（与服务端 utils 口径一致） */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
