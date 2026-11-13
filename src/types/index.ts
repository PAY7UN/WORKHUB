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
  AdminPasswordState,
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
  RepoEvent,
  RepoEventAction,
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
 * 整个应用只有三个地方：工作台、工具、管理后台。
 *
 * 这是一套导航，不是两套。
 *
 * 早先把它拆成「文档 / 工具 / 系统」三个区域，本意是「这件事归谁管」；
 * 但后台自己的五个分区又被切成了两半——概览、项目仓库挂在「文档」下，
 * 访问权限、Agent、账号安全挂在「系统」下。于是同一个后台有了两副面孔：
 * 从「文档」进来是那排二级 tab，从「系统」进来换成另一排，
 * 右上角还另有一个「管理」按钮直通后台概览。
 * 三处入口指向同一批页面，谁也不知道自己现在到底在哪一层。
 *
 * 现在合成一条：前后两区（文档、工具）都在顶栏，
 * 后台整个收进「管理」，分区平铺——后台就是一个地方，一套导航。
 */
export type AppRegion = 'doc' | 'tool' | 'admin';

/** 后台分区（后台内部的具体页面） */
export type AdminSection = 'overview' | 'projects' | 'encrypted' | 'access' | 'agent' | 'security';

/** 区域的中文名，用于顶栏 */
export const REGION_LABELS: Record<AppRegion, string> = {
  doc: '文档',
  tool: '工具',
  admin: '管理',
};

/** 分区的中文名，用于标题与面包屑 */
export const ADMIN_SECTION_LABELS: Record<AdminSection, string> = {
  overview: '概览',
  projects: '项目仓库',
  encrypted: '加密文档',
  access: '访问权限',
  agent: 'AI Agent',
  security: '账号安全',
};

/** 全部分区 id，用于校验 URL 里的分区名 */
export const ADMIN_SECTIONS: readonly AdminSection[] = [
  'overview',
  'projects',
  'encrypted',
  'access',
  'agent',
  'security',
];

/** 判断 URL 里的分区名是否合法（非法分区一律回落到概览） */
export function isAdminSection(value: string | undefined): value is AdminSection {
  return !!value && (ADMIN_SECTIONS as readonly string[]).includes(value);
}
