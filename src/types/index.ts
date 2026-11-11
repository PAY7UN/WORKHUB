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
  DocNode,
  DocSearchHit,
  DocTree,
  GuestIdentity,
  PolishTask,
  RagScope,
  RagScopeMode,
  Repo,
  RepoStat,
  User,
} from '../../shared/types';

export {
  ACCESS_AUDIT_LABELS,
  ACCESS_CAPABILITY_LABELS,
} from '../../shared/types';

export type {
  SkillCategory,
  SkillMode,
  SkillParamOption,
  SkillParamSpec,
  SkillParamType,
  SkillSessionSpec,
  SkillSpec,
  SkillSummary,
} from '../../shared/skills';

export { SKILL_CATEGORY_ORDER } from '../../shared/skills';

export type {
  AgentAction,
  AgentActionKind,
  AgentChatRequest,
  AgentChatResult,
  AgentEvent,
  AgentRole,
} from '../../shared/agent';

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
 *
 * 「加密文档」不再是独立分区：加密文档本来就是「谁能看它」这个问题的一部分，
 * 拆成两个分区只会让管理员在两个地方来回找同一件事的答案。
 */
export type AdminSection = 'overview' | 'access' | 'repos' | 'agent' | 'security';

/** 管理后台分区的中文名，用于标题与面包屑 */
export const ADMIN_SECTION_LABELS: Record<AdminSection, string> = {
  overview: '概览',
  access: '访问权限',
  repos: '仓库管理',
  agent: 'AI Agent',
  security: '账号安全',
};
