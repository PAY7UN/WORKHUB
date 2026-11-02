import {
  Archive,
  Braces,
  File,
  FileAudio,
  FileCode,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileVideo,
  type LucideIcon,
} from 'lucide-react';
import { extOf } from '../../../shared/attachments';
import { cn } from '@/lib/utils';

interface FileTypeIconProps {
  /** 文件名或节点名 */
  name: string;
  /** 已知扩展名优先用它（节点上存着原件的真实扩展名） */
  ext?: string;
  className?: string;
  /**
   * 不着色，只给形状。
   *
   * 用在彩色底块上时，颜色由底块决定（深底配深色图标会糊成一团），
   * 这时只要形状区分得出来就够了。
   */
  plain?: boolean;
}

/**
 * 按格式挑图标。
 *
 * 为什么要看扩展名而不是一律用「文档」图标：
 * 文件树的图标是扫一眼就知道的信息，一排全是同一个蓝色文件形，
 * 人就分不出哪个是 zip、哪个是图片。图标在这里承担的是「分类」，
 * 不只是「它是个文件」。
 */
export function FileTypeIcon({ name, ext, className, plain = false }: FileTypeIconProps) {
  const e = (ext ?? extOf(name) ?? '').toLowerCase();
  const cls = cn('h-4 w-4 shrink-0', className);
  const spec = iconSpecOf(e);
  const Icon = spec.icon;
  return <Icon className={cn(cls, plain ? '' : spec.color)} />;
}

interface IconSpec {
  icon: LucideIcon;
  color: string;
}

function iconSpecOf(e: string): IconSpec {
  if (ARCHIVE_EXT.has(e)) return { icon: Archive, color: 'text-amber-500' };
  if (IMAGE_EXT.has(e)) return { icon: FileImage, color: 'text-emerald-500' };
  if (SPREADSHEET_EXT.has(e)) return { icon: FileSpreadsheet, color: 'text-green-600' };
  if (JSON_EXT.has(e)) return { icon: Braces, color: 'text-yellow-600' };
  if (VIDEO_EXT.has(e)) return { icon: FileVideo, color: 'text-purple-500' };
  if (AUDIO_EXT.has(e)) return { icon: FileAudio, color: 'text-purple-500' };
  if (CODE_EXT.has(e)) return { icon: FileCode, color: 'text-sky-500' };
  if (TEXT_EXT.has(e)) return { icon: FileText, color: 'text-indigo-500' };
  return { icon: File, color: 'text-muted-foreground' };
}

const ARCHIVE_EXT = new Set(['.zip', '.tar', '.gz', '.tgz', '.bz2', '.xz', '.7z', '.rar', '.jar', '.war']);
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.svg', '.tif', '.tiff', '.heic', '.avif']);
const SPREADSHEET_EXT = new Set(['.xlsx', '.xls', '.csv', '.tsv', '.ods']);
const JSON_EXT = new Set(['.json', '.jsonl', '.ndjson']);
const VIDEO_EXT = new Set(['.mp4', '.mov', '.avi', '.mkv', '.webm', '.flv', '.wmv']);
const AUDIO_EXT = new Set(['.mp3', '.wav', '.flac', '.aac', '.ogg', '.m4a']);
const CODE_EXT = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.java', '.kt', '.go', '.rs', '.rb', '.php',
  '.c', '.h', '.cpp', '.hpp', '.cs', '.swift', '.scala', '.sh', '.bash', '.zsh', '.ps1', '.bat',
  '.sql', '.css', '.scss', '.less', '.vue', '.svelte', '.r', '.m', '.lua', '.dart', '.gradle',
]);
const TEXT_EXT = new Set([
  '.md', '.markdown', '.txt', '.text', '.log', '.yaml', '.yml', '.toml', '.ini', '.conf', '.cfg',
  '.env', '.html', '.htm', '.xml', '.rst',
]);
