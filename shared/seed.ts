/**
 * 初始种子数据：数据库首次初始化时写入，前端「重置数据」也复用同一份。
 */
import type { DocNode, Repo, User } from './types.ts';

export const SEED_USERS: User[] = [
  { id: 'u-admin', username: 'admin', displayName: '系统管理员', role: 'admin', avatar: 'A', color: '#6366f1' },
  { id: 'u-viewer', username: 'viewer', displayName: '访客', role: 'viewer', avatar: 'V', color: '#f59e0b' },
];

const now = Date.now();

/**
 * 离线兜底用的示例仓库。
 *
 * 前端在拿不到服务端数据时用 SEED_DOCS 撑起界面，
 * 而示例文档必须有归属——v2 起不存在「没有仓库」这种文档。
 */
export const SEED_REPO_ID = 'r-demo';

export const SEED_REPO: Repo = {
  id: SEED_REPO_ID,
  slug: 'demo',
  name: '示例',
  description: '示例文档的归属仓库',
  color: '#6366f1',
  allowedExts: [],
  maxFileSize: 26214400,
  ragEnabled: true,
  createdAt: now,
  updatedAt: now,
  createdBy: 'u-admin',
};

/**
 * 示例文档。
 *
 * 没有 repoId：示例文档属于哪个仓库，取决于运行时往哪个仓库里灌它们。
 * 硬写死一个 id 的话，换个部署环境这个 id 就不存在了。
 */
export const SEED_DOCS: Omit<DocNode, 'repoId'>[] = [
  {
    id: 'd-welcome',
    name: '欢迎使用 WorkHub.md',
    type: 'file',
    parentId: null,
    content: `# 欢迎使用 WorkHub

> 一款 **文档与原件一体化归档** 的协作管理平台

## 核心功能

- 在线编辑：实时预览，所见即所得
- 文件夹管理：树状结构，清晰组织
- 权限控制：管理员 / 访客 两级权限
- 文件上传：支持拖拽上传 .md 文件
- 一键下载：将任意文档导出到本地
- 智能问答：基于你有权限查看的文档自动检索作答

## 架构说明

- 前端：React 19 + TypeScript + Vite + Tailwind CSS
- 后端：Node.js + Express + SQLite
- 文档与 Agent 配置均存储在服务端，浏览器只按需拉取正文
`,
    size: 2048,
    createdAt: now - 1000 * 60 * 60 * 24 * 7,
    updatedAt: now - 1000 * 60 * 60 * 2,
    createdBy: 'u-admin',
    updatedBy: 'u-admin',
    tags: ['指南', '入门'],
  },
  {
    id: 'd-guide',
    name: '使用指南.md',
    type: 'file',
    parentId: null,
    content: `# 使用指南

## 一、身份说明

- **管理员**：进入工作区后点击左侧「管理员」按钮。初始密码默认是 \`admin\`（仅首次建库时写入），也可以用环境变量 \`WORKHUB_ADMIN_PASSWORD\` 在部署时指定。登录后可在侧边栏头像旁的钥匙图标修改；已忘记密码可用 \`npm run admin:password -- <新密码>\` 离线重置
- **访客**：只读身份，可浏览与下载全部文档；加密文档的正文需提交访问申请、由管理员批准后方可查看

## 二、权限说明

### 管理员
> 拥有全部权限：创建、编辑、删除、移动、上传、配置 Agent、加密文档。

### 访客
> 只能查看和下载文档；加密文档的正文需要提交访问申请、由管理员批准后方可查看，且不进入 Agent 的检索范围。

## 三、操作流程

1. 在左侧文件树中选择或创建文档
2. 双击文档进入编辑模式
3. 编辑完成后点击「保存」或使用 \`Ctrl + S\`
4. 通过工具栏的「下载」按钮可导出 .md 文件

## 四、最佳实践

- 命名规范：使用有意义的文件名
- 目录结构：按项目或主题组织文件夹
- 版本管理：重要文档建议在文件名中标注日期
`,
    size: 1536,
    createdAt: now - 1000 * 60 * 60 * 24 * 5,
    updatedAt: now - 1000 * 60 * 30,
    createdBy: 'u-admin',
    updatedBy: 'u-admin',
    tags: ['帮助'],
  },
  {
    id: 'd-folder-projects',
    name: '项目文档',
    type: 'folder',
    parentId: null,
    createdAt: now - 1000 * 60 * 60 * 24 * 3,
    updatedAt: now - 1000 * 60 * 60 * 1,
    createdBy: 'u-admin',
    updatedBy: 'u-admin',
  },
  {
    id: 'd-proj-readme',
    name: '项目说明.md',
    type: 'file',
    parentId: 'd-folder-projects',
    content: `# 项目说明

## 项目目标

构建一款现代化的 Markdown 文档管理平台，并将文档与模型凭据收敛到服务端。

## 技术栈

- **前端**：React 19 + TypeScript + Vite
- **后端**：Node.js + Express + SQLite（better-sqlite3）
- **UI 库**：shadcn/ui + Tailwind CSS v4
- **图标**：Lucide Icons

## 里程碑

- [x] 需求分析
- [x] 架构设计
- [x] UI 设计
- [x] 核心功能开发
- [x] 服务端落库与鉴权
- [ ] 测试与发布
`,
    size: 1024,
    createdAt: now - 1000 * 60 * 60 * 24 * 3,
    updatedAt: now - 1000 * 60 * 60 * 5,
    createdBy: 'u-admin',
    updatedBy: 'u-admin',
    tags: ['项目', '技术'],
  },
  {
    id: 'd-proj-api',
    name: 'API 文档.md',
    type: 'file',
    parentId: 'd-folder-projects',
    content: `# API 文档

所有接口以 \`/api\` 为前缀，写操作需在请求头携带 \`Authorization: Bearer <token>\`。

## 认证接口

### \`POST /api/auth/login\`
管理员登录，签发 JWT。参数：\`password\`（string，必填）。

### \`POST /api/auth/logout\`
清除客户端令牌。

## 文档接口

| 方法 | 路径 | 说明 | 权限 |
| --- | --- | --- | --- |
| GET | \`/api/docs\` | 获取文档列表 | 所有人 |
| POST | \`/api/docs\` | 创建文档 | 管理员 |
| PATCH | \`/api/docs/:id\` | 更新文档 | 管理员 |
| DELETE | \`/api/docs/:id\` | 删除文档及其子树 | 管理员 |
| POST | \`/api/docs/import\` | 覆盖式导入本地历史数据 | 管理员 |

## Agent 接口

| 方法 | 路径 | 说明 | 权限 |
| --- | --- | --- | --- |
| GET | \`/api/agent/config\` | 读取脱敏配置 | 管理员 |
| PUT | \`/api/agent/config\` | 更新配置 | 管理员 |
| GET | \`/api/agent/status\` | 查询可用性与原因 | 所有人 |
| POST | \`/api/agent/ask\` | 提问，SSE 流式返回 | 按配置 |
`,
    size: 1280,
    createdAt: now - 1000 * 60 * 60 * 24 * 2,
    updatedAt: now - 1000 * 60 * 60 * 1,
    createdBy: 'u-admin',
    updatedBy: 'u-admin',
    tags: ['API'],
  },
  {
    id: 'd-folder-team',
    name: '团队周报',
    type: 'folder',
    parentId: null,
    createdAt: now - 1000 * 60 * 60 * 24 * 6,
    updatedAt: now - 1000 * 60 * 60 * 6,
    createdBy: 'u-admin',
    updatedBy: 'u-admin',
  },
  {
    id: 'd-weekly-w36',
    name: '第36周周报.md',
    type: 'file',
    parentId: 'd-folder-team',
    content: `# 第 36 周周报

**周期**：2026.09.02 - 2026.09.08

## 本周完成

- 完成需求评审
- 输出 UI 设计稿
- 启动前端开发

## 下周计划

- 完成核心页面开发
- 开始联调测试

## 风险与问题

- 编辑器组件体积较大，需要按需加载
`,
    size: 768,
    createdAt: now - 1000 * 60 * 60 * 24 * 6,
    updatedAt: now - 1000 * 60 * 60 * 24 * 6,
    createdBy: 'u-admin',
    updatedBy: 'u-admin',
    tags: ['周报'],
  },
  {
    id: 'd-weekly-w37',
    name: '第37周周报.md',
    type: 'file',
    parentId: 'd-folder-team',
    content: `# 第 37 周周报

**周期**：2026.09.09 - 2026.09.15

## 本周完成

- 完成文档编辑功能
- 完成文件上传下载
- 权限系统联调

## 下周计划

- 性能优化
- 用户体验改进

## 心得体会

本周最大的收获是：良好的权限设计能极大降低后续维护成本。
`,
    size: 896,
    createdAt: now - 1000 * 60 * 60 * 24 * 1,
    updatedAt: now - 1000 * 60 * 60 * 4,
    createdBy: 'u-admin',
    updatedBy: 'u-admin',
    tags: ['周报'],
  },
];

/**
 * 把示例文档挂到指定仓库下。
 *
 * 文档必须落在某个仓库里，所以拿到示例文档时得同时给出归属。
 */
export function seedDocsForRepo(repoId: string): DocNode[] {
  return SEED_DOCS.map((d) => ({ ...d, repoId }));
}
