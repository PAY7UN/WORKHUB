/**
 * 工具区（接入与仿真）的共享类型。
 *
 * 工具区干的是同一件事：从串口进来的字节流里按一套协议拆出「一条条记录」。
 * 所以这里只定下四样东西：
 *
 * - ToolDef：工具长什么样（界面按它渲染表单，前端与服务端不会各说各话）
 * - ProtocolTemplate：按哪套协议拆帧
 * - ChannelSession：一次监听的运行态
 * - ChannelRecord：拆出来的一条记录
 *
 * 分清「工具」与「协议」是这套东西的关键：
 * 工具回答「字节从哪儿来」，协议回答「这串字节怎么切、切完怎么读」。
 * 两者各管各的，流水线（数据源 → 协议解析 → 记录）是共用的。
 *
 * 但共用流水线不等于共用清单：串口接的车载屏与网口接的定位终端
 * 不是一类设备，协议/plugin 各有各的适用范围（见 TransportScope）。
 */

/** 工具（通道）的种类 */
export type ToolKind = 'serial' | 'tcp';

/** 接入方式的名字：说人话，界面与报错都用它 */
export const TOOL_KIND_LABELS: Record<ToolKind, string> = {
  serial: '串口',
  tcp: '网口',
};

/**
 * 一套协议/插件**适用于哪些接入方式**。
 *
 * 串口接的车载屏与网口接的定位终端不是一套东西：
 * 通达 LED2 跑在串口上，JT/T 808 跑在 TCP 上。
 * 两边的协议清单本就不该是同一份——不然在网口监听里翻出一个
 * 车载屏协议，选了也只会解出乱码。
 *
 * 空 = 不挑，哪儿的口都能用（比如「不解析」与来路不明的第三方插件）。
 */
export type TransportScope = ToolKind[];

/** 这套协议/插件在这个接入方式下能不能用 */
export function appliesToTransport(scope: TransportScope | undefined, kind: ToolKind): boolean {
  if (!scope || scope.length === 0) return true;
  return scope.includes(kind);
}

/** 适用范围的说法：给界面与报错用 */
export function transportScopeText(scope: TransportScope | undefined): string {
  if (!scope || scope.length === 0) return '不限接入方式';
  return scope.map((k) => TOOL_KIND_LABELS[k]).join(' / ');
}

/** 接口类型：工具区按它分组，不按工具个数分组 */
export type ToolGroup = 'serial' | 'network';

export const TOOL_GROUP_LABELS: Record<ToolGroup, string> = {
  serial: '串口类',
  network: '网口类',
};

/**
 * 接入大类。
 *
 * 界面上先看到的是**大类**，不是四种接入方式：
 * 点一下「串口接入」就进全屏，进去了再定端口、波特率、协议与插件。
 * 大类少而好认（四种方式并排摆出来反而让人挑花眼），
 * 细节留到全屏界面里去定——那才是这些参数真正起作用的地方。
 */
export type ToolCategory = 'serial' | 'tcp';

/** 一个接入大类 */
export interface ToolCategoryDef {
  id: ToolCategory;
  /** 人看的名字，如「串口接入」 */
  name: string;
  /** 一句话说明这个大类在做什么 */
  summary: string;
  /** 卡片上摆的关键词：进去以后第一眼会看到什么 */
  hint: string;
  /** 这个大类下有哪几种接入方式 */
  kinds: ToolKind[];
}

/** 接入大类清单 */
export const CATEGORY_DEFS: ToolCategoryDef[] = [
  {
    id: 'serial',
    name: '串口接入',
    summary: '接一根线到本机设备：打开一个 COM 口，收它吐出来的字节。',
    hint: '端口 · 波特率 · 数据位 · 校验',
    kinds: ['serial'],
  },
  {
    id: 'tcp',
    name: '网口接入',
    summary: '走网络：要么开个端口等设备连进来（JT/T 808 终端就是这样连平台的），要么主动连到设备那边。',
    hint: '监听 · 连接 · 协议类型',
    kinds: ['tcp'],
  },
];

/** 按 id 找大类 */
export function findCategory(id: string): ToolCategoryDef | undefined {
  return CATEGORY_DEFS.find((c) => c.id === id);
}

/** 某个接入方式属于哪个大类 */
export function categoryOfKind(kind: ToolKind): ToolCategoryDef | undefined {
  return CATEGORY_DEFS.find((c) => c.kinds.includes(kind));
}

/** 表单字段的控件类型 */
export type ToolFieldType = 'text' | 'number' | 'select';

/** 一个下拉项 */
export interface ToolFieldOption {
  label: string;
  value: string;
}

/** 表单字段 */
export interface ToolField {
  key: string;
  label: string;
  type: ToolFieldType;
  required?: boolean;
  placeholder?: string;
  /** 这个字段该填什么 */
  help?: string;
  options?: ToolFieldOption[];
  defaultValue?: string;
  /** 选项由运行时给出（如本机串口列表） */
  dynamic?: 'serial-ports';
  /** 占满一整行（地址、路径这类长的字段用它） */
  wide?: boolean;
}

/** 一个工具 */
export interface ToolDef {
  id: ToolKind;
  name: string;
  group: ToolGroup;
  /** 一句话说明 */
  summary: string;
  /** 能不能往通道里发东西：串口能写 */
  canSend: boolean;
  /**
   * 这个接入方式「在跑」时该怎么说。
   *
   * 串口是接一根线到本机设备，说「服务器」「实例」都不对——它就是个监听。
   * 这个字眼得让工具自己说，别让界面统一按服务器讲。
   */
  activityLabel: string;
  fields: ToolField[];
}

/** 找出某个接入方式的定义 */
export function findTransport(kind: ToolKind): ToolDef | undefined {
  return TOOL_DEFS.find((t) => t.id === kind);
}

/** 串口参数 */
export interface SerialConfig {
  port: string;
  baudRate: number;
  dataBits: 5 | 6 | 7 | 8;
  stopBits: 1 | 1.5 | 2;
  parity: 'none' | 'even' | 'odd';
  flowControl: 'none' | 'rtscts';
}

/**
 * 网口参数。
 *
 * 两种模式，区别只在于「谁先动」：
 *
 * - listen（本机开端口，等对端连进来）：JT/T 808 就是这个路子——
 *   终端是客户端，平台是服务端，终端连上平台的 7612 端口。
 * - connect（本机主动连出去）：对端是个服务，本机当客户端。
 */
export interface TcpConfig {
  mode: 'listen' | 'connect';
  /** listen 时是本机绑的地址；connect 时是对端地址 */
  host: string;
  port: number;
}

/** 规范化后的运行参数 */
export type ChannelConfig = SerialConfig | TcpConfig;

/** 定界方式：怎么把字节流切成一条条 */
export type FramingKind = 'delimiter' | 'fixed' | 'length' | 'timeout';

/** 定界规则 */
export interface Framing {
  kind: FramingKind;
  /** delimiter：分隔符，十六进制串（如 "0d0a"） */
  delimiter?: string;
  /** fixed：每帧固定字节数 */
  fixedLength?: number;
  /** length：长度字段的位置与宽度 */
  lengthOffset?: number;
  lengthSize?: number;
  lengthEndian?: 'be' | 'le';
  /** 长度字段算不算它自己那几个字节 */
  lengthIncludesHeader?: boolean;
  /** timeout：空闲多久切一帧 */
  idleMs?: number;
}

/** 解码方式 */
export type ChannelEncoding = 'utf8' | 'latin1' | 'ascii' | 'hex';

/** 协议模板：定界 + 解码 */
export interface ProtocolTemplate {
  id: string;
  name: string;
  summary: string;
  framing: Framing;
  encoding: ChannelEncoding;
  /** 是否把整帧当 JSON 解析 */
  json?: boolean;
  /**
   * 具名解码器：自己会切帧、会读字段的那种协议（如通达 LED2）。
   *
   * 有它时 framing 只是占位——切帧规则写在解码器里，
   * 因为那些协议的长度字段含义、校验方式都不是通用规则能表达的。
   */
  decoder?: string;
  /** 该协议推荐的接入参数（如通达 LED2 要 38400/8N1） */
  defaults?: Record<string, string>;
  /**
   * 这套协议适用于哪些接入方式。
   *
   * 串口与网口是两种设备：车载屏在串口上，定位终端在网口上。
   * 写清楚了，界面才只给对的那一套解析插件——
   * 在网口监听里翻出一个车载屏协议，选了也只会解出乱码。
   *
   * 空 = 不挑，哪儿的口都能用。
   */
  transports?: TransportScope;
  /**
   * 这套协议的说明书在哪。
   *
   * 说明书住在记录区的内置目录里，「看文档」只有一处；
   * 工具区只拿一个引用，点过去就行。
   */
  doc?: ProtocolDocRef;
}

/**
 * 协议说明书的位置。
 *
 * 就是一份 Markdown：能贴进任何编辑器，也能被检索。
 */
export interface ProtocolDoc {
  /** 文档标题 */
  title?: string;
  /** Markdown 正文 */
  markdown: string;
  /** 这份文档从哪来 */
  origin?: 'builtin' | 'local';
  /** 存在哪儿（让人知道该去哪儿改） */
  path?: string;
}

/**
 * 协议说明书的引用。
 *
 * 工具区不拿正文，只拿这个：说明书的正文由记录区自己读，
 * 「看文档」这件事全站只有一处。
 */
export interface ProtocolDocRef {
  /** 记录区里这篇文档的节点 id */
  nodeId: string;
  /** 文档标题 */
  title: string;
  /** 内置版还是现场改过的 */
  origin: 'builtin' | 'local';
  /** 代码里的说明书有更新，且现场也改过——该合还是该换由人决定 */
  hasUpdate?: boolean;
}

/* ------------------------------ 协议详情 ------------------------------ */

/**
 * 协议详情。
 *
 * 选了哪套协议，屏幕上就该能把这套协议「具体长什么样」摊开：
 * 帧结构、地址表、命令码表、每条命令的数据区字段含义。
 *
 * 这些内容由**解码器**提供（它才是唯一懂这套协议的地方），
 * 经工具目录接口下发，界面只负责摆出来。
 */
export interface ProtocolSpec {
  /** 帧结构：每一段叫什么、占几个字节、是什么 */
  frame?: ProtocolFramePart[];
  /** 地址表（硬件地址、寄存器号……） */
  addresses?: ProtocolAddress[];
  /** 命令码表 */
  commands?: ProtocolCommand[];
  /** 通用说明（校验方式、编码约定……） */
  notes?: string[];
}

/** 帧结构里的一段 */
export interface ProtocolFramePart {
  /** 段名，如「帧头」 */
  name: string;
  /** 占几个字节，如「1 字节」「n 字节」 */
  bytes?: string;
  /** 这一段是什么 */
  desc: string;
}

/** 地址表里的一条 */
export interface ProtocolAddress {
  /** 地址值，如 0x02 */
  code: string;
  /** 中文名，如「车外腰牌」 */
  name: string;
  /** 补充说明 */
  note?: string;
}

/** 命令码表里的一条 */
export interface ProtocolCommand {
  /** 命令码，如 0x08 */
  code: string;
  /** 中文名，如「屏报站」 */
  name: string;
  /** 补充说明 */
  note?: string;
  /** 该命令数据区的字段含义 */
  fields?: Array<{ name: string; desc: string }>;
}

/**
 * 一条能组出来的命令。
 *
 * 「解析」是把收到的字节读成人话，「组包」是反过来：
 * 把人要的东西组装成字节发出去。两者共用一套协议知识，
 * 所以能组什么、每条要填哪些参数，都由解码器说了算——
 * 界面照着这份清单渲染表单，不自己猜。
 */
export interface ProtocolBuild {
  /** 命令 id：组包时用它指明要组哪一条 */
  kind: string;
  /** 人看的名字，如「平台注册应答」 */
  name: string;
  /**
   * 协议里的消息 ID，如 `0x8101`。
   *
   * 组包时人挑的是「发哪一条协议消息」——那个 ID 得看得见，
   * 否则挑了「文本信息下发」也不知道发出去的是 0x8101。
   */
  code?: string;
  /** 方向：平台发下去的是 `down`，终端报上来的是 `up` */
  dir?: 'up' | 'down';
  /**
   * 正文得由人自己按字节定义吗？
   *
   * 协议清单里没有的消息就是这样：消息 ID 人给，
   * 正文也得人一行一个字段地定义（名字、类型、宽度、值）。
   */
  custom?: boolean;
  /** 一句话说明这条命令干什么 */
  desc?: string;
  /** 要填哪些参数 */
  fields?: ProtocolBuildField[];
}

/**
 * 组包字段的类型：决定人怎么填、占几个字节。
 *
 * 整数字段分两族：
 *
 * - `u8` / `u16` / `u32`：按**十进制**填（`0x` 开头也能认）。
 * - `hexU8` / `hexU16` / `hexU32`：按**十六进制**填。
 *
 * 为什么单开一族：消息 ID 在 JT/T 808 里历来写成 `0x8101`，
 * 人按十进制填 `8101` 会被当成 33025（0x1FA5）——
 * 一个完全合法却完全错误的消息 ID，静默发出去。
 * 类型写清楚，界面上就按十六进制校验，不给人犯糊涂的机会。
 */
export type BuildFieldType =
  | 'u8'
  | 'u16'
  | 'u32'
  | 'hexU8'
  | 'hexU16'
  | 'hexU32'
  | 'text'
  | 'hex';

/** 组包命令的一个参数 */
export interface ProtocolBuildField {
  key: string;
  label: string;
  placeholder?: string;
  defaultValue?: string;
  required?: boolean;
  /** 这个参数怎么理解 */
  help?: string;
  /**
   * 这个字段怎么填、占几个字节。
   *
   * 光有名字猜不出宽度——「序列号」是 1 字节还是 2 字节？
   * 写清楚了，界面上就能按字节校验，填错当场拦下，
   * 而不是发出去一帧废数据等终端不理。
   */
  type?: BuildFieldType;
  /** 定长字段占几个字节 */
  bytes?: number;
  /** 变长字段最多几个字节 */
  maxBytes?: number;
  /** 字节序，默认大端 */
  endian?: 'be' | 'le';
}

/**
 * 自定义消息里人自己定义的一个字段。
 *
 * 上面的清单是协议写死的；这条消息协议里没有，
 * 那字段就得由人按字节定义——名字、类型、宽度、值，
 * 服务端照着拼成正文。
 */
export interface CustomBuildField {
  /** 字段名：给人看的 */
  name: string;
  /** 类型 */
  type: BuildFieldType;
  /** 占几个字节（变长类型给上限） */
  bytes?: number;
  /** 字节序，默认大端 */
  endian?: 'be' | 'le';
  /** 值 */
  value: string;
}

/**
 * 帧的一段：发出去的字节按协议切成几段，一段一个意思。
 *
 * 「可靠」不是嘴上说的——得让人逐段核对：
 * 消息 ID 对不对、长度填得对不对、校验码算得对不对。
 * 一整串十六进制看的人眼花，切成几段就一眼看得出来。
 */
export interface FrameSegment {
  /** 这一段叫什么 */
  name: string;
  /** 这一段的字节（十六进制，不带空格） */
  hex: string;
}

/**
 * 调试模式用的模板。
 *
 * 开通道时**不选协议**就走它：收到什么算什么，原样记下来。
 * 现场还说不清设备是哪一套协议时，先这么看着——总比硬套一套协议、
 * 把看不懂的字节硬解读成错的内容强。
 */
export const RAW_PROTOCOL_ID = 'raw';

export const RAW_TEMPLATE: ProtocolTemplate = {
  id: RAW_PROTOCOL_ID,
  name: '原始字节（不解析）',
  summary: '收到什么算什么，空闲 200ms 切一条，不做协议解析。',
  framing: { kind: 'timeout', idleMs: 200 },
  encoding: 'hex',
};

/**
 * 内置协议模板。
 *
 * 只留两条：**不解析**（调试时看原始字节）与**具名解码器**（通达 LED2）。
 *
 * 曾经还内置过一批通用定界模板（文本行、JSON 行、十六进制行、定长 16 字节、长度前缀），
 * 现在全删了：它们谁也不像——真按「定长 16 字节」跑的协议，帧里各字段是什么意思
 * 还得自己认，套个通用定界只得到一串看不懂的字节，反而更费事。
 * 现场说不清用哪套协议时，就用「不解析」看着；要认协议，就配一个具名解码器
 * （切帧规则与字段含义一起写清），再在这里加一条模板。
 */
export const BUILTIN_TEMPLATES: ProtocolTemplate[] = [
  RAW_TEMPLATE,
  {
    id: 'tongda-led2',
    name: '通达 LED2',
    summary:
      '通达 LED2 车载屏协议：帧头 BB、硬件地址、长度、命令码、数据、16 位小端校验和、帧尾 55。' +
      '按命令把数据读成中文（线路名、站名、时间、票价…）。串口 38400/8N1。',
    // 具名解码器自带切帧规则，这里的 framing 只是占位
    framing: { kind: 'timeout', idleMs: 200 },
    encoding: 'hex',
    decoder: 'tongda-led2',
    // 车载屏是插在本机串口上的设备，不是网络协议
    transports: ['serial'],
    defaults: { baudRate: '38400', dataBits: '8', stopBits: '1', parity: 'none', flowControl: 'none' },
  },
  {
    id: 'jt-t808',
    name: 'JT/T 808（道路运输车辆卫星定位系统）',
    summary:
      'JT/T 808-2019：帧标志 7E、消息体属性、序列号、消息 ID、数据长度、异或校验，包内有 7E/7D 要转义。' +
      '终端注册、心跳、位置等消息读成字段；平台自动回注册应答与心跳应答，也能按命令组包下发。',
    // 具名解码器自带切帧规则，这里的 framing 只是占位
    framing: { kind: 'timeout', idleMs: 200 },
    encoding: 'hex',
    decoder: 'jt-t808',
    // 终端是客户端、平台是服务端：走的是 TCP，不是串口线
    transports: ['tcp'],
    defaults: { mode: 'listen', host: '0.0.0.0', port: '7612' },
  },
];

/** 按 id 找内置模板 */
export function findTemplate(id: string): ProtocolTemplate | undefined {
  return BUILTIN_TEMPLATES.find((t) => t.id === id);
}

/** 记录的方向：收进来的还是发出去的 */
export type ChannelDirection = 'in' | 'out';

/**
 * 解出来的一个字段。
 *
 * 具名解码器（如通达 LED2）把一帧读成若干个「名字 → 值」：
 * 界面上直接列出来，比让人自己对着十六进制猜要省事得多。
 */
export interface DecodedField {
  /** 字段名，如「报站内容」 */
  key: string;
  /** 字段值（人话） */
  value: string;
  /** 原始字节，看不懂时能对着查 */
  raw?: string;
}

/** 拆出来的一条记录 */
export interface ChannelRecord {
  /** 会话内递增的序号：界面拿它当增量游标 */
  id: number;
  ts: number;
  direction: ChannelDirection;
  /** 对端标识（串口上一般是设备名或口名） */
  peer?: string;
  bytes: number;
  /** 按模板解码后的文本 */
  text: string;
  /** 原始字节的十六进制 */
  hex: string;
  /** 模板要求按 JSON 解析时的结构化结果 */
  parsed?: unknown;
  /** 具名解码器读出来的字段列表 */
  fields?: DecodedField[];
  /** 具名解码器给出的摘要（如「车外腰牌 · 报站内容」） */
  summary?: string;
}

/** 通道的运行态 */
export type ChannelStatus = 'running' | 'stopped' | 'error';

/** 一次监听的运行态 */
export interface ChannelSession {
  id: string;
  tool: ToolKind;
  /** 人看的名字，如 "COM3 · 115200" */
  name: string;
  status: ChannelStatus;
  /** 出错时的原因 */
  error?: string;
  startedAt: number;
  stoppedAt?: number;
  /** 规范化后的运行参数 */
  config: Record<string, string>;
  templateId: string;
  /**
   * 这一条通道用的是哪个解析插件。
   *
   * 空 = 调试模式（只记原始字节）；有值 = 那个插件切的帧、读的字段。
   * 记在会话上，是为了让控制台能说清「这屏数据是谁解的」。
   */
  pluginId?: string;
  /**
   * 这条通道能组哪些命令。
   *
   * 「解析」是把收到的字节读成人话，「组包」反过来：给人几个参数，
   * 组装成字节发出去。能组什么、每条要填哪些参数，由解析插件说了算——
   * 界面照着这份清单渲染表单，不自己猜协议。
   *
   * 空 = 这套协议只能读，不能组。
   */
  builds?: ProtocolBuild[];
  recordCount: number;
  bytesIn: number;
  bytesOut: number;
  /** 对端标识列表（串口上一般是设备名或口名） */
  peers: string[];
  /** 是否记录收到的数据 */
  recordIn: boolean;
  /** 是否记录发出的数据 */
  recordOut: boolean;
}

/** 本机串口信息 */
export interface SerialPortInfo {
  path: string;
  manufacturer?: string;
  serialNumber?: string;
  productId?: string;
  vendorId?: string;
  /**
   * 这个口是从哪儿发现的。
   *
   * device：serialport 直接枚举到的真设备。
   * registry：Windows 系统登记的 COM 口（虚拟串口、蓝牙口这类 serialport 未必认得）。
   */
  source?: 'device' | 'registry';
}

/* ------------------------------ 工具目录 ------------------------------ */

const BAUD_OPTIONS: ToolFieldOption[] = [9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600].map((v) => ({
  label: String(v),
  value: String(v),
}));

/**
 * 工具目录。
 *
 * 按接口类型分组，每种接口只留真正有用的那一个：
 * 串口只有一个「监听」——串口天然是收发的，开一个口就同时在收、在写。
 */
export const TOOL_DEFS: ToolDef[] = [
  {
    id: 'serial',
    name: '串口监听',
    group: 'serial',
    summary: '打开一个串口，收它吐出来的字节，按协议模板拆成一条条记录。',
    canSend: true,
    activityLabel: '在监听',
    fields: [
      {
        key: 'port',
        label: '串口',
        type: 'select',
        required: true,
        dynamic: 'serial-ports',
        wide: true,
        placeholder: 'COM3',
        help: '下拉里是本机当前可用的串口；也可以直接填路径。',
      },
      { key: 'baudRate', label: '波特率', type: 'select', options: BAUD_OPTIONS, defaultValue: '115200' },
      {
        key: 'dataBits',
        label: '数据位',
        type: 'select',
        options: [5, 6, 7, 8].map((v) => ({ label: String(v), value: String(v) })),
        defaultValue: '8',
      },
      {
        key: 'stopBits',
        label: '停止位',
        type: 'select',
        options: [
          { label: '1', value: '1' },
          { label: '1.5', value: '1.5' },
          { label: '2', value: '2' },
        ],
        defaultValue: '1',
      },
      {
        key: 'parity',
        label: '校验',
        type: 'select',
        options: [
          { label: '无', value: 'none' },
          { label: '偶', value: 'even' },
          { label: '奇', value: 'odd' },
        ],
        defaultValue: 'none',
      },
      {
        key: 'flowControl',
        label: '流控',
        type: 'select',
        options: [
          { label: '无', value: 'none' },
          { label: 'RTS+CTS', value: 'rtscts' },
        ],
        defaultValue: 'none',
      },
    ],
  },
  {
    id: 'tcp',
    name: '网口监听',
    group: 'network',
    summary: '开一个 TCP 端口等设备连进来，或主动连到对端；收发的字节按协议模板拆成一条条记录。',
    canSend: true,
    activityLabel: '在监听',
    fields: [
      {
        key: 'mode',
        label: '方式',
        type: 'select',
        required: true,
        options: [
          { label: '监听（等设备连进来）', value: 'listen' },
          { label: '连接（主动连过去）', value: 'connect' },
        ],
        defaultValue: 'listen',
        help: 'JT/T 808 终端是主动连平台的，所以平台这边选「监听」。',
      },
      {
        key: 'port',
        label: '端口',
        type: 'number',
        required: true,
        defaultValue: '7612',
        help: 'JT/T 808 常用 7612。',
      },
      {
        key: 'host',
        label: '地址',
        type: 'text',
        wide: true,
        defaultValue: '0.0.0.0',
        help: '监听时是本机绑哪个网卡（0.0.0.0 = 全部）；连接时是对端地址。',
      },
    ],
  },
];

/** 按 id 找工具 */
export function findTool(id: string): ToolDef | undefined {
  return TOOL_DEFS.find((t) => t.id === id);
}
