/**
 * 附件相关的共享工具（格式判定、体积显示）。
 *
 * 从 shared 转发一份，是为了让前端沿用「@/…」的既有引用习惯，
 * 同时保证前后端用的是同一份判定——两侧口径必须一致，
 * 否则会出现「前端放行、服务端拒绝」这种没有解释的失败。
 */
export {
  COMMON_EXTENSIONS,
  KIND_LABELS,
  extOf,
  formatBytes,
  isPdf,
  isTextSearchable,
  kindOf,
  type AttachmentKind,
} from '../../shared/attachments';
