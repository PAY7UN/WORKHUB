/**
 * 领域类型统一来自 shared（前后端同源），此处仅补充纯前端的角色权限定义。
 */
import type { UserRole } from '../../shared/types';

export type {
  AccessAuditAction,
  AccessAuditEntry,
  AccessCapability,
  AccessGrant,
  AccessReason,
  AccessRequest,
  Attachment,
  AttachmentTextStatus,
  DingTalkChannel,
  DingTalkConfig,
  DingTalkConfigView,
  DocNode,
  DocSearchHit,
  DocTree,
  GuestIdentity,
  RagScope,
  RagScopeMode,
  Reminder,
  ReminderRepeat,
  ReminderStatus,
  Repo,
  RepoStat,
  User,
} from '../../shared/types';

export { ACCESS_AUDIT_LABELS, ACCESS_CAPABILITY_LABELS } from '../../shared/types';

// 权限定义
export type Permission =
  | 'doc.create'
  | 'doc.edit'
  | 'doc.delete'
  | 'doc.move'
  | 'doc.upload'
  | 'doc.download'
  | 'doc.read'
  | 'user.manage';

export const ROLE_PERMISSIONS: Record<UserRole, Permission[]> = {
  admin: [
    'doc.create',
    'doc.edit',
    'doc.delete',
    'doc.move',
    'doc.upload',
    'doc.download',
    'doc.read',
    'user.manage',
  ],
  // 访客可预览与下载，其余操作均禁止
  viewer: ['doc.read', 'doc.download'],
};

export const ROLE_LABELS: Record<UserRole, string> = {
  admin: '管理员',
  viewer: '访客',
};

export const ROLE_DESCRIPTIONS: Record<UserRole, string> = {
  admin: '拥有全部权限，可管理文档与文件夹',
  viewer: '只读预览 Markdown 文档',
};

/**
 * 管理后台的分区。
 *
 * 管理员要做的事原本散成一排图标（授权、加密文档、改密），
 * 每一件都得先猜「那个图标是哪件事」。这里按功能归类，
 * 每个分区自己管自己的事，入口只留一个「管理后台」。
 */
export type AdminSection = 'overview' | 'access' | 'encrypted' | 'repos' | 'agent' | 'dingtalk' | 'security';

/** 管理后台分区的中文名，用于标题与面包屑 */
export const ADMIN_SECTION_LABELS: Record<AdminSection, string> = {
  overview: '概览',
  access: '访问授权',
  encrypted: '加密文档',
  repos: '仓库管理',
  agent: 'AI Agent',
  dingtalk: '钉钉同步',
  security: '账号安全',
};
