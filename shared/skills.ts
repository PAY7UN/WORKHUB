/**
 * 能力（Skill）的规格。
 *
 * 「能力」是这套东西的基本单位，一份能力就是一个目录：
 *
 *   skills/web-fetch/
 *     SKILL.md      说明书：frontmatter(name/description) + 正文用法
 *     skill.json    执行契约：方法、路径、入参、返回、权限
 *
 * 之所以拆成两个文件，是因为它们的读者不同：
 * - SKILL.md 给人看，也给模型看（description 决定模型何时想起它）；
 * - skill.json 给机器看（表单渲染、调用、鉴权都按它来）。
 * 混在一个文件里，模型要读一堆 JSON 才能知道自己该干什么。
 *
 * 这一层只定义形状，不含任何能力实例：
 * 实例在运行时从磁盘扫出来（见 server/skills/loader.ts）。
 */

/** 能力的分类：按「它对资料做什么」划分 */
export type SkillCategory = 'search' | 'ai' | 'content' | 'access' | 'system' | 'web' | 'data';

/** 分类的展示顺序：先看最常用的 */
export const SKILL_CATEGORY_ORDER: SkillCategory[] = [
  'web',
  'data',
  'search',
  'ai',
  'content',
  'access',
  'system',
];

/**
 * 能力的执行形态。
 *
 * - `request`：一次调用换一次结果，完事。
 * - `session`：**先开始、后结束**，中间一直产出记录。监听串口、监听端口都属这类。
 *
 * 两种形态没法用同一套调用方式套住，所以形态写在能力自己身上，
 * 界面与运行时各自按形态行事。
 */
export type SkillMode = 'request' | 'session';

/** 入参类型：决定表单里渲染成什么控件 */
export type SkillParamType = 'text' | 'longtext' | 'number' | 'datetime' | 'select' | 'boolean';

/** 一个下拉选项 */
export interface SkillParamOption {
  label: string;
  value: string;
  /** 选项的补充说明，鼠标悬停时显示 */
  help?: string;
}

/** 一个入参 */
export interface SkillParamSpec {
  key: string;
  label: string;
  type: SkillParamType;
  required: boolean;
  placeholder?: string;
  /** type==='select' 时的可选项 */
  options?: SkillParamOption[];
  /** 这个参数该填什么 */
  help?: string;
}

/** 会话型能力的控制端点（相对服务端路径，不含 /api 前缀） */
export interface SkillSessionSpec {
  /** 开监听 */
  start: string;
  /** 关监听 */
  stop: string;
  /** 取已抓到的记录（支持 after 游标取增量） */
  records: string;
  /** 订阅实时产出（SSE） */
  stream: string;
}

/**
 * 一份能力的完整规格。
 *
 * 每一份都指向**已经存在**的服务端能力，而不是「将来会做」的许愿单：
 * 点了能跑，才算能力。
 */
export interface SkillSpec {
  /** 调用用的 id（如 doc.search） */
  id: string;
  /** 目录名（如 doc-search）：id 的点号换成连字符 */
  slug: string;
  /** 中文名 */
  name: string;
  category: SkillCategory;
  /** 一句话说明它是干什么的 */
  summary: string;
  /**
   * 何时用。
   *
   * 这是给模型看的触发词：说清楚「做什么」之外，还得说清楚「什么时候该想起它」。
   * 只有名字的描述模型认不出来；只有功能的描述模型会滥用。
   */
  description: string;
  /** SKILL.md 正文：完整用法与边界 */
  instructions: string;
  /** 调用方式：GET / POST / PATCH / DELETE */
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  /** 服务端路径（不含 /api 前缀） */
  endpoint?: string;
  /** 是否仅管理员可用 */
  adminOnly: boolean;
  /**
   * 能否进「一句话任务」。
   *
   * 能力页里能跑 ≠ 任务里能跑：会写数据的能力（提交授权申请）
   * 一次跑错就是错数据，代价远高于手动点一下。
   */
  composable: boolean;
  /** 执行形态 */
  mode: SkillMode;
  /** 会话型能力的控制端点 */
  session?: SkillSessionSpec;
  params: SkillParamSpec[];
  /** 返回值说明 */
  returns?: string;
  /** 来源：内置目录还是用户目录 */
  source: 'builtin' | 'user';
  /** 能否直接执行：有服务端执行体，或声明了 HTTP 端点 */
  executable: boolean;
  /**
   * 服务端有没有专门的执行体。
   *
   * 有执行体 → 界面把参数交给服务端，由服务端去跑（能拿到服务端的上下文）；
   * 没有 → 界面按契约里的 method + endpoint 直接调那个接口。
   *
   * 分这两条路，是因为后一种才是「丢个文件就能加能力」：
   * 用户自建的能力不必先在服务端写代码。
   */
  hasRunner: boolean;
}

/**
 * 清单里的样子：不带正文。
 *
 * 清单是给人快速扫的，也是给模型做「发现」的——
 * 按渐进式披露的原则，发现阶段只该花掉 name + description 的钱，
 * 正文等到真的要用了再读。
 */
export type SkillSummary = Omit<SkillSpec, 'instructions'>;

