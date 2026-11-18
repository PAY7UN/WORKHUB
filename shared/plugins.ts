/**
 * 解析插件。
 *
 * 「协议类型」说这套字节长什么样，「解析插件类型」说谁来把它读懂——
 * 两者是分开的两件事：
 *
 * - 协议类型是**协议本身**：帧头是什么、校验怎么算、命令码有哪些。
 * - 解析插件是**一种实现**：把这套协议切成一条条，再把每条读成人话。
 *
 * 同一套协议可以有两种实现（比如通达 LED2 有官方实现，也有厂家自己的实现），
 * 所以插件必须是可替换、可多选的，而不是写死在协议里的一个字段。
 *
 * 插件由**项目开发者发布**：一个目录（manifest.json + 一个 JS 模块），
 * 放进 plugins/ 下就能被界面选到。插件自己坏掉时只记一条警告，
 * 不影响别的插件，更不能让整个服务起不来。
 */
import type { ChannelEncoding, Framing, ProtocolSpec } from './tools.ts';

/**
 * 插件清单：开发者发布的 manifest.json。
 *
 * 字段分三组：
 * - 身份：id、name、publisher、version、summary——界面上显示什么、怎么署名。
 * - 协议：protocol（自带一套协议）或 protocolId（挂在已有协议下）。
 * - 实现：entry（入口模块）、spec（协议详情：帧结构、地址表、命令码表）。
 */
export interface PluginManifest {
  /** 插件 id：全局唯一，界面上靠它认人 */
  id: string;
  /** 人看的名字 */
  name: string;
  /** 发布者：谁维护这套解析（公司、项目组、个人都行） */
  publisher?: string;
  /** 版本号 */
  version?: string;
  /** 一句话说明这套解析在干什么 */
  summary?: string;
  /** 入口模块（相对插件目录），默认 index.mjs */
  entry?: string;
  /** 挂在哪套协议下（协议类型 id）：同一套协议有第二种实现时用它 */
  protocolId?: string;
  /** 插件自带的协议：只有这个开发者认这套协议时用它 */
  protocol?: {
    /** 协议类型名 */
    name: string;
    /** 一句话说明 */
    summary?: string;
    /** 怎么切帧 */
    framing: Framing;
    /** 怎么读（默认 utf8） */
    encoding?: ChannelEncoding;
    /** 该协议推荐的接入参数（如波特率） */
    defaults?: Record<string, string>;
  };
  /** 协议详情：帧结构、地址表、命令码表 */
  spec?: ProtocolSpec;
  /**
   * 这个插件自带的协议文档。
   *
   * 写插件目录里的一个 Markdown 文件名（如 `protocol.md`），
   * 装载时把它的内容读出来，界面上就按文档来读这套协议。
   */
  doc?: string;
}

/**
 * 插件对外的样子（给界面用，不含实现）。
 *
 * 界面上「解析插件类型」那个下拉，就是拿这些字段渲染的：
 * 名字、发布者、版本——让人知道这套解析是谁写的、是哪一版。
 */
export interface PluginSummary {
  id: string;
  name: string;
  /** 发布者 */
  publisher: string;
  /** 版本号 */
  version: string;
  summary?: string;
  /** 属于哪套协议（协议类型 id） */
  protocolId: string;
  /** 协议详情 */
  spec?: ProtocolSpec;
  /** 内置插件，还是外部发布的 */
  builtin: boolean;
  /** 外部插件的来源目录名 */
  source?: string;
}
