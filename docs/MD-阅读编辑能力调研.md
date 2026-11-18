# MDHUB Markdown 阅读 / 编辑能力调研

> 调研日期：2026-11-14
> 对照基准：GitHub（GFM 规范 + GitHub 网页编辑器 + 仓库版本语义）、主流开源 Markdown 编辑器、文档站生成器
> 代码基线：`d:/github/MDHUB`（marked 18 / CodeMirror 6 / DOMPurify 3 / FTS5 / vault 文件存储）

---

## 0. 一句话结论

MDHUB 的 Markdown 目前是**「一个能用的渲染器 + 一个能用的源码编辑器」**，离 GitHub 那一档还差一个量级：

- **语法层**只覆盖到 GFM 的「表格 / 任务列表 / 删除线」，GitHub 自家的 Alerts、公式、Mermaid、脚注全无；
- **渲染层**最扎眼的是**预览里代码完全没有高亮**——编辑器侧有 9 种语言的语法支持，预览侧一块纯色代码块；
- **编辑层**是纯源码模式，GitHub 的 Write/Preview 并排、粘贴图、所见即所得都没有；
- **知识层**（双链、反链、属性 front-matter）几乎为零；
- **协作层**（版本历史、评论、审阅）**完全空白**——`nodes` 表里没有 revision 表，删了就是删了，代码注释里写得很直白；
- **交付层**只有一个 CLI 脚本能导出 md，桌面端没有导出 PDF/HTML/打包入口。

**但真正的第一优先级不是补这些特性，而是先修三处「已经写了却没接上」的断链**——它们是零后端成本的现成功能，见 §1.5。

---

## 1. 现状盘点（MDHUB 现在到底有什么）

### 1.1 数据流

```
CodeMirror 6（源码编辑）──┐
                          ├─▶ marked.parse ─▶ DOMPurify ─▶ wrapTables ─▶ .markdown-body
marked.lexer ─▶ extractHeadings（目录，精确到源码行）
                                                                     ▲
                                                       index.css 的精细排版层

保存：PATCH /api/docs/:id ─▶ nodes 表（path / content_hash）─▶ vault 文件
检索：node_fts + attachment_fts（FTS5 + 中文 bigram，shared/retrieval.ts）
```

### 1.2 阅读（渲染）侧能力清单

| 能力 | 现状 | 落点 |
|---|---|---|
| CommonMark / GFM 基础 | ✅ marked 18，`gfm: true`、`breaks: true` | `src/lib/markedExt.ts:9` |
| 表格 | ✅ 且额外套了横向滚动容器（解决窄栏裁切） | `src/components/app/MarkdownPreview.tsx:29` |
| 任务列表 | ✅ 复选框样式完整，已勾选项淡显 | `src/index.css:570-612` |
| 删除线 | ✅ | marked 内置 |
| 扩展自动链接 | ✅ | marked 内置 |
| 上标 / 下标 | ✅ **自定义扩展**（marked 不支持，且 `~x~` 会被 del 抢走） | `src/lib/markedExt.ts:28-66` |
| 引用式链接 / 图片引用式 | ✅ | marked 内置 |
| **代码语法高亮** | ❌ 预览完全不 highlight | — |
| **数学公式** | ❌ 代码注释里明确写了「本项目不渲染公式」 | `markedExt.ts:25-26` |
| **Mermaid 图** | ❌ | — |
| **GitHub Alerts（`> [!NOTE]`）** | ❌ | — |
| **脚注** | ❌ | — |
| **标题锚点 id** | ❌ heading 不带 id，目录跳转靠 `outline-flash` 动画 + 滚动匹配 | `src/index.css:715` |
| **内部链接 / 相对路径解析** | ❌ 原样渲染，点不开站内文档 | — |
| **图片懒加载** | ❌ | `src/index.css:699` |
| `<details>` 折叠 | ⚠️ DOMPurify 默认剥掉 | `MarkdownPreview.tsx:61` |
| 渲染安全 | ✅ DOMPurify + 表格包装放在净化**之后**（顺序是对的） | `MarkdownPreview.tsx:59-64` |
| 排版细节 | ✅ 6 级标题形态各异、表格圆角、紧凑模式（`markdown-body-compact`） | `src/index.css:324+` |

> **这一层的实际观感是「干净、克制、排版讲究」**，这是 MDHUB 相对多数开源编辑器（Typora、Toast UI）的真实优势，不要在补功能时把它弄丢——所有新渲染扩展都必须走同一套 `.markdown-body` 样式。

### 1.3 编辑侧能力清单

| 能力 | 现状 | 落点 |
|---|---|---|
| 语法解析 | ✅ Lezer markdown（CodeMirror 官方） | `src/components/app/MarkdownEditor.tsx:325` |
| 编辑器内代码高亮 | ✅ 9 种语言（js/cpp/css/html/java/json/python/rust/sql） | `MarkdownEditor.tsx:79` |
| 工具栏 | ✅ 标题 / 粗 / 斜 / 删除线 / 上标 / 下标 / 引用 / 行内码 / 链接 / 图片 / 有序无序列表 / 任务列表 / 表格 / 分割线 | — |
| 快捷键 | ✅ Mod-b / Mod-i / Mod-` / Mod-z / Mod-y / Mod-Shift-z + markdown keymap | `MarkdownEditor.tsx:326-348` |
| 选区包裹 / 取消包裹 | ✅ 带状态灯（不会出现按钮亮着但行为叠加） | `MarkdownEditor.tsx:620-707` |
| 外部内容回填 | ✅ `diffRange` 只替换变化的那一段，不打断光标 | `MarkdownEditor.tsx:415-422` |
| 目录 | ✅ 基于 `marked.lexer` + token.raw 累加算行号，精确不漂 | `src/utils/index.ts:52` |
| 多光标 | ✅ `allowMultipleSelections` | `MarkdownEditor.tsx:322` |
| **视图模式** | ⚠️ 预览 / 编辑**互斥全宽**；左右分屏是**被主动拆掉的**（理由：窄窗口两栏各剩几百像素） | `DocEditor.tsx:136-144` |
| **所见即所得** | ❌ 曾经做过、已拆掉，注释里写明代价是「补不完的边角」 | `MarkdownPreview.tsx:47-57` |
| **粘贴图片上传** | ❌ | — |
| **拖拽插入** | ⚠️ 只处理 `.md` 文件拖入 | — |
| **命令面板** | ❌ | — |
| **自动保存 / 草稿** | ❌ 显式保存 | — |

> **注意两处「已拆」的决策**：分屏和所见即所得都是拆过的，且注释里写了理由。补功能时**不要为了「像 GitHub」就把它们加回来**——GitHub 能并排是因为它是全屏网页、用户自己拖分隔条；桌面窄窗口里两栏确实读不下去。

### 1.4 周边能力

- **检索**：`node_fts` / `attachment_fts`（FTS5），中文按 bigram 切分（`shared/retrieval.ts`），写入与查询同一套切法 —— **后端完全就绪**
- **AI**：润色任务（`server/polishTasks.ts`）+ 全局助手问答（RAG 检索喂模型）
- **权限**：加密文档 + 访客访问申请 → 审批 → 授权（含 view/download 能力分离）→ 全量审计流水
- **导出**：`GET /api/docs/:id/download`（笔记导出为 `.md`）、`GET /api/docs/:id/raw`、`scripts/docs.mjs --export`（批量导出 md + front-matter）

### 1.5 ⚠️ 三处「已经写了却没接上」的断链

这是本次调研最该先动的地方——**功能主体已经存在，只差最后一根线**。

#### 断链 1：全文搜索有后端，**没有 UI**

```
src/context/AppContext.tsx:447-477   searchQuery / searchHits / runSearch / clearSearch  —— 定义了、导出了
src/context/AppContext.tsx:1034-1091 塞进了 context value
全仓 grep 结果：src/ 下没有任何组件 import 或调用这四个符号
server/index.ts:452                  GET /api/docs/search → searchDocs(query, 50)  —— 接口是通的
```

也就是说：FTS5 建好了、中文 bigram 分词写好了、附件正文也索引了，**用户在界面上一个搜索入口都找不到**。

> 这是全项目性价比最高的一处补齐：后端成本为 0，感知提升极大。

#### 断链 2：AI 润色**没有 diff 审阅**

`src/lib/textDiff.ts` 实现的不是行级 diff，而是「公共前缀 + 公共后缀」的最简比较——只有一处连续改动时才对，多段改动直接失真。结果就是润色内容**直接覆盖正文**，用户看不到「改了哪几行」，也就无法逐段接受/拒绝。

对比：GitHub 的 PR 视图、VS Code 的 diff 视图、Typora 的版本切换，全都把「改了什么」摆在明面上。这是 AI 写进文档的**信任前提**，不是锦上添花。

#### 断链 3：导出只有 CLI 脚本，桌面端没入口

`scripts/docs.mjs --export` 能把整库导出成带 front-matter 的 md 目录（`id / name / type / tags / createdAt / updatedAt`），但这是**命令行动作**。桌面用户要的是「导出这篇为 PDF / HTML / 打包 zip」。

---

## 2. 对照基准

### 2.1 GitHub 侧

**语法（GFM 规范）** = CommonMark + 6 项扩展：扩展自动链接、禁用原始 HTML（tagfilter）、表格、任务列表、删除线、脚注。另加 GitHub 自家的一层：

- **Alerts**：`> [!NOTE]` / `[!TIP]` / `[!IMPORTANT]` / `[!WARNING]` / `[!CAUTION]`
- **数学公式**：行内 `$…$`、块级 `$$…$$`
- **Mermaid**：```mermaid 代码块直接渲染成图
- **图片尺寸**：`<img width="600">`
- **允许的 HTML 子集**：`<details>`、`<summary>`、`<picture>`、`<video>`、`<kbd>` 等
- **Wiki 链接**：`[[Page]]` 双链 + `[[Page|Alias]]`

**渲染器**：`github/cmark-gfm` —— CommonMark 引用实现（cmark）的 fork，通过全部 CommonMark 一致性测试，扩展清单见 `extensions/` 目录。

**GitHub 网页编辑器**：

- 工具栏 + 快捷键：`Ctrl+B`（粗）/ `Ctrl+I`（斜）/ `Ctrl+E`（行内码）/ `Ctrl+K`（链接）/ `Ctrl+Shift+7`（有序列表）/ `Ctrl+Shift+8`（无序列表）/ `Ctrl+Shift+.`（引用）
- **Write / Preview 并排 tab**
- 粘贴 / 拖拽图片 → 自动上传 → 插入 markdown 图片链接
- 悬停自动链接 → 弹出预览卡片
- `@mention` 联想、`#123` 自动引用 issue/PR
- 表格编辑器（可视化的行列增删）
- 源码高亮、emoji 补全、Markdown 语法在编辑框内直接着色

**仓库语义（GitHub 真正的护城河）**：文件即版本 —— commit / blame / diff / PR 审阅 / 行内评论 / Wiki / Releases。

### 2.2 开源编辑器

| 项目 | 值得抄的点 |
|---|---|
| **CodeMirror 生态**（MDHUB 同源） | `Markdown All in One` 快捷键套件（自动列表续行、选区行操作、表格对齐）；`Live Preview` 扩展（源码↔渲染同步滚动 + 点击渲染块定位源码）；`Markdown Preview Enhanced`（Pandoc 导出 PDF/DOCX） |
| **Typora** | 所见即所得 + 即时切换源码；主题系统；导出 PDF / HTML / Word |
| **Obsidian** | Wiki 双链、反向链接面板、Properties（front-matter）、全库搜索、命令面板（Ctrl+P）、Canvas 白板、图谱视图 |
| **Toast UI Editor** | 分屏 + 主题 + Mermaid + KaTeX + 图表 + 图片上传（可挂自定义 handler）+ 导出 HTML |
| **Cherry Markdown** | 分屏、主题、图表、流程图、导出多格式、上传图片 |
| **VitePress / MkDocs Material / docsify** | front-matter 元数据、标题锚点、Admonition 提示块、代码复制按钮、代码行高亮、站点侧栏导航、SEO |

### 2.3 GitHub 本身也是开源的（这一点容易被忽略）

`github/cmark-gfm`（C 实现的解析器）、`github/markdown`（API + GFM 规范文档）、`remark`/`rehype` 生态（JS 生态的事实标准）、`micromark`（解析）、`shiki`（TextMate 语法高亮）、`mermaid`（图表）、`katex`（公式）——**MDHUB 依赖的 marked 正处在这条链上**（marked → micromark 的替代品，API 高度相似）。换渲染内核时这些都能平移。

---

## 3. 差距矩阵

八个维度，每维给出「GitHub / 开源怎么做 → MDHUB 现状 → 差距 → 建议」。

### 3.1 语法兼容层

| 项 | GitHub / 开源 | MDHUB | 差距 | 建议 |
|---|---|---|---|---|
| 表格 / 任务列表 / 删除线 / 自动链接 | ✅ | ✅ | 无 | — |
| 脚注 | ✅ | ❌ | 大 | P1，marked 有 `footnotes: true` 开关 |
| 数学公式 | ✅ KaTeX/MathJax | ❌ | 大 | P1，见 §5 选型 |
| Mermaid | ✅ | ❌ | 大 | P1，按需加载 |
| Alerts 提示块 | ✅ | ❌ | 中 | P1，marked 自定义 block tokenizer |
| `<details>` 折叠 | ✅ 允许 | ❌ 被 DOMPurify 剥掉 | 中 | P1，DOMPurify 加白名单 |
| Wiki 双链 `[[ ]]` | ✅ / Obsidian | ❌ | 大 | P2 |
| 引用式链接 / 图片尺寸 | ✅ | 引用式 ✅ / 尺寸 ❌ | 小 | P2 |

### 3.2 渲染质量

| 项 | GitHub / 开源 | MDHUB | 差距 | 建议 |
|---|---|---|---|---|
| 代码高亮 | ✅ cmark-gfm + linguist | ❌ **预览零高亮** | **最大单点** | **P0** |
| 标题锚点 / 复制小节链接 | ✅ | ❌ | 大 | P0 |
| 内部链接可点 | ✅ | ❌ | 中 | P1 |
| 图片懒加载 | ✅ | ❌ | 小 | P1 |
| 代码块复制按钮 | ✅ MkDocs Material / docsify | ❌ | 小 | P1 |
| 渲染性能（大文档） | ✅ | ⚠️ 无虚拟化、无缓存 | 中 | P1 |

### 3.3 编辑体验

| 项 | GitHub | MDHUB | 差距 | 建议 |
|---|---|---|---|---|
| 快捷键完备度 | ✅ 全套 | ⚠️ 只有 b/i/`/z | 中 | P1 |
| 粘贴 / 拖拽图片 | ✅ 自动上传 | ❌ | 大 | P1 |
| 并排预览 | ✅ | ⚠️ 被拆（有意） | — | **不建议恢复**，改为「可调整比例的分屏」由用户主动开 |
| 所见即所得 | GitHub 无（Typora 有） | ❌ 已拆（有意） | — | **不建议恢复** |
| 命令面板（Ctrl+P） | ✅ / Obsidian | ❌ | 中 | P2 |
| 自动保存 / 崩溃恢复 | ✅ | ❌ | 中 | P1 |
| 表格可视化编辑 | ✅ | ❌ | 小 | P2 |
| Emoji 补全 | ✅ | ❌ | 小 | P2 |
| 选区多行操作 | ✅ | ✅ | 无 | — |

### 3.4 知识层

| 项 | Obsidian / Notion | MDHUB | 差距 | 建议 |
|---|---|---|---|---|
| 双链 / 反链面板 | ✅ | ❌ | 大 | P2 |
| Properties（front-matter） | ✅ | ⚠️ 只有导出脚本写 front-matter，**读时不解析** | 大 | P1（属性面板，先做读） |
| 标签体系 | ✅ | ✅ 有 tags 字段 | 无 | — |
| 关系 / 反向引用 | ✅ | ❌ | 大 | P2 |
| 图谱 / 关系可视化 | ✅ Obsidian | ❌ | 中 | P2 |
| 命令面板 | ✅ | ❌ | 中 | P2 |

### 3.5 协作层

| 项 | GitHub | MDHUB | 差距 | 建议 |
|---|---|---|---|---|
| 版本历史 / diff | ✅ commit/blame | ❌ **无 revision 表，删了就是删了** | **最大缺口** | **P1** |
| 行内评论 / 批注 | ✅ | ❌ | 大 | P2 |
| PR 式审阅（建议模式） | ✅ | ❌ | 大 | P2 |
| 实时协同（多人同时写） | ✅ | ❌ | 大 | P2，且**成本最高**，需 Yjs/CRDT |
| 访客只读分享 | ✅ wiki / gist | ✅ 已有（访问申请 + 授权） | 无 | — |
| 审计流水 | ✅ | ✅ 已有（`access_audit`） | 无 | — |

### 3.6 检索层

| 项 | GitHub | MDHUB | 差距 | 建议 |
|---|---|---|---|---|
| 全文搜索 | ✅ | ⚠️ **后端完备，前端无入口** | **断链** | **P0** |
| 搜索结果高亮 / 片段 | ✅ | ❌ | 中 | P0 一起做 |
| 按类型/标签/路径过滤 | ✅ | ⚠️ 后端有 scope 概念，未见于 UI | 中 | P1 |
| 语义检索 / AI 问答 | Copilot | ✅ 已有（RAG + 助手） | 无 | — |

### 3.7 交付层

| 项 | GitHub / 开源 | MDHUB | 差距 | 建议 |
|---|---|---|---|---|
| 导出 md | ✅ | ✅ | 无 | — |
| 导出 PDF | ✅（打印）/ Typora | ❌ | 大 | P1 |
| 导出 HTML | ✅ | ❌ | 大 | P1 |
| 导出 zip（打包带附件） | ✅ | ❌ | 中 | P1 |
| 发布为站点 | ✅ Pages | ❌ | 中 | P2 |
| 只读分享链接 | ✅ | ⚠️ 有访客授权，但无「生成链接」形态 | 中 | P2 |
| 嵌入 iframe | ✅ gist | ❌ | 小 | P2 |

### 3.8 AI 层

| 项 | Copilot / 开源 | MDHUB | 差距 | 建议 |
|---|---|---|---|---|
| 行内改写 / 续写 | ✅ | ⚠️ 只有整篇润色 | 中 | P1 |
| 润色 diff 审阅（逐段接受） | ✅ | ❌ **断链** | **大** | **P0/P1** |
| 摘要 / 翻译 / 标题生成 | ✅ | ❌ | 中 | P1（现有 polish 管线复用） |
| 基于全文的问答 | ✅ | ✅ 已有 | 无 | — |
| 命令面板里调 AI | ✅ | ❌ | 小 | P2 |

---

## 4. 补齐路线

按「感知收益 ÷ 实现风险」排序。**不要一次全上**，按批走，每批可独立验收。

### P0 —— 断链修复与低成本高感知（建议 1 周内）

| # | 事项 | 落点 | 工作量 | 说明 |
|---|---|---|---|---|
| P0-1 | **全局搜索 UI** | 顶栏加搜索入口（`Ctrl+K` / `Ctrl+F` 唤起）+ 结果列表 + 命中片段高亮；消费 `AppContext` 已有的 `runSearch/searchHits` | 1.5 天 | 后端 0 成本；顺手加类型/标签过滤（`searchDocs` 已支持 scope 参数） |
| P0-2 | **预览代码高亮** | `MarkdownPreview.tsx` 里加 `marked-highlight` + highlight.js 按需注册语言（与编辑器侧 9 种语言对齐即可） | 1 天 | 单点收益最大的渲染缺口 |
| P0-3 | **标题锚点 + 复制小节链接** | 渲染时给 heading 生成 slug id；`DocOutline` 增加「复制本节链接」；处理中文 slug（可用拼音或 hash 兜底） | 1 天 | 让目录与外部引用真正成立 |
| P0-4 | **行级 diff 库替换** | `src/lib/textDiff.ts` 换成 `diff`（jsdiff）的行级 Myers 实现，保留现有 API 形状 | 0.5 天 | 是 P1-1 的前置 |
| P0-5 | **导出面板** | 文档菜单加「导出」：`.md` / `.html`（带 `.markdown-body` 样式与 TOC） / `.zip`（正文 + 附件）；后端复用现有 `download` 路由补一个 html/zip 变体 | 1.5 天 | HTML 导出现在就能靠现有渲染管线直接产出 |

> P0 合计约 6 天，且**不碰数据库 schema**，风险极低。

### P1 —— 渲染保真 + 编辑效率 + 知识层起步（建议 1~2 个月）

| # | 事项 | 落点 | 工作量 | 说明 |
|---|---|---|---|---|
| P1-1 | **AI 润色 diff 审阅** | 新建「润色结果审阅」视图：左原文右改后，行级 diff 着色，支持**逐段接受/拒绝**、全部接受；写回走现有 `PATCH /api/docs/:id` | 3 天 | 这是 AI 能力能否被信任的前提 |
| P1-2 | **文档版本历史** | 新增 `doc_revisions` 表（`doc_id, seq, content_hash, storage_key, author, created_at`）；vault 里存快照；服务端提供 list / diff / restore | 4 天 | 可复用现有 `content_hash` 机制 |
| P1-3 | **数学公式（KaTeX）** | marked 自定义 inline/block tokenizer 接管 `$…$` / `$$…$$`；**注意与上标 `^` 的冲突**（`markedExt.ts:25-26` 已预警）——建议给公式单独转义或让公式扩展优先级更高 | 2 天 | 见 §5 风险 |
| P1-4 | **Mermaid 图** | ```mermaid 块单独懒加载 mermaid；渲染前转成占位 div | 2 天 | mermaid 体积大，必须按需 |
| P1-5 | **Alerts + `<details>` + 脚注** | marked 自定义 block tokenizer（Alerts）；DOMPurify 加 `<details>/<summary>` 白名单；marked `footnotes: true` | 2 天 | 一次做完三个小项 |
| P1-6 | **图片粘贴 / 拖拽上传并插入** | 编辑器监听 paste / drop → 调现有 `POST /api/docs/:id/attachments` → 插入 `![name](/api/attachments/:id/download)` | 2 天 | 直接用现成附件链路 |
| P1-7 | **front-matter 属性面板** | 读时解析 front-matter（导出脚本已经在写它了）；正文顶部渲染状态/负责人/日期等属性；保存时保留 | 2 天 | 与导出脚本形成闭环 |
| P1-8 | **快捷键补齐 + 命令面板** | 表格对齐（Tab/Shift+Tab）、选区行操作、自动列表续行；`Ctrl+P` 命令面板（可复用 Radix Dialog） | 3 天 | 参考 Markdown All in One |
| P1-9 | **自动保存 / 崩溃恢复草稿** | 停止输入 2s 后自动保存；本地草稿兜底（localStorage/临时文件） | 2 天 | 显式保存在桌面端体验偏重 |
| P1-10 | **内部链接与相对路径** | 渲染时解析站内相对路径 → 路由到文档；未命中时给「创建该文档」入口 | 2 天 | 文档库场景的刚需 |
| P1-11 | **导出 PDF** | 服务端用 Playwright / Puppeteer 渲染导出页（含 `.markdown-body` 样式与目录）后转 PDF | 3 天 | 依赖 P0-5 的 HTML 导出 |
| P1-12 | **代码块复制按钮 / 图片懒加载 / 渲染性能** | 渲染后处理：复制按钮、`loading="lazy"`；大文档分段渲染或虚拟化 | 2 天 | 低风险体验补丁 |

### P2 —— 知识层、协作层、交付层（建议 3 个月+）

| # | 事项 | 说明 |
|---|---|---|
| P2-1 | **Wiki 双链 + 反向链接面板** | `[[标题]]` 语法扩展；建 `doc_edges` 边表；文档右侧「谁引用了我」面板。参考 Obsidian |
| P2-2 | **行内评论 / 批注** | 选中文本 → 留言；锚点存「文档 + 段落指纹」，文档改动后定位修正。参考 Typora / Google Docs |
| P2-3 | **审阅模式（建议 → 接受）** | 编辑人提交建议，管理员逐条接受/拒绝。依赖 P1-2 版本历史 |
| P2-4 | **发布为站点** | 用 VitePress 或自研，把 vault 内容发布成可访问站点，front-matter 驱动导航。**这一条直接承接 MDHUB「AI 技能流 + 协议文档」的方向** |
| P2-5 | **只读分享链接 / iframe 嵌入** | 生成带 token 的只读链接与嵌入代码；复用现有 `access_grants` 权限模型 |
| P2-6 | **实时协同** | Yjs/CRDT + WebSocket。**成本最高（架构级改动），仅在确认有多人同时写需求时再做** |
| P2-7 | **图谱视图 / Canvas 白板** | 依赖 P2-1 的边表 |
| P2-8 | **表格可视化编辑器** | GitHub 风格行列增删 |
| P2-9 | **AI 续写 / 摘要 / 翻译 / 标题生成** | 复用现有 polish 管线，改为「选区级」而非整篇级 |

---

## 5. 技术选型建议与风险

### 5.1 依赖选型

| 能力 | 推荐 | 备选 | 体积 | 说明 |
|---|---|---|---|---|
| 代码高亮 | **highlight.js**（core + 按需注册 9 种语言） | shiki | core ~40KB | shiki 走 TextMate 引擎，异步 + WASM/大体积，对桌面端边际收益低；highlight.js 同步、快、够用 |
| 数学公式 | **KaTeX** | MathJax | ~280KB | `markedExt.ts:25-26` 已明确指向 katex |
| Mermaid | **mermaid v11**（仅 ```mermaid 块懒加载） | — | ~3MB | 必须按需，绝不能进主 bundle |
| 行级 diff | **diff（jsdiff）** | diff-match-patch | 小 | 直接替换 `src/lib/textDiff.ts` 内部实现即可 |
| front-matter 解析 | **gray-matter** | 手写 YAML front-matter 解析 | 小 | 导出脚本已经在写同一种格式，读的时候用同一个解析器 |
| 命令面板 | **cmdk** | 自研 | 小 | 项目已用 Radix Dialog，风格能对齐 |
| PDF 导出 | **playwright-core**（复用已有 Chromium）或系统打印 | — | 大 | 优先考虑「导出 HTML + 浏览器打印为 PDF」这条轻路径 |

### 5.2 明确的技术风险

1. **公式 vs 上标的字符冲突**（已知）：`markedExt.ts:25-26` 写明 `$x^2$` 里的孤立 `^` 会被上标扩展误判。**上公式前必须先决策**：要么放弃上标按钮，要么公式扩展优先级更高且要求 `$` 紧邻闭合。
2. **上标 vs 删除线的字符冲突**（已解决）：`~x~` 会被 del 抢走，项目已用自定义扩展接管 —— 说明这条路的代价是「每个扩展都要重新定义字符归属」，继续加扩展时要预留这一成本。
3. **DOMPurify 白名单扩大**：加 `<details>/<summary>` 时要一并复核 `ALLOWED_TAGS`，避免重新打开 XSS 面。
4. **marked 的 block tokenizer 顺序**：Alerts / details / mermaid 三个自定义 block 扩展会互相抢优先级，必须一次性定好「谁先匹配」并写测试（`src/lib/markedExt.ts` 已有「渲染端与测试共用同一份实现」的约定，扩展测试应挂在同一处）。
5. **版本历史表的迁移**：`server/storage/v2/schema.ts` 的 `expectedColumns()` 会核对库结构，新表必须同步维护（该文件 268 行起的机制说明，新增表要一并处理）。
6. **性能**：每次输入都全量 `marked.parse` + DOMPurify，大文档会掉帧。P1-12 需做分段/节流渲染。

### 5.3 明确**不建议**做的（避免走回头路）

| 不做 | 理由 |
|---|---|
| 所见即所得编辑器 | `MarkdownPreview.tsx:47-57` 已记录：DOM 手术 + 选区捕获 + 往返不等价的边角补不完。**已拆过一次，别回潮** |
| 强制并排分屏 | `DocEditor.tsx:139-142` 已记录：窄窗口两栏各剩几百像素都读不下去。可给「用户主动开启 + 可拖分隔条」的可选分屏，但不做成默认 |
| 自研 Markdown 解析器 | marked → micromark/rehype 生态可平移，没必要造 |
| 实时协同（除非有明确多人同写需求） | 架构级改动（CRDT + WebSocket + 冲突语义），应放在版本历史、评论、审阅之后 |
| 把图片/附件直接塞进 Markdown 正文 | 会破坏「加密文档不接收附件」的边界（`server/index.ts:835-838` 明确以「附件正文会进入检索范围」为由拒绝） |
| 内联 Markdown（正文里嵌 HTML 片段） | 与 DOMPurify 净化模型冲突，且会引出存储层格式问题 |

---

## 6. 验收方式

每批改动按下表自查：

| 批次 | 验收 |
|---|---|
| P0 | ① 搜索框能召回中文正文、附件、标题，并高亮命中片段；② 预览代码块有语法着色，深色/浅色主题都清晰；③ 目录项能「复制本节链接」，粘贴到外部可定位；④ 导出的 HTML 与站内预览视觉一致、附件不丢 |
| P1 | ① AI 润色能逐段接受/拒绝，拒绝后正文与原文逐字一致；② 能从任意历史版本恢复且恢复后可再编辑；③ `$…$` 公式、```mermaid 图、Alerts 块、脚注、`<details>` 全部正确渲染；④ 粘贴截图后正文出现可访问的图片链接；⑤ 停止输入 2s 后内容自动落库，崩溃后草稿不丢 |
| P2 | ① `[[双链]]` 可点击跳转且反链面板列出引用来源；② 选中文本能留言、文档改动后批注仍锚在正确位置；③ 发布出的站点可访问、导航由 front-matter 驱动 |

**通用回归**：`tsc` 0 错误、`eslint` 0 错误、既有测试全过（当前基线 298 个测试）、`vite build` 无循环依赖、浏览器实测明暗两套主题。

---

## 7. 一页速览

| 维度 | GitHub | 开源代表 | MDHUB 现状 | 首要动作 |
|---|---|---|---|---|
| 语法 | GFM + Alerts/公式/Mermaid/脚注 | Typora / Toast UI / Cherry | GFM 基础子集 | P1：补 4 项扩展 |
| 渲染 | cmark-gfm + linguist | shiki / highlight.js | **无高亮** | **P0-2** |
| 编辑 | Write/Preview 并排 + 快捷键全套 + 贴图 | Markdown All in One / Live Preview | 纯源码 + 少量快捷键 | P1-6 / P1-8 |
| 知识 | Wiki 双链 | Obsidian 反链 / Properties | 无 | P1-7 → P2-1 |
| 协作 | commit / PR / 评论 | — | **无版本、无评论** | P1-2 |
| 检索 | 全库 + 过滤 | Obsidian 全文 | **后端完备、前端无入口** | **P0-1** |
| 交付 | Pages / gist / PDF | Typora 导出 | 仅 CLI 脚本 | P0-5 / P1-11 |
| AI | Copilot 行内改写 | — | 整篇润色，**无 diff 审阅** | **P0-4 → P1-1** |

---

## 附：本次调研核对过的代码落点

| 结论 | 文件:行 |
|---|---|
| marked 配置（gfm/breaks）与上下标扩展 | `src/lib/markedExt.ts:9`、`:28-66` |
| 「不渲染公式」的显式取舍说明 | `src/lib/markedExt.ts:25-26` |
| 渲染管线（marked → DOMPurify → wrapTables） | `src/components/app/MarkdownPreview.tsx:59-64`、`:29` |
| 所见即所得被拆的记录 | `src/components/app/MarkdownPreview.tsx:47-57` |
| 预览/编辑互斥、分屏被拆的理由 | `src/components/app/DocEditor.tsx:136-144` |
| 目录标题与源码行号提取 | `src/utils/index.ts:52-72` |
| 编辑器：Lezer markdown、快捷键、diffRange 回填 | `src/components/app/MarkdownEditor.tsx:325`、`:326-348`、`:415-422` |
| 编辑器内代码语言清单（9 种） | `src/components/app/MarkdownEditor.tsx:79` |
| 选区包裹 / 状态灯 | `src/components/app/MarkdownEditor.tsx:620-707` |
| `.markdown-body` 排版层 | `src/index.css:324-720` |
| **搜索上下文存在但无消费者** | `src/context/AppContext.tsx:447-477`、`:1034-1091` |
| 搜索接口 | `server/index.ts:452-455` |
| 中文 bigram 分词 | `shared/retrieval.ts` |
| nodes 表（无 revision 表） | `server/storage/v2/schema.ts:44-71` |
| FTS5 虚表 | `server/storage/v2/schema.ts:96-112` |
| 库结构核对机制（新增表须同步） | `server/storage/v2/schema.ts:268+` |
| 导出行（note → .md） | `server/index.ts:619-648` |
| 原件内联预览 | `server/index.ts:696-736` |
| 加密文档不接收附件的边界 | `server/index.ts:835-838` |
| 删文档无回收站的说明 | `server/index.ts:785-791` |
| 批量导出脚本与 front-matter 格式 | `scripts/docs.mjs:245-267` |
| 行级 diff 缺失（仅公共前后缀） | `src/lib/textDiff.ts` |