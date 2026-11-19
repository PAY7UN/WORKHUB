/**
 * JT/T 808（道路运输车辆卫星定位系统）解码器。
 *
 * 帧结构（JT/T 808-2019）：
 *
 *   0x7E | 消息体属性(2) | 序列号(2) | 消息ID(4) | 数据长度(4) | 消息体(n) | 校验码(1) | 0x7E
 *
 * - 消息体属性：bit0~9 是消息体长度，bit13 加密，bit14 分包，其余保留为 0
 * - 数据长度：消息体长度（不含校验码），4 字节大端
 * - 校验码：消息体属性到消息体末尾逐字节异或
 * - 转义：包内出现 0x7E → 0x7D 0x01，0x7D → 0x7D 0x02，0x7F → 0x7D 0x04（2019 版新增）
 *
 * 平台这一侧要做三件事，这份文件就是这三件事的实现：
 *
 * 1. **网络注册**：终端连上平台后先发「终端注册」（0x0001），平台得回「注册应答」
 *    （0x8001）；之后终端定时发心跳（0x0002），平台回心跳应答（0x8002）。
 *    这套一来一回就是网络注册——不回，终端会一直重发。
 * 2. **解析**：注册、心跳、位置、车辆状态等消息读成字段。
 * 3. **组包**：平台也能往下发（注册应答、心跳应答、通用应答、文本信息…）。
 *
 * 终端身份靠连接区分：JT/T 808 终端是客户端，一个终端一条连接，
 * 所以「哪条连接」就是「哪个终端」，注册消息里的终端编号只是补个名字。
 */
import type { DecodedField, ProtocolBuild, ProtocolFramePart } from '../../../shared/tools.ts';
import type { EncodeRequest } from '../parser.ts';
import { parseHex, toHex } from '../parser.ts';

/** 解码器 id */
export const JT808_DECODER_ID = 'jt-t808';

/** 帧结构（给协议详情用） */
export const JT808_FRAME_PARTS: ProtocolFramePart[] = [
  { name: '帧标志', bytes: '1 字节', desc: '0x7E，包头包尾各一个' },
  { name: '消息体属性', bytes: '2 字节', desc: 'bit0~9 消息体长度，bit13 加密，bit14 分包，其余保留为 0' },
  { name: '序列号', bytes: '2 字节', desc: '每包递增，0-65535 循环；应答要跟被应答的那一帧对上' },
  { name: '消息 ID', bytes: '4 字节', desc: '0x0001 终端注册、0x0002 心跳、0x0200 位置、0x8001 平台注册应答……' },
  { name: '数据长度', bytes: '4 字节', desc: '正文长度，不含校验码' },
  { name: '消息体', bytes: 'n 字节', desc: '按消息 ID 解释；加密位为 1 时是密文' },
  { name: '校验码', bytes: '1 字节', desc: '消息体属性到正文末字节逐字节异或' },
  { name: '帧标志', bytes: '1 字节', desc: '0x7E' },
];

/** 帧标志（包头包尾） */
export const JT808_FLAG = 0x7e;

/** 转义标志 */
export const JT808_ESC = 0x7d;

/** 消息头长度：消息体属性(2) + 序列号(2) + 消息ID(4) + 数据长度(4) */
const HEADER_LEN = 12;

/** 单帧上限：超过这个长度就不像是帧了，丢掉重找 */
const MAX_FRAME = 64 * 1024;

/** 消息 ID → 名称与方向 */
export const JT808_MESSAGES: Record<number, { name: string; dir: 'up' | 'down'; note?: string }> = {
  0x0001: { name: '终端注册', dir: 'up', note: '终端连上平台后发的第一条消息' },
  0x0002: { name: '终端心跳', dir: 'up', note: '定时发，告诉平台自己还活着' },
  0x0003: { name: '终端注销', dir: 'up' },
  0x0004: { name: '终端通用应答', dir: 'up' },
  0x0005: { name: '终端补注册', dir: 'up', note: '注册应答没收到时补发' },
  0x0200: { name: '位置信息', dir: 'up' },
  0x0201: { name: '位置信息补报', dir: 'up' },
  0x0300: { name: '车辆状态信息', dir: 'up' },
  0x8001: { name: '平台注册应答', dir: 'down' },
  0x8002: { name: '平台心跳应答', dir: 'down' },
  0x8003: { name: '平台注销应答', dir: 'down' },
  0x8004: { name: '平台通用应答', dir: 'down' },
  0x8005: { name: '平台补注册应答', dir: 'down' },
  0x8100: { name: '车辆控制命令', dir: 'down' },
  0x8101: { name: '文本信息下发', dir: 'down' },
  0x8102: { name: '查询车载终端设备信息', dir: 'down' },
  0x8103: { name: '实时位置查询', dir: 'down' },
  0x8104: { name: '远程设置参数', dir: 'down' },
  0x8105: { name: '终端注册状态查询', dir: 'down' },
  0x8106: { name: '查询卫星定位状态', dir: 'down' },
  0x8107: { name: '查询导航信息', dir: 'down' },
  0x8108: { name: '请求终端漫游', dir: 'down' },
  0x8109: { name: '请求人工监听车辆', dir: 'down' },
  0x8110: { name: '查询车辆信号灯', dir: 'down' },
};

/** 消息 ID → 该消息正文的字段含义（给协议详情用） */
export const JT808_COMMAND_FIELDS: Record<number, Array<{ name: string; desc: string }>> = {
  0x0001: [
    { name: '省份编码', desc: '2 字节，BCD' },
    { name: '市域编码', desc: '2 字节，BCD' },
    { name: '制造商编码', desc: '11 字节，ASCII' },
    { name: '终端型号', desc: '30 字节，ASCII' },
    { name: '终端编号', desc: '15 字节，ASCII（通常是 IMEI）' },
    { name: '固件版本号', desc: '20 字节，ASCII' },
    { name: '终端 SIM 卡号', desc: '20 字节，BCD' },
    { name: '终端认证类型', desc: '1 字节，2019 版新增' },
  ],
  0x0002: [{ name: '（无正文）', desc: '心跳没有正文，收到就回一个心跳应答' }],
  0x0003: [{ name: '（无正文）', desc: '终端主动注销' }],
  0x0004: [
    { name: '应答序列号', desc: '2 字节，被应答消息的序列号' },
    { name: '应答消息 ID', desc: '2 字节，被应答的是哪条消息' },
    { name: '结果', desc: '1 字节，0 成功 1 失败' },
    { name: '失败原因', desc: '1 字节，仅失败时存在' },
  ],
  0x0005: [
    { name: '省份编码', desc: '2 字节，BCD' },
    { name: '市域编码', desc: '2 字节，BCD' },
    { name: '制造商编码', desc: '11 字节，ASCII' },
    { name: '终端型号', desc: '30 字节，ASCII' },
    { name: '终端编号', desc: '15 字节，ASCII（通常是 IMEI）' },
    { name: '固件版本号', desc: '20 字节，ASCII' },
    { name: '终端 SIM 卡号', desc: '20 字节，BCD' },
  ],
  0x0200: [
    { name: '标志', desc: '1 字节' },
    { name: '经度', desc: '4 字节，有符号，单位 1e-6 度' },
    { name: '纬度', desc: '4 字节，有符号，单位 1e-6 度' },
    { name: '高度', desc: '2 字节，有符号，单位 0.1 米' },
    { name: '速度', desc: '2 字节，单位 0.1 千米/小时（低 12 位是速度，高 4 位是定位速度状态）' },
    { name: '方向', desc: '2 字节，0-360 度' },
    { name: '定位时间', desc: '6 字节，BCD，YYMMDDHHmmss' },
    { name: '卫星数', desc: '1 字节' },
    { name: '定位状态', desc: '1 字节' },
  ],
  0x0201: [{ name: '同位置信息', desc: '补报的正文与位置信息一致' }],
  0x0300: [
    { name: '车辆状态', desc: '1 字节，8 个状态位' },
    { name: '扩展车辆状态', desc: '1 字节，8 个状态位' },
  ],
  0x8001: [
    { name: '应答序列号', desc: '2 字节，终端注册那一帧的序列号' },
    { name: '应答标志', desc: '1 字节，0 成功 1 失败' },
    { name: '失败原因', desc: '1 字节，仅失败时存在' },
    { name: '鉴权码', desc: '16 字节，2019 版可选' },
  ],
  0x8002: [{ name: '（无正文）', desc: '心跳应答没有正文' }],
  0x8003: [{ name: '（无正文）', desc: '注销应答没有正文' }],
  0x8004: [
    { name: '应答序列号', desc: '2 字节' },
    { name: '应答消息 ID', desc: '2 字节，被应答的是哪条消息' },
    { name: '结果', desc: '1 字节，0 成功 1 失败' },
    { name: '失败原因', desc: '1 字节，仅失败时存在' },
  ],
  0x8005: [
    { name: '应答序列号', desc: '2 字节，终端补注册那一帧的序列号' },
    { name: '应答标志', desc: '1 字节，0 成功 1 失败' },
    { name: '失败原因', desc: '1 字节，仅失败时存在' },
    { name: '鉴权码', desc: '16 字节，2019 版可选' },
  ],
  0x8100: [
    { name: '指令字', desc: '1 字节，指令编号' },
    { name: '指令参数', desc: '变长，依指令字而定' },
  ],
  0x8101: [
    { name: '标志', desc: '1 字节' },
    { name: '文本信息', desc: '变长，GBK 编码' },
  ],
  0x8102: [{ name: '（无正文）', desc: '查询命令没有正文' }],
  0x8103: [{ name: '（无正文）', desc: '查询命令没有正文' }],
  0x8104: [
    { name: '参数标识', desc: '4 字节，参数 ID' },
    { name: '数据体', desc: '变长，参数的值，长度依参数而定' },
  ],
  0x8105: [{ name: '（无正文）', desc: '查询命令没有正文' }],
  0x8106: [{ name: '（无正文）', desc: '查询命令没有正文' }],
  0x8107: [{ name: '（无正文）', desc: '查询命令没有正文' }],
  0x8108: [{ name: '（无正文）', desc: '查询命令没有正文' }],
  0x8109: [{ name: '（无正文）', desc: '查询命令没有正文' }],
  0x8110: [{ name: '（无正文）', desc: '查询命令没有正文' }],
};

/* ------------------------------ 字节与文本 ------------------------------ */

/** ASCII 字符串：砍掉尾部空格与 NUL */
function ascii(bytes: Buffer): string {
  return bytes.toString('latin1').replace(/\0/g, '').trimEnd();
}

/** BCD：一个字节两位十六进制（半字节超 9 的按 F 记，便于看出不是 BCD） */
function bcd(bytes: Buffer): string {
  let out = '';
  for (const b of bytes) {
    out += (b >> 4).toString(16).toUpperCase();
    out += (b & 0x0f).toString(16).toUpperCase();
  }
  return out;
}

/** BCD 时间 YYMMDDHHmmss */
function bcdTime(bytes: Buffer): string {
  const s = bcd(bytes);
  if (s.length < 12) return s;
  const yy = Number(s.slice(0, 2));
  const year = yy >= 80 ? 1900 + yy : 2000 + yy;
  return `${year}-${s.slice(2, 4)}-${s.slice(4, 6)} ${s.slice(6, 8)}:${s.slice(8, 10)}:${s.slice(10, 12)}`;
}

/** GBK 解码器（Node 自带 ICU，认 GBK；万一环境没有就退回单字节） */
let gbkDecoder: InstanceType<typeof TextDecoder> | null = null;
function decodeGbk(bytes: Buffer): string {
  try {
    if (!gbkDecoder) gbkDecoder = new TextDecoder('gbk');
    return gbkDecoder.decode(bytes).replace(/\0/g, '').trimEnd();
  } catch {
    return bytes.toString('latin1').replace(/\0/g, '').trimEnd();
  }
}

/** 十六进制（大写） */
function hex(bytes: Buffer): string {
  return toHex(bytes);
}

/* ------------------------------ 转义与校验 ------------------------------ */

/**
 * 转义：包内出现 0x7E / 0x7D / 0x7F 要变成两字节。
 *
 * 不转义的话，包里的 0x7E 会被当成帧尾，一帧就被劈成两半。
 */
export function escapeJt808(bytes: Buffer, escape0x7f = true): Buffer {
  const out: number[] = [];
  for (const b of bytes) {
    if (b === 0x7e) out.push(JT808_ESC, 0x01);
    else if (b === JT808_ESC) out.push(JT808_ESC, 0x02);
    else if (b === 0x7f && escape0x7f) out.push(JT808_ESC, 0x04);
    else out.push(b);
  }
  return Buffer.from(out);
}

/** 解转义 */
export function unescapeJt808(bytes: Buffer): Buffer {
  const out: number[] = [];
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (b !== JT808_ESC) {
      out.push(b);
      continue;
    }
    const next = bytes[i + 1];
    if (next === undefined) {
      // 落单的 0x7D：不是转义序列，原样留着
      out.push(b);
      break;
    }
    if (next === 0x01) {
      out.push(0x7e);
      i++;
    } else if (next === 0x02) {
      out.push(JT808_ESC);
      i++;
    } else if (next === 0x04) {
      out.push(0x7f);
      i++;
    } else {
      out.push(b);
    }
  }
  return Buffer.from(out);
}

/** 异或校验码：消息体属性到消息体末尾逐字节异或 */
export function jt808Checksum(bytes: Buffer): number {
  let sum = 0;
  for (const b of bytes) sum ^= b;
  return sum & 0xff;
}

/* ------------------------------ 组包 ------------------------------ */

/** 组一帧的参数 */
export interface Jt808FrameOptions {
  /** 消息 ID */
  messageId: number;
  /** 正文 */
  body?: Buffer;
  /** 序列号 */
  seq?: number;
  /** 0x7F 要不要转义（2019 版要，老设备多半不转） */
  escape0x7f?: boolean;
}

/**
 * 组一帧完整的 JT/T 808 报文（含包头包尾与校验码）。
 *
 * 这是「组包」的底子：把正文装进消息头，算好校验码，转义后两头各加一个 0x7E。
 */
export function buildJt808Frame(opts: Jt808FrameOptions): Buffer {
  const body = opts.body ?? Buffer.alloc(0);
  const seq = (opts.seq ?? 0) & 0xffff;
  const header = Buffer.alloc(HEADER_LEN);
  header.writeUInt16BE(body.length & 0x3ff, 0);
  header.writeUInt16BE(seq, 2);
  header.writeUInt32BE(opts.messageId >>> 0, 4);
  header.writeUInt32BE(body.length, 8);

  const inner = Buffer.concat([header, body]);
  const frame = Buffer.concat([inner, Buffer.from([jt808Checksum(inner)])]);
  const escaped = escapeJt808(frame, opts.escape0x7f ?? true);
  return Buffer.concat([Buffer.from([JT808_FLAG]), escaped, Buffer.from([JT808_FLAG])]);
}

/* ------------------------------ 切帧 ------------------------------ */

/** 读出来的消息头 */
export interface Jt808Header {
  messageId: number;
  seq: number;
  attrs: number;
  /** 数据长度字段里写的正文长度 */
  declaredLength: number;
  /** 实际正文长度 */
  bodyLength: number;
  encrypted: boolean;
  subPackage: boolean;
  checksumOk: boolean;
  /** 长度字段与实际长度对不上 */
  lengthMismatch: boolean;
}

/** 读消息头（frame 是解转义后的完整帧，不含两端 0x7E） */
export function parseJt808Header(frame: Buffer): Jt808Header | null {
  if (frame.length < HEADER_LEN + 1) return null;
  const attrs = frame.readUInt16BE(0);
  const seq = frame.readUInt16BE(2);
  const messageId = frame.readUInt32BE(4);
  const declaredLength = frame.readUInt32BE(8);
  const bodyLength = frame.length - HEADER_LEN - 1;
  const checksumOk = jt808Checksum(frame.subarray(0, frame.length - 1)) === frame[frame.length - 1];
  return {
    messageId,
    seq,
    attrs,
    declaredLength,
    bodyLength,
    encrypted: ((attrs >> 13) & 1) === 1,
    subPackage: ((attrs >> 14) & 1) === 1,
    checksumOk,
    lengthMismatch: declaredLength !== bodyLength,
  };
}

/** 一个分包消息的收集状态 */
interface SubGroup {
  total: number;
  parts: Map<number, Buffer>;
}

/**
 * JT/T 808 切帧器。
 *
 * 帧头帧尾都是 0x7E，包内的 0x7E 都被转义成了 0x7D 0x01，
 * 所以直接找 0x7E 当边界是安全的。
 *
 * 分包（消息体属性 bit14）会在这里拼回去：正文前 4 个字节是
 * 「包序号 + 总包数」，收齐了才吐一条完整消息。
 */
export class Jt808Parser {
  private buffer: Buffer = Buffer.alloc(0);
  /** 分包收集：消息 ID → 已收到的分包 */
  private readonly groups = new Map<number, SubGroup>();

  /** 喂进一段字节，返回本次能确定的完整帧 */
  push(chunk: Buffer): Buffer[] {
    if (!chunk.length) return [];
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;

    const frames: Buffer[] = [];
    for (;;) {
      const start = this.buffer.indexOf(JT808_FLAG);
      if (start === -1) {
        // 一个帧标志都没有：全是噪声
        this.buffer = Buffer.alloc(0);
        break;
      }
      if (start > 0) this.buffer = this.buffer.subarray(start); // 丢掉前面的噪声

      const end = this.buffer.indexOf(JT808_FLAG, 1);
      if (end === -1) {
        // 帧尾还没到，等下一段
        if (this.buffer.length > MAX_FRAME) this.buffer = Buffer.alloc(0);
        break;
      }

      const inner = this.buffer.subarray(1, end);
      this.buffer = this.buffer.subarray(end + 1);

      const raw = unescapeJt808(inner);
      if (raw.length < HEADER_LEN + 1) continue; // 太短，不是一帧

      const frame = this.mergeSubPackage(raw);
      if (frame) frames.push(frame);
    }
    return frames;
  }

  /** 结束（或空闲超时）时把残余吐出来 */
  flush(): Buffer[] {
    const rest = this.buffer;
    this.buffer = Buffer.alloc(0);
    return rest.length ? [rest] : [];
  }

  /** 还压在手里的字节数 */
  pending(): number {
    return this.buffer.length;
  }

  /**
   * 分包拼包：收齐了返回一条完整消息，没收齐返回 null。
   *
   * 拼好的是一条**重新组装的**消息：正文完整了，校验码也算过了。
   * 和线上那几个分包长得不一样是正常的——记录里看的是拼好的整条。
   */
  private mergeSubPackage(raw: Buffer): Buffer | null {
    const header = parseJt808Header(raw);
    if (!header) return null;
    if (!header.subPackage) return raw;

    const body = raw.subarray(HEADER_LEN, raw.length - 1);
    if (body.length < 4) return raw; // 说是分包却没有包序号，放弃拼

    const index = body.readUInt16BE(0);
    const total = body.readUInt16BE(2);
    const data = body.subarray(4);
    if (total === 0) return raw;

    let group = this.groups.get(header.messageId);
    // 新的分包消息（序号回到开头，或总包数变了）：重新收
    if (!group || group.total !== total || index <= 1) {
      group = { total, parts: new Map() };
      this.groups.set(header.messageId, group);
    }
    group.parts.set(index, data);
    if (group.parts.size < group.total) return null;

    const chunks: Buffer[] = [];
    for (let i = 1; i <= group.total; i++) {
      const part = group.parts.get(i);
      if (!part) return null; // 缺包，等着
      chunks.push(part);
    }
    this.groups.delete(header.messageId);
    const rebuilt = buildJt808Frame({
      messageId: header.messageId,
      body: Buffer.concat(chunks),
      seq: header.seq,
    });
    // 去掉两端的 0x7E：切帧器吐出来的是「解转义后的裸帧」，
    // 拼好的包也得是裸帧——同一批帧两种形状，下游就得写两套读法。
    return rebuilt.subarray(1, rebuilt.length - 1);
  }
}

/* ------------------------------ 解析 ------------------------------ */

/** 解析结果 */
export interface Jt808Decoded {
  messageId: number;
  messageName: string;
  seq: number;
  encrypted: boolean;
  checksumOk: boolean;
  fields: DecodedField[];
  /** 平台该自动回给终端的字节 */
  reply?: { data: Buffer; note: string };
}

/** 位置信息的定位状态位 */
function positionStatus(byte: number): string {
  const parts: string[] = [];
  parts.push((byte & 0x01) === 1 ? '定位有效' : '定位无效');
  parts.push((byte & 0x02) === 0 ? '北纬' : '南纬');
  parts.push((byte & 0x04) === 0 ? '东经' : '西经');
  return parts.join('，');
}

/** 车辆状态位（2019 版） */
const VEHICLE_STATUS_BITS = [
  '紧急报警',
  '超速报警',
  '疲劳驾驶',
  '危险信号',
  'GNSS 模块故障',
  'GNSS 天线未接',
  'GNSS 天线短路',
  '终端蓄电池欠压',
];

/** 扩展车辆状态位（2019 版，后 4 位标准里是保留） */
const VEHICLE_EXT_BITS = ['补充电状态', '主电源状态', '燃油液位低', '油路异常', '保留', '保留', '保留', '保留'];

/** 读状态位：哪些位是 1 */
function statusBits(byte: number, names: string[]): string {
  const on = names.filter((_, i) => ((byte >> i) & 1) === 1);
  return on.length ? on.join('，') : '无';
}

/** 解析终端注册/补注册的正文 */
function decodeRegister(body: Buffer): DecodedField[] {
  const fields: DecodedField[] = [];
  const slice = (offset: number, len: number) => body.subarray(offset, offset + len);
  const push = (key: string, value: string, raw?: Buffer) => {
    fields.push({ key, value, raw: raw ? hex(raw) : undefined });
  };

  if (body.length >= 4) {
    push('省份编码', bcd(slice(0, 2)), slice(0, 2));
    push('市域编码', bcd(slice(2, 2)), slice(2, 2));
  }
  if (body.length >= 15) push('制造商编码', ascii(slice(4, 11)), slice(4, 11));
  if (body.length >= 45) push('终端型号', ascii(slice(15, 30)), slice(15, 30));
  if (body.length >= 60) push('终端编号', ascii(slice(45, 15)), slice(45, 15));
  if (body.length >= 80) push('固件版本号', ascii(slice(60, 20)), slice(60, 20));
  if (body.length >= 100) push('SIM 卡号', bcd(slice(80, 20)), slice(80, 20));
  if (body.length >= 101) push('终端认证类型', String(body[100]));
  if (!fields.length) fields.push({ key: '正文', value: `只有 ${body.length} 字节，不够一帧注册信息` });
  return fields;
}

/** 解析位置信息正文 */
function decodePosition(body: Buffer): DecodedField[] {
  const fields: DecodedField[] = [];
  if (body.length < 23) {
    fields.push({ key: '正文', value: `只有 ${body.length} 字节，不够一帧位置信息` });
    return fields;
  }
  const lon = body.readInt32BE(1) / 1e6;
  const lat = body.readInt32BE(5) / 1e6;
  const altitude = body.readInt16BE(9) / 10;
  const speedRaw = body.readUInt16BE(11);
  const speed = (speedRaw & 0x0fff) / 10;
  const direction = body.readUInt16BE(13);
  const time = bcdTime(body.subarray(15, 21));

  fields.push({ key: '经度', value: `${lon.toFixed(6)}°`, raw: hex(body.subarray(1, 5)) });
  fields.push({ key: '纬度', value: `${lat.toFixed(6)}°`, raw: hex(body.subarray(5, 9)) });
  fields.push({ key: '高度', value: `${altitude.toFixed(1)} 米`, raw: hex(body.subarray(9, 11)) });
  fields.push({ key: '速度', value: `${speed.toFixed(1)} 千米/小时`, raw: hex(body.subarray(11, 13)) });
  fields.push({
    key: '方向',
    value: direction === 0xffff ? '未知' : `${direction}°`,
    raw: hex(body.subarray(13, 15)),
  });
  fields.push({ key: '定位时间', value: time, raw: hex(body.subarray(15, 21)) });
  fields.push({ key: '卫星数', value: String(body[21]), raw: hex(body.subarray(21, 22)) });
  fields.push({ key: '定位状态', value: positionStatus(body[22]), raw: hex(body.subarray(22, 23)) });
  if (body.length > 23) {
    fields.push({ key: '附加数据', value: `${body.length - 23} 字节`, raw: hex(body.subarray(23)) });
  }
  return fields;
}

/** 解析车辆状态信息正文 */
function decodeVehicleStatus(body: Buffer): DecodedField[] {
  const fields: DecodedField[] = [];
  if (body.length < 1) {
    fields.push({ key: '正文', value: '空' });
    return fields;
  }
  fields.push({ key: '车辆状态', value: statusBits(body[0], VEHICLE_STATUS_BITS), raw: hex(body.subarray(0, 1)) });
  if (body.length >= 2) {
    fields.push({
      key: '扩展车辆状态',
      value: statusBits(body[1], VEHICLE_EXT_BITS),
      raw: hex(body.subarray(1, 2)),
    });
  }
  return fields;
}

/** 解析通用应答正文（终端/平台通用应答共用结构） */
function decodeGeneralReply(body: Buffer): DecodedField[] {
  const fields: DecodedField[] = [];
  if (body.length < 3) {
    fields.push({ key: '正文', value: `只有 ${body.length} 字节` });
    return fields;
  }
  const seq = body.readUInt16BE(0);
  const messageId = body.readUInt16BE(2);
  fields.push({ key: '应答序列号', value: String(seq), raw: hex(body.subarray(0, 2)) });
  fields.push({
    key: '应答消息',
    value: `${JT808_MESSAGES[messageId]?.name ?? '未知'}（0x${messageId.toString(16).toUpperCase().padStart(4, '0')}）`,
    raw: hex(body.subarray(2, 4)),
  });
  if (body.length >= 5) {
    const result = body[4];
    fields.push({ key: '结果', value: result === 0 ? '成功' : `失败（原因 ${body[5] ?? 0}）` });
  }
  return fields;
}

/** 解析平台注册应答正文 */
function decodeRegisterReply(body: Buffer): DecodedField[] {
  const fields: DecodedField[] = [];
  if (body.length < 3) {
    fields.push({ key: '正文', value: `只有 ${body.length} 字节` });
    return fields;
  }
  fields.push({ key: '应答序列号', value: String(body.readUInt16BE(0)), raw: hex(body.subarray(0, 2)) });
  const ok = body[2] === 0;
  fields.push({ key: '应答标志', value: ok ? '成功' : `失败（原因 ${body[3] ?? 0}）` });
  if (body.length > 4) fields.push({ key: '鉴权码', value: hex(body.subarray(4)), raw: hex(body.subarray(4)) });
  return fields;
}

/** 解析文本信息下发正文 */
function decodeText(body: Buffer): DecodedField[] {
  const fields: DecodedField[] = [];
  if (!body.length) return fields;
  fields.push({ key: '标志', value: String(body[0]), raw: hex(body.subarray(0, 1)) });
  const text = body.subarray(1);
  fields.push({ key: '文本内容', value: decodeGbk(text), raw: hex(text) });
  return fields;
}

/** 表单里的数字：十进制或 0x 十六进制 */
function numArg(args: Record<string, string>, key: string, fallback: number): number {
  const raw = (args[key] ?? '').trim();
  if (!raw) return fallback;
  const value = raw.toLowerCase().startsWith('0x')
    ? Number.parseInt(raw.slice(2), 16)
    : Number.parseInt(raw, 10);
  return Number.isFinite(value) ? value : fallback;
}

/** 表单里的十六进制字节：留空就是没有 */
function hexArg(args: Record<string, string>, key: string): Buffer {
  const raw = (args[key] ?? '').trim();
  return raw ? parseHex(raw) : Buffer.alloc(0);
}

/**
 * 没正文的命令：应答与查询，正文空着。
 *
 * 一堆查询命令长得一样——发出去的就只是那个消息 ID，
 * 所以归到一张表里，不用一条条 switch。
 */
const EMPTY_BODY_IDS: Record<string, number> = {
  'platform.heartbeat.reply': 0x8002,
  'platform.logout.reply': 0x8003,
  'platform.device.query': 0x8102,
  'platform.location.query': 0x8103,
  'platform.register.status.query': 0x8105,
  'platform.gps.status.query': 0x8106,
  'platform.navigation.query': 0x8107,
  'platform.roaming.request': 0x8108,
  'platform.monitor.request': 0x8109,
  'platform.signal.query': 0x8110,
};

/** 注册应答与补注册应答：正文一样，只有消息 ID 不同 */
function buildRegisterReply(args: Record<string, string>, messageId: number): Buffer {
  const seq = numArg(args, 'seq', 0) & 0xffff;
  const failed = numArg(args, 'result', 0) !== 0;
  const body = Buffer.alloc(failed ? 4 : 3);
  body.writeUInt16BE(seq, 0);
  body[2] = failed ? 1 : 0;
  if (failed) body[3] = numArg(args, 'reason', 0) & 0xff;
  // 鉴权码（2019 版）：填了就带 16 字节，不填说明平台不搞加密
  const auth = (args.authKey ?? '').trim();
  if (auth) {
    const key = parseHex(auth);
    const full = Buffer.alloc(16);
    key.copy(full, 0, 0, Math.min(16, key.length));
    return buildJt808Frame({ messageId, body: Buffer.concat([body, full]), seq });
  }
  return buildJt808Frame({ messageId, body, seq });
}

/**
 * 组一条平台要发的命令。
 *
 * kind 对应 JT808_BUILDS 里的命令 id；参数从界面表单来。
 */
export function buildJt808Command(request: EncodeRequest): Buffer {
  const args = request.args ?? {};

  // 没正文的那些：查表就知道发哪条消息
  const empty = EMPTY_BODY_IDS[request.kind];
  if (empty !== undefined) {
    return buildJt808Frame({
      messageId: empty,
      body: Buffer.alloc(0),
      seq: numArg(args, 'seq', 0) & 0xffff,
    });
  }

  switch (request.kind) {
    case 'platform.register.reply':
      return buildRegisterReply(args, 0x8001);
    case 'platform.reregister.reply':
      return buildRegisterReply(args, 0x8005);
    case 'platform.general.reply': {
      const failed = numArg(args, 'result', 0) !== 0;
      const body = Buffer.alloc(failed ? 6 : 5);
      body.writeUInt16BE(numArg(args, 'seq', 0) & 0xffff, 0);
      body.writeUInt16BE(numArg(args, 'messageId', 0x0200) & 0xffff, 2);
      body[4] = failed ? 1 : 0;
      if (failed) body[5] = numArg(args, 'reason', 0) & 0xff;
      return buildJt808Frame({ messageId: 0x8004, body, seq: numArg(args, 'seq', 0) & 0xffff });
    }
    case 'platform.text': {
      const raw = (args.text ?? '').trim();
      // 文本按 UTF-8 发；终端只认 GBK 时，用 hex: 前缀直接给字节
      const payload = raw.toLowerCase().startsWith('hex:')
        ? parseHex(raw.slice(4))
        : Buffer.from(raw, 'utf8');
      const body = Buffer.concat([Buffer.from([numArg(args, 'flag', 0) & 0xff]), payload]);
      return buildJt808Frame({ messageId: 0x8101, body, seq: numArg(args, 'seq', 0) & 0xffff });
    }
    case 'platform.vehicle.control': {
      // 指令字 + 指令参数：参数长什么样由指令字说了算，给十六进制最省事
      const body = Buffer.concat([Buffer.from([numArg(args, 'cmd', 0) & 0xff]), hexArg(args, 'params')]);
      return buildJt808Frame({ messageId: 0x8100, body, seq: numArg(args, 'seq', 0) & 0xffff });
    }
    case 'platform.remote.set': {
      // 参数标识（4 字节）+ 数据体
      const id = Buffer.alloc(4);
      id.writeUInt32BE(numArg(args, 'paramId', 0) >>> 0, 0);
      const body = Buffer.concat([id, hexArg(args, 'value')]);
      return buildJt808Frame({ messageId: 0x8104, body, seq: numArg(args, 'seq', 0) & 0xffff });
    }
    case 'platform.custom': {
      // 上面没列的消息：自己给消息 ID 与正文
      const messageId = numArg(args, 'messageId', 0) >>> 0;
      return buildJt808Frame({
        messageId,
        body: hexArg(args, 'body'),
        seq: numArg(args, 'seq', 0) & 0xffff,
      });
    }
    default:
      throw new Error(`不会组这条命令：${request.kind}`);
  }
}

/**
 * 能组哪些命令（界面照着渲染表单）。
 *
 * 每条都带 **消息 ID**（code）：组包时人挑的是「发哪一条协议消息」，
 * 那个 ID 得摆在名字旁边——不然挑了「文本信息下发」也不知道发出去的是 0x8101。
 */
export const JT808_BUILDS: ProtocolBuild[] = [
  {
    kind: 'platform.register.reply',
    code: '0x8001',
    name: '平台注册应答',
    desc: '终端注册（0x0001）的回包。应答序列号要跟终端那一帧对上，终端认了这个才不发注册。',
    fields: [
      { key: 'seq', label: '应答序列号', required: true, defaultValue: '1', help: '要应答的那一帧的序列号' },
      { key: 'result', label: '应答标志', defaultValue: '0', help: '0 = 成功，1 = 失败' },
      { key: 'reason', label: '失败原因', placeholder: '失败时才填', help: '原因码见标准附录' },
      { key: 'authKey', label: '鉴权码', placeholder: '十六进制，16 字节', help: '2019 版可选；留空表示不加密' },
    ],
  },
  {
    kind: 'platform.reregister.reply',
    code: '0x8005',
    name: '平台补注册应答',
    desc: '终端补注册（0x0005）的回包，正文与注册应答一样。',
    fields: [
      { key: 'seq', label: '应答序列号', required: true, defaultValue: '1', help: '要应答的那一帧的序列号' },
      { key: 'result', label: '应答标志', defaultValue: '0', help: '0 = 成功，1 = 失败' },
      { key: 'reason', label: '失败原因', placeholder: '失败时才填' },
      { key: 'authKey', label: '鉴权码', placeholder: '十六进制，16 字节', help: '2019 版可选；留空表示不加密' },
    ],
  },
  {
    kind: 'platform.logout.reply',
    code: '0x8003',
    name: '平台注销应答',
    desc: '终端注销（0x0003）的回包，正文为空。',
    fields: [{ key: 'seq', label: '序列号', defaultValue: '1' }],
  },
  {
    kind: 'platform.heartbeat.reply',
    code: '0x8002',
    name: '平台心跳应答',
    desc: '终端心跳（0x0002）的回包，正文为空。终端收不到心跳应答会以为平台挂了。',
    fields: [{ key: 'seq', label: '序列号', defaultValue: '1' }],
  },
  {
    kind: 'platform.general.reply',
    code: '0x8004',
    name: '平台通用应答',
    desc: '应答终端发来的某条消息，比如它报了一次位置。',
    fields: [
      { key: 'seq', label: '应答序列号', required: true, defaultValue: '1' },
      { key: 'messageId', label: '被应答的消息 ID', required: true, defaultValue: '0x0200', help: '十六进制，如 0x0200' },
      { key: 'result', label: '结果', defaultValue: '0', help: '0 = 成功，1 = 失败' },
      { key: 'reason', label: '失败原因', placeholder: '失败时才填' },
    ],
  },
  {
    kind: 'platform.text',
    code: '0x8101',
    name: '文本信息下发',
    desc: '给终端发一段文字。',
    fields: [
      { key: 'text', label: '文本内容', required: true, help: '中文按 UTF-8 发出；终端只认 GBK 时填 hex:4F60597D' },
      { key: 'flag', label: '标志', defaultValue: '0' },
    ],
  },
  {
    kind: 'platform.vehicle.control',
    code: '0x8100',
    name: '车辆控制命令',
    desc: '给车下发控制指令。正文是「指令字 + 指令参数」，参数长什么样由指令字说了算。',
    fields: [
      { key: 'cmd', label: '指令字', required: true, defaultValue: '0', help: '1 字节，十进制或 0x 开头' },
      { key: 'params', label: '指令参数', placeholder: '十六进制，可留空', help: '依指令字而定；留空表示无参数' },
    ],
  },
  {
    kind: 'platform.remote.set',
    code: '0x8104',
    name: '远程设置参数',
    desc: '改终端上的一个参数：参数标识 + 参数值。',
    fields: [
      { key: 'paramId', label: '参数标识', required: true, defaultValue: '0x0000', help: '4 字节，如 0x0050' },
      { key: 'value', label: '参数值', placeholder: '十六进制', help: '按参数定义的长度填，如 0x01' },
    ],
  },
  {
    kind: 'platform.location.query',
    code: '0x8103',
    name: '实时位置查询',
    desc: '让终端立刻报一次位置，正文为空。',
    fields: [{ key: 'seq', label: '序列号', defaultValue: '1' }],
  },
  {
    kind: 'platform.device.query',
    code: '0x8102',
    name: '查询车载终端设备信息',
    desc: '让终端报一次自己的设备信息，正文为空。',
    fields: [{ key: 'seq', label: '序列号', defaultValue: '1' }],
  },
  {
    kind: 'platform.register.status.query',
    code: '0x8105',
    name: '终端注册状态查询',
    desc: '问终端注册上没有，正文为空。',
    fields: [{ key: 'seq', label: '序列号', defaultValue: '1' }],
  },
  {
    kind: 'platform.gps.status.query',
    code: '0x8106',
    name: '查询卫星定位状态',
    desc: '问终端现在搜到几颗星，正文为空。',
    fields: [{ key: 'seq', label: '序列号', defaultValue: '1' }],
  },
  {
    kind: 'platform.navigation.query',
    code: '0x8107',
    name: '查询导航信息',
    desc: '问终端当前的导航信息，正文为空。',
    fields: [{ key: 'seq', label: '序列号', defaultValue: '1' }],
  },
  {
    kind: 'platform.roaming.request',
    code: '0x8108',
    name: '请求终端漫游',
    desc: '要终端跨区漫游，正文为空。',
    fields: [{ key: 'seq', label: '序列号', defaultValue: '1' }],
  },
  {
    kind: 'platform.monitor.request',
    code: '0x8109',
    name: '请求人工监听车辆',
    desc: '要平台人工监听这辆车，正文为空。',
    fields: [{ key: 'seq', label: '序列号', defaultValue: '1' }],
  },
  {
    kind: 'platform.signal.query',
    code: '0x8110',
    name: '查询车辆信号灯',
    desc: '问车上的信号灯状态，正文为空。',
    fields: [{ key: 'seq', label: '序列号', defaultValue: '1' }],
  },
  {
    kind: 'platform.custom',
    code: '自定义',
    name: '自定义消息',
    desc: '上面没有的消息：自己给消息 ID 与正文（十六进制）。',
    fields: [
      { key: 'messageId', label: '消息 ID', required: true, defaultValue: '0x8101', help: '4 字节，如 0x8101' },
      { key: 'seq', label: '序列号', defaultValue: '1' },
      { key: 'body', label: '消息体', placeholder: '十六进制，可留空', help: '正文原始字节，十六进制' },
    ],
  },
];

/**
 * 把进来的字节整理成「裸帧」：解转义、摘掉包头包尾。
 *
 * 切帧器切出来的是裸帧（解过转义、没有 0x7E 包头包尾）；
 * 组包发出去的是完整报文（带 0x7E、转义过）。
 * 两种都得能读——记录里「发出去的那一帧」就是完整报文，
 * 解错了那条记录就等于没发。
 *
 * 靠消息头里的长度字段判断：整理完之后长度正好对上，才算整理对了。
 * 对不上就按原样解——校验码不对的帧也要给人看见，不能因为形状怪就丢。
 */
function normalizeFrame(frame: Buffer): Buffer {
  const stripped =
    frame.length >= HEADER_LEN + 3 && frame[0] === JT808_FLAG && frame[frame.length - 1] === JT808_FLAG
      ? frame.subarray(1, frame.length - 1)
      : frame;
  const candidates = [
    frame,
    unescapeJt808(frame),
    stripped,
    unescapeJt808(stripped),
  ];
  for (const candidate of candidates) {
    if (candidate.length < HEADER_LEN + 1) continue;
    if (candidate.readUInt32BE(8) === candidate.length - HEADER_LEN - 1) return candidate;
  }
  return stripped;
}

/**
 * 解一帧。
 *
 * 除了读字段，还给出**该回什么**：
 * 终端注册要回注册应答，心跳要回心跳应答——不回，终端会一直重发。
 */
export function decodeJt808(frame: Buffer): Jt808Decoded {
  const raw = normalizeFrame(frame);
  const header = parseJt808Header(raw);
  if (!header) {
    return {
      messageId: -1,
      messageName: '不是 JT/T 808 帧',
      seq: 0,
      encrypted: false,
      checksumOk: false,
      fields: [{ key: '原始字节', value: hex(frame) }],
    };
  }

  const body = raw.subarray(HEADER_LEN, raw.length - 1);
  const meta = JT808_MESSAGES[header.messageId];
  const messageName =
    meta?.name ?? `未知消息 0x${header.messageId.toString(16).toUpperCase().padStart(4, '0')}`;

  const fields: DecodedField[] = [];
  if (!header.checksumOk) fields.push({ key: '校验码', value: '不对，这一帧可能传损了' });
  if (header.lengthMismatch) {
    fields.push({ key: '长度字段', value: `写着 ${header.declaredLength}，实际 ${header.bodyLength}` });
  }

  let reply: { data: Buffer; note: string } | undefined;

  if (header.encrypted) {
    fields.push({ key: '消息体', value: '已加密，没解密读不了', raw: hex(body) });
  } else {
    switch (header.messageId) {
      case 0x0001:
      case 0x0005:
        fields.push(...decodeRegister(body));
        break;
      case 0x0002:
        fields.push({ key: '心跳', value: '终端在线' });
        break;
      case 0x0003:
        fields.push({ key: '注销', value: '终端主动下线' });
        break;
      case 0x0004:
      case 0x8004:
        fields.push(...decodeGeneralReply(body));
        break;
      case 0x8001:
      case 0x8005:
        fields.push(...decodeRegisterReply(body));
        break;
      case 0x0200:
      case 0x0201:
        fields.push(...decodePosition(body));
        break;
      case 0x0300:
        fields.push(...decodeVehicleStatus(body));
        break;
      case 0x8101:
        fields.push(...decodeText(body));
        break;
      default:
        fields.push({ key: '正文', value: `${body.length} 字节`, raw: hex(body) });
    }
  }

  // 网络注册：终端注册、终端心跳，平台都得回话
  if (!header.encrypted && header.checksumOk) {
    if (header.messageId === 0x0001 || header.messageId === 0x0005) {
      const replyBody = Buffer.alloc(3);
      replyBody.writeUInt16BE(header.seq, 0);
      replyBody[2] = 0; // 成功
      const replyId = header.messageId === 0x0001 ? 0x8001 : 0x8005;
      reply = {
        data: buildJt808Frame({ messageId: replyId, body: replyBody, seq: header.seq }),
        note: header.messageId === 0x0001 ? '注册应答' : '补注册应答',
      };
    } else if (header.messageId === 0x0002) {
      reply = {
        data: buildJt808Frame({ messageId: 0x8002, body: Buffer.alloc(0), seq: header.seq }),
        note: '心跳应答',
      };
    }
  }

  return {
    messageId: header.messageId,
    messageName,
    seq: header.seq,
    encrypted: header.encrypted,
    checksumOk: header.checksumOk,
    fields,
    reply,
  };
}
