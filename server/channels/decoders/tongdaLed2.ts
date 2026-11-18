/**
 * 通达 LED2 协议解码器。
 *
 * 帧结构（摘自《通达LED2协议20240111》）：
 *
 *   0xBB | ADDR(1) | LEN(1) | CMD(1) | DATA(n) | SUML(1) | SUMH(1) | 0x55
 *
 * - LEN：ADDR 到 SUMH 之间的字节数，即 5 + 数据长度；LEN=0 时改由 DATA0/DATA1 表示数据长度（长帧）
 * - 校验和：从 ADDR 累加到最后一个数据字节，16 位、**小端**存放（低字节在前）
 * - 硬件地址：0x10 GPS 终端，0x01 车外头牌，0x02 车外腰牌，0x03 车外尾牌，0x04 车内屏
 *
 * 中文一律 GBK。
 */

/** 帧头 / 帧尾 */
export const LED2_HEAD = 0xbb;
export const LED2_TAIL = 0x55;

/** 命令码 → 名称 */
export const LED2_COMMANDS: Record<number, string> = {
  0x01: '广播线路状态',
  0x02: '路牌字符',
  0x03: '车内屏字符',
  0x04: '车内屏广告',
  0x08: '屏报站',
  0x10: '路牌字符（中英文）',
  0x11: '侧牌字符',
  0x12: '首末班时间',
  0x13: '票价数据',
  0x14: '文本信息',
  0x16: '行驶证信息',
  0x17: '侧牌字符（中英文）',
  0xe0: '屏控制指令',
  0xe1: '换乘信息',
  0xe2: '客流数据',
  0xe3: '查询参数',
  0xe4: '查询参数应答',
  0xe5: '投诉信息',
  0xe6: '广告推送',
  0xe7: '线路信息',
  0xf5: '报警消息',
};

/** 硬件地址 → 名称 */
export const LED2_HARDWARE: Record<number, string> = {
  0x01: '车外头牌',
  0x02: '车外腰牌',
  0x03: '车外尾牌',
  0x04: '车内屏',
  0x10: 'GPS 终端',
};

/** 票价数据的季节标志 */
export const LED2_SEASONS: Record<number, string> = {
  0x00: '常规',
  0x80: '春节',
};

/* --------------------------- 协议详情（给界面看的） --------------------------- */

/** 帧结构：一帧按字节拆开，每段是什么 */
export const LED2_FRAME_PARTS = [
  { name: '帧头', bytes: '1 字节', desc: '固定 0xBB。开头不是它的字节一律当噪声丢掉。' },
  {
    name: '硬件地址',
    bytes: '1 字节',
    desc: '谁在说话：0x01 车外头牌、0x02 车外腰牌、0x03 车外尾牌、0x04 车内屏、0x10 GPS 终端。',
  },
  {
    name: '长度 LEN',
    bytes: '1 字节',
    desc: '硬件地址到校验和高字节之间的字节数（5 + 数据长度）。LEN=0 是长帧，真实长度放在 DATA0/DATA1。',
  },
  { name: '命令码 CMD', bytes: '1 字节', desc: '这条消息讲什么，见下方命令码表。' },
  { name: '数据区 DATA', bytes: 'n 字节', desc: '正文，格式随命令码而定；中文一律 GBK。' },
  {
    name: '校验和',
    bytes: '2 字节',
    desc: '从硬件地址累加到最后一个数据字节，16 位小端存放（低字节在前）。',
  },
  { name: '帧尾', bytes: '1 字节', desc: '固定 0x55。' },
] as const;

/** 地址表：硬件地址 → 谁 */
export const LED2_ADDRESSES = [
  { code: '0x01', name: '车外头牌' },
  { code: '0x02', name: '车外腰牌' },
  { code: '0x03', name: '车外尾牌' },
  { code: '0x04', name: '车内屏' },
  { code: '0x10', name: 'GPS 终端' },
] as const;

/** 命令码 → 该命令数据区的字段含义 */
export const LED2_COMMAND_FIELDS: Record<number, Array<{ name: string; desc: string }>> = {
  0x01: [
    { name: '时间', desc: '分/时/日/星期/月/年，BCD 编码' },
    { name: '上下行', desc: '1 字节，最高位 1 = 下行' },
    { name: '到离站', desc: '1 字节，最高位 1 = 到站，低 7 位是站点序号' },
  ],
  0x02: [
    { name: '线路名', desc: '1 字节长度 + GBK 文本' },
    { name: '起点站', desc: '1 字节长度 + GBK 文本' },
    { name: '终点站', desc: '1 字节长度 + GBK 文本' },
  ],
  0x03: [
    { name: '屏幕内容', desc: 'GBK 文本' },
    { name: '时间字段', desc: '2 字节，协议标注无效' },
  ],
  0x04: [
    { name: '宣传用语', desc: '1 字节长度 + GBK 文本' },
    { name: '显示时间', desc: '1 字节，单位秒' },
  ],
  0x08: [
    { name: '到离站', desc: '1 字节，最高位 1 = 到站，低 7 位是站点序号' },
    { name: '上下行', desc: '1 字节，最高位 1 = 下行，低 7 位是总站点数' },
    { name: '报站内容', desc: 'GBK 文本' },
  ],
  0x10: [
    { name: '线路名', desc: '1 字节长度 + GBK 文本' },
    { name: '中文起点站', desc: '1 字节长度 + GBK 文本' },
    { name: '英文起点站', desc: '1 字节长度 + GBK 文本' },
    { name: '中文终点站', desc: '1 字节长度 + GBK 文本' },
    { name: '英文终点站', desc: '1 字节长度 + GBK 文本' },
  ],
  0x11: [
    { name: '总站点数', desc: '1 字节' },
    { name: '站点列表', desc: '每站：1 字节序号 + 1 字节长度 + GBK 站名' },
  ],
  0x12: [
    { name: '首班时间', desc: '2 字节，十进制 时/分（不是 BCD）' },
    { name: '末班时间', desc: '2 字节，十进制 时/分（不是 BCD）' },
  ],
  0x13: [
    { name: '季节标志', desc: '1 字节：0x00 常规 / 0x80 春节' },
    { name: '投币价格', desc: '1 字节长度 + GBK 文本' },
    { name: '刷卡价格', desc: '1 字节长度 + GBK 文本' },
  ],
  0x14: [
    { name: '条数', desc: '1 字节' },
    { name: '文本列表', desc: '每条：1 字节编号 + 1 字节长度 + GBK 内容' },
  ],
  0x16: [
    { name: '人数', desc: '1 字节' },
    { name: '人员 N', desc: '角色 1 字节 + 工号 / 岗位 / 姓名 / 分公司（各 1 字节长度 + GBK）' },
  ],
  0x17: [
    { name: '总站点数', desc: '1 字节' },
    { name: '站点列表', desc: '每站：1 字节序号 + 中文名 + 英文名（各 1 字节长度 + GBK）' },
  ],
  0xe0: [{ name: '语音', desc: '4 字节控制位，0 = 开启语音，其余 = 关闭' }],
  0xe1: [{ name: '原始数据', desc: '文档未给格式，只把原始字节带出来' }],
  0xe2: [
    { name: '门数', desc: '4 字节大端' },
    { name: '门 N', desc: '门号 1 字节 + 上车人数 4 字节小端 + 下车人数 4 字节小端' },
  ],
  0xe3: [
    { name: '查询设备', desc: '1 字节硬件地址' },
    { name: '参数列表', desc: '每项 2 字节小端参数 ID' },
  ],
  0xe4: [{ name: '参数列表', desc: '每项：2 字节小端参数 ID + 1 字节长度 + 数据' }],
  0xe5: [
    { name: '投诉时间', desc: '6 字节 BCD：分/时/日/月/年' },
    { name: '投诉记录', desc: '角色 1 字节 + 工号（1 字节长度 + GBK）' },
  ],
  0xe6: [{ name: '原始数据', desc: '文档未给格式，只把原始字节带出来' }],
  0xe7: [{ name: '原始数据', desc: '文档未给格式，只把原始字节带出来' }],
  0xf5: [
    { name: '报警', desc: '1 字节，0 = 关闭，其余 = 开启' },
    { name: '报警内容', desc: '1 字节长度 + GBK 文本' },
  ],
};

/** 解码器 id，与协议模板里的 decoder 对应 */
export const LED2_DECODER_ID = 'tongda-led2';

const gbk = new TextDecoder('gbk');

/** 按 GBK 解码（解不出来时退回 Latin-1，保证不丢字节） */
export function decodeGbk(buf: Buffer): string {
  try {
    return gbk.decode(buf);
  } catch {
    return buf.toString('latin1');
  }
}

/** BCD 码转十进制；非法值返回 null */
export function bcd(value: number): number | null {
  const hi = value >> 4;
  const lo = value & 0x0f;
  if (hi > 9 || lo > 9) return null;
  return hi * 10 + lo;
}

/** 数据长度：普通帧是 LEN-5，长帧看 DATA0/DATA1 */
function dataLength(frame: Buffer): { length: number; long: boolean } {
  const len = frame[2];
  if (len > 0) return { length: len - 5, long: false };
  const n = frame[4] + frame[5] * 256;
  return { length: n, long: true };
}

/** 数据区起点：普通帧第 4 字节，长帧第 6 字节 */
function dataOffset(frame: Buffer): number {
  return frame[2] > 0 ? 4 : 6;
}

/** 校验和所在偏移 */
function checksumOffset(frame: Buffer): number {
  const len = frame[2];
  if (len > 0) return len - 1;
  return 6 + frame[4] + frame[5] * 256;
}

/** 从 ADDR 累加到最后一个数据字节 */
export function led2Checksum(frame: Buffer): number {
  const offset = checksumOffset(frame);
  let sum = 0;
  for (let i = 1; i < offset; i++) sum += frame[i];
  return sum & 0xffff;
}

/** 校验和是否对得上 */
export function led2ChecksumOk(frame: Buffer): boolean {
  const offset = checksumOffset(frame);
  if (frame.length < offset + 3) return false;
  const sum = led2Checksum(frame);
  return frame[offset] === (sum & 0xff) && frame[offset + 1] === ((sum >> 8) & 0xff);
}

/**
 * 按协议构造一帧：自动算 LEN 与校验和。
 *
 * @param addr 硬件地址，如 0x10
 * @param cmd 命令码
 * @param data 数据区
 */
export function buildLed2Frame(addr: number, cmd: number, data: Buffer = Buffer.alloc(0)): Buffer {
  if (data.length <= 250) {
    const len = 5 + data.length;
    const frame = Buffer.alloc(len + 2);
    frame[0] = LED2_HEAD;
    frame[1] = addr & 0xff;
    frame[2] = len & 0xff;
    frame[3] = cmd & 0xff;
    data.copy(frame, 4);
    const sum = led2Checksum(frame);
    frame[len - 1] = sum & 0xff;
    frame[len] = (sum >> 8) & 0xff;
    frame[len + 1] = LED2_TAIL;
    return frame;
  }
  // 长帧：LEN=0，实际长度放在 DATA0/DATA1
  const len = 5 + 2 + data.length;
  const frame = Buffer.alloc(len + 2);
  frame[0] = LED2_HEAD;
  frame[1] = addr & 0xff;
  frame[2] = 0;
  frame[3] = cmd & 0xff;
  frame[4] = data.length & 0xff;
  frame[5] = (data.length >> 8) & 0xff;
  data.copy(frame, 6);
  const sum = led2Checksum(frame);
  frame[len - 1] = sum & 0xff;
  frame[len] = (sum >> 8) & 0xff;
  frame[len + 1] = LED2_TAIL;
  return frame;
}

/** 协议里出现过的硬件地址 */
export const LED2_KNOWN_ADDRS = new Set<number>(Object.keys(LED2_HARDWARE).map((k) => Number(k)));

/** 一帧最短的字节数：头 + 地址 + 长度 + 命令 + 校验(2) + 尾 */
const LED2_MIN_FRAME = 7;

/** 地址认不认识 */
function isKnownAddr(addr: number): boolean {
  return LED2_KNOWN_ADDRS.has(addr);
}

/**
 * 流式切帧器。
 *
 * 串口数据是分片的，一帧可能横跨好几次读，所以切帧得能跨包续上：
 * 攒够一整帧才吐出去，帧尾或校验和对不上就丢掉一个字节重新找帧头。
 */
export class Led2Parser {
  private buf: Buffer = Buffer.alloc(0);
  /** 地址对不上时先当噪声；连续对不上多次就放宽，免得设备用文档外的地址时完全收不到数据 */
  private strictAddr = true;
  private addrMisses = 0;

  /** 喂进一段字节，返回切好的完整帧 */
  push(chunk: Buffer): Buffer[] {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const frames: Buffer[] = [];
    for (;;) {
      const frame = this.extract();
      if (!frame) break;
      frames.push(frame);
    }
    return frames;
  }

  /** 冲刷剩余字节（这里不产出半帧） */
  flush(): Buffer[] {
    this.buf = Buffer.alloc(0);
    return [];
  }

  /** 还攒着多少字节没切出来 */
  pending(): number {
    return this.buf.length;
  }

  /** 尝试切出一帧；切不出返回 null */
  private extract(): Buffer | null {
    for (;;) {
      const start = this.buf.indexOf(LED2_HEAD);
      if (start < 0) {
        this.buf = Buffer.alloc(0);
        return null;
      }
      if (start > 0) this.buf = this.buf.subarray(start);
      // BB ADDR LEN CMD 至少 4 字节
      if (this.buf.length < 4) return null;

      // 帧头后面的地址必须认识，否则多半是数据里的 0xBB 撞上了
      if (this.strictAddr && !isKnownAddr(this.buf[1])) {
        // 紧接着又来一个 0xBB：当前这个是噪声，直接跳到后一个
        const next = this.buf.indexOf(LED2_HEAD, 1);
        if (next >= 0 && next < LED2_MIN_FRAME) {
          this.buf = this.buf.subarray(next);
          continue;
        }
        this.addrMisses += 1;
        if (this.addrMisses >= 8) this.strictAddr = false;
        this.buf = this.buf.subarray(1);
        continue;
      }
      this.addrMisses = 0;

      const len = this.buf[2];
      let total: number;
      if (len > 0) {
        total = len + 2;
      } else {
        // 长帧：DATA0/DATA1 才是数据长度
        if (this.buf.length < 6) return null;
        total = 6 + this.buf[4] + this.buf[5] * 256 + 3;
      }
      if (this.buf.length < total) return null;

      const frame = this.buf.subarray(0, total);
      // 帧尾对不上就不是帧；校验和对不上只标记、不丢弃——
      // 协议里 0x03 这类命令的校验和范围与别的命令并不一致（有的只覆盖正文），
      // 拿校验和当切帧依据会误伤真机数据。
      if (frame[total - 1] !== LED2_TAIL) {
        this.buf = this.buf.subarray(1);
        continue;
      }
      this.buf = this.buf.subarray(total);
      this.addrMisses = 0;
      return frame;
    }
  }
}

/** 解出来的一个字段 */
export interface Led2Field {
  /** 字段名 */
  key: string;
  /** 字段值（人话） */
  value: string;
  /** 原始字节，看不懂时能对着查 */
  raw?: string;
}

/** 一帧解析出来的结构化结果 */
export interface Led2Parsed {
  /** 硬件地址 */
  addr: number;
  /** 硬件名称 */
  device: string;
  /** 命令码 */
  cmd: number;
  /** 命令名 */
  command: string;
  /** 数据长度 */
  dataLength: number;
  /** 字段列表 */
  fields: Led2Field[];
  /** 校验和是否正确 */
  checksumOk: boolean;
}

/** 取一段 GBK 文本：前 1 字节是长度 */
function takeText(data: Buffer, pos: number, label: string): { field?: Led2Field; next: number } {
  if (pos >= data.length) return { next: pos };
  const size = data[pos];
  const start = pos + 1;
  const end = Math.min(start + size, data.length);
  const text = decodeGbk(data.subarray(start, end));
  return {
    field: { key: label, value: text, raw: data.subarray(start, end).toString('hex') },
    next: end,
  };
}

/** 读一个小端无符号整数 */
function readUintLE(data: Buffer, pos: number, size: number): number {
  let value = 0;
  for (let i = size - 1; i >= 0; i--) value = value * 256 + (data[pos + i] ?? 0);
  return value;
}

/** 读一个大端无符号整数 */
function readUintBE(data: Buffer, pos: number, size: number): number {
  let value = 0;
  for (let i = 0; i < size; i++) value = value * 256 + (data[pos + i] ?? 0);
  return value;
}

/** 到/离站 + 站点序号 */
function stationField(raw: number): Led2Field {
  const arrived = (raw & 0x80) !== 0;
  return {
    key: '到离站',
    value: `${arrived ? '到站' : '离站'}，站点序号 ${raw & 0x7f}`,
    raw: raw.toString(16).padStart(2, '0'),
  };
}

/** 上下行 + 该方向总站点数 */
function directionField(raw: number): Led2Field {
  const down = (raw & 0x80) !== 0;
  return {
    key: '上下行',
    value: `${down ? '下行' : '上行'}，总站点数 ${raw & 0x7f}`,
    raw: raw.toString(16).padStart(2, '0'),
  };
}

/**
 * 解一帧通达 LED2 数据。
 *
 * 按命令码把数据区读成字段；文档没给格式的命令（换乘、广告推送、线路信息）
 * 走通用分支，只把原始字节带出来，不硬猜。
 */
export function decodeLed2(frame: Buffer): Led2Parsed {
  const addr = frame[1];
  const cmd = frame[3];
  const { length } = dataLength(frame);
  const offset = dataOffset(frame);
  const data = frame.subarray(offset, Math.min(offset + length, frame.length));
  return {
    addr,
    device: LED2_HARDWARE[addr] ?? `未知地址 0x${addr.toString(16).padStart(2, '0')}`,
    cmd,
    command: LED2_COMMANDS[cmd] ?? `未知命令 0x${cmd.toString(16).padStart(2, '0')}`,
    dataLength: length,
    fields: decodeByCommand(cmd, data),
    checksumOk: led2ChecksumOk(frame),
  };
}

/** 命令码分派 */
function decodeByCommand(cmd: number, data: Buffer): Led2Field[] {
  switch (cmd) {
    case 0x01:
      return decodeBroadcast(data);
    case 0x02:
      return decodeRouteText(data);
    case 0x03:
      return decodeInnerScreen(data);
    case 0x04:
      return decodeInnerAd(data);
    case 0x08:
      return decodeStationReport(data);
    case 0x10:
      return decodeRouteTextBi(data);
    case 0x11:
      return decodeSideStations(data);
    case 0x12:
      return decodeSchedule(data);
    case 0x13:
      return decodeFare(data);
    case 0x14:
      return decodeTexts(data);
    case 0x16:
      return decodeCrew(data);
    case 0x17:
      return decodeSideStationsBi(data);
    case 0xe0:
      return decodeScreenControl(data);
    case 0xe2:
      return decodePassenger(data);
    case 0xe3:
      return decodeParamQuery(data);
    case 0xe4:
      return decodeParamAnswer(data);
    case 0xe5:
      return decodeComplaint(data);
    case 0xf5:
      return decodeAlarm(data);
    default:
      return genericFields(data);
  }
}

/** 文档没给格式的命令：把原始字节交出来 */
function genericFields(data: Buffer): Led2Field[] {
  return [{ key: '原始数据', value: data.toString('hex'), raw: data.toString('hex') }];
}

/** 0x01 广播线路状态：分时日月星期年 + 上下行 + 到离站 */
function decodeBroadcast(data: Buffer): Led2Field[] {
  const bcdOr = (v: number | undefined) => (v === undefined ? null : bcd(v));
  const minute = bcdOr(data[0]);
  const hour = bcdOr(data[1]);
  const day = bcdOr(data[2]);
  const week = bcdOr(data[3]);
  const month = bcdOr(data[4]);
  const year = bcdOr(data[5]);
  const fields: Led2Field[] = [];
  if (minute !== null && hour !== null && day !== null && month !== null && year !== null) {
    const sec = bcdOr(data[8]);
    const stamp = `${2000 + year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')} ${String(
      hour,
    ).padStart(2, '0')}:${String(minute).padStart(2, '0')}:${sec === null ? '??' : String(sec).padStart(2, '0')}`;
    fields.push({ key: '时间', value: stamp, raw: data.subarray(0, 6).toString('hex') });
  }
  if (week !== null) fields.push({ key: '星期', value: `星期${week}` });
  if (data.length > 6) {
    fields.push({
      key: '上下行',
      value: (data[6] & 0x80) !== 0 ? '下行' : '上行',
      raw: data[6].toString(16).padStart(2, '0'),
    });
  }
  if (data.length > 7) fields.push(stationField(data[7]));
  return fields;
}

/** 0x02 路牌字符：线路名 + 起点 + 终点 */
function decodeRouteText(data: Buffer): Led2Field[] {
  const fields: Led2Field[] = [];
  let pos = 0;
  const route = takeText(data, pos, '线路名');
  if (route.field) fields.push(route.field);
  pos = route.next;
  const from = takeText(data, pos, '起点站');
  if (from.field) fields.push(from.field);
  pos = from.next;
  const to = takeText(data, pos, '终点站');
  if (to.field) fields.push(to.field);
  return fields;
}

/** 0x10 路牌字符（中英文） */
function decodeRouteTextBi(data: Buffer): Led2Field[] {
  const fields: Led2Field[] = [];
  let pos = 0;
  const route = takeText(data, pos, '线路名');
  if (route.field) fields.push(route.field);
  pos = route.next;
  const cnFrom = takeText(data, pos, '中文起点站');
  if (cnFrom.field) fields.push(cnFrom.field);
  pos = cnFrom.next;
  const enFrom = takeText(data, pos, '英文起点站');
  if (enFrom.field) fields.push(enFrom.field);
  pos = enFrom.next;
  const cnTo = takeText(data, pos, '中文终点站');
  if (cnTo.field) fields.push(cnTo.field);
  pos = cnTo.next;
  const enTo = takeText(data, pos, '英文终点站');
  if (enTo.field) fields.push(enTo.field);
  return fields;
}

/** 0x03 车内屏字符：文本 +（无效的）时间 */
function decodeInnerScreen(data: Buffer): Led2Field[] {
  let body = data;
  let time = '';
  // 英文示例尾部是 0x08 分隔符，中文示例尾部是 2 字节时间
  if (body.length > 1 && body[body.length - 1] === 0x08) {
    body = body.subarray(0, body.length - 1);
  } else if (body.length > 2) {
    time = body.subarray(body.length - 2).toString('hex');
    body = body.subarray(0, body.length - 2);
  }
  // eslint-disable-next-line no-control-regex -- 屏幕内容里的控制字符换成空格，不影响显示
  const fields: Led2Field[] = [{ key: '屏幕内容', value: decodeGbk(body).replace(/[\x00-\x1f]/g, ' ').trim() }];
  if (time) fields.push({ key: '时间字段（协议标注无效）', value: time, raw: time });
  return fields;
}

/** 0x04 车内屏广告：宣传用语 + 显示时间 */
function decodeInnerAd(data: Buffer): Led2Field[] {
  const fields: Led2Field[] = [];
  let pos = 0;
  const slogan = takeText(data, pos, '宣传用语');
  if (slogan.field) fields.push(slogan.field);
  pos = slogan.next;
  if (pos < data.length) {
    fields.push({
      key: '显示时间',
      value: `${data[pos]} 秒`,
      raw: data[pos].toString(16).padStart(2, '0'),
    });
  }
  return fields;
}

/** 0x08 屏报站：站序号 + 上下行 + 报站内容 */
function decodeStationReport(data: Buffer): Led2Field[] {
  const fields: Led2Field[] = [];
  if (data.length > 0) fields.push(stationField(data[0]));
  if (data.length > 1) fields.push(directionField(data[1]));
  if (data.length > 2) {
    const body = data.subarray(2);
    // eslint-disable-next-line no-control-regex -- 报站内容里的控制字符换成空格，不影响显示
    fields.push({ key: '报站内容', value: decodeGbk(body).replace(/[\x00-\x1f]/g, ' ').trim() });
  }
  return fields;
}

/** 0x11 侧牌字符：总站点数 + （站点序号 + 站名）列表 */
function decodeSideStations(data: Buffer): Led2Field[] {
  const fields: Led2Field[] = [];
  if (data.length < 1) return genericFields(data);
  fields.push({ key: '总站点数', value: String(data[0]) });
  let pos = 1;
  const stops: string[] = [];
  while (pos < data.length) {
    const index = data[pos];
    const name = takeText(data, pos + 1, '');
    pos = name.next;
    stops.push(`${index}. ${name.field?.value ?? ''}`);
  }
  fields.push({ key: '站点列表', value: stops.join('，') });
  return fields;
}

/** 0x17 侧牌字符（中英文） */
function decodeSideStationsBi(data: Buffer): Led2Field[] {
  const fields: Led2Field[] = [];
  if (data.length < 1) return genericFields(data);
  fields.push({ key: '总站点数', value: String(data[0]) });
  let pos = 1;
  const stops: string[] = [];
  while (pos < data.length) {
    const index = data[pos];
    const cn = takeText(data, pos + 1, '');
    pos = cn.next;
    const en = takeText(data, pos, '');
    pos = en.next;
    const cnName = cn.field?.value ?? '';
    const enName = en.field?.value ? ` / ${en.field.value}` : '';
    stops.push(`${index}. ${cnName}${enName}`);
  }
  fields.push({ key: '站点列表', value: stops.join('，') });
  return fields;
}

/**
 * 0x12 首末班时间：首班时/分、末班时/分。
 *
 * 这一条命令的时间是**十进制**，不是 BCD——0x16 就是 22 点、0x1E 就是 30 分。
 * 和 0x01 广播线路状态里用 BCD 不一样，别混。
 */
function decodeSchedule(data: Buffer): Led2Field[] {
  const fields: Led2Field[] = [];
  if (data.length < 4) return genericFields(data);
  const first = `${data[0]}:${String(data[1]).padStart(2, '0')}`;
  const last = `${data[2]}:${String(data[3]).padStart(2, '0')}`;
  fields.push({ key: '首班时间', value: first, raw: data.subarray(0, 2).toString('hex') });
  fields.push({ key: '末班时间', value: last, raw: data.subarray(2, 4).toString('hex') });
  return fields;
}

/** 0x13 票价数据：季节标志 + 投币价 + 刷卡价 */
function decodeFare(data: Buffer): Led2Field[] {
  const fields: Led2Field[] = [];
  let pos = 0;
  if (data.length > 0) {
    fields.push({
      key: '季节标志',
      value: LED2_SEASONS[data[0]] ?? `0x${data[0].toString(16).padStart(2, '0')}`,
      raw: data[0].toString(16).padStart(2, '0'),
    });
    pos = 1;
  }
  const coin = takeText(data, pos, '投币价格');
  if (coin.field) fields.push(coin.field);
  pos = coin.next;
  const card = takeText(data, pos, '刷卡价格');
  if (card.field) fields.push(card.field);
  return fields;
}

/** 0x14 文本信息：条数 + （编号 + 内容）列表 */
function decodeTexts(data: Buffer): Led2Field[] {
  const fields: Led2Field[] = [];
  if (data.length < 1) return genericFields(data);
  fields.push({ key: '条数', value: String(data[0]) });
  let pos = 1;
  const items: string[] = [];
  while (pos < data.length) {
    const index = data[pos];
    const text = takeText(data, pos + 1, '');
    pos = text.next;
    items.push(`#${index} ${text.field?.value ?? ''}`);
  }
  fields.push({ key: '文本列表', value: items.join('，') });
  return fields;
}

/** 人员角色 */
const CREW_ROLES: Record<number, string> = { 0x01: '司机', 0x02: '售票员 / 乘务员' };

/** 0x16 行驶证信息：人数 + 每人（角色 + 工号 + 岗位 + 姓名 + 分公司） */
function decodeCrew(data: Buffer): Led2Field[] {
  const fields: Led2Field[] = [];
  if (data.length < 1) return genericFields(data);
  fields.push({ key: '人数', value: String(data[0]) });
  let pos = 1;
  let index = 0;
  while (pos < data.length) {
    const role = CREW_ROLES[data[pos]] ?? `角色 0x${data[pos].toString(16)}`;
    pos += 1;
    const id = takeText(data, pos, '');
    pos = id.next;
    const post = takeText(data, pos, '');
    pos = post.next;
    const name = takeText(data, pos, '');
    pos = name.next;
    const company = takeText(data, pos, '');
    pos = company.next;
    const parts = [
      role,
      id.field?.value ? `工号 ${id.field.value}` : '',
      post.field?.value ? `岗位 ${post.field.value}` : '',
      name.field?.value ? `姓名 ${name.field.value}` : '',
      company.field?.value ? `分公司 ${company.field.value}` : '',
    ].filter(Boolean);
    index += 1;
    fields.push({ key: `人员 ${index}`, value: parts.join('，') });
  }
  return fields;
}

/** 0xE0 屏控制指令：4 字节控制位 */
function decodeScreenControl(data: Buffer): Led2Field[] {
  const raw = data.toString('hex');
  const voice = data.length > 0 ? data[0] : 0;
  return [
    {
      key: '语音',
      value: voice === 0 ? '开启语音' : '关闭语音',
      raw,
    },
  ];
}

/** 0xE2 客流数据：门数 + 每门（门号 + 上车人数 + 下车人数） */
function decodePassenger(data: Buffer): Led2Field[] {
  const fields: Led2Field[] = [];
  if (data.length < 4) return genericFields(data);
  // 门数是大端，人数是小端——协议就是这么写的
  const doorCount = readUintBE(data, 0, 4);
  fields.push({ key: '门数', value: String(doorCount), raw: data.subarray(0, 4).toString('hex') });
  let pos = 4;
  while (pos + 9 <= data.length) {
    const door = data[pos];
    const on = readUintLE(data, pos + 1, 4);
    const off = readUintLE(data, pos + 5, 4);
    fields.push({
      key: `门 ${door}`,
      value: `上车 ${on} 人，下车 ${off} 人`,
      raw: data.subarray(pos, pos + 9).toString('hex'),
    });
    pos += 9;
  }
  return fields;
}

/** 参数 ID 说明（协议附录） */
export const LED2_PARAM_IDS: Record<number, string> = {
  100: 'hardware revision',
  101: 'serial number',
  102: 'boot loader sw revision',
  103: 'Application SW revision',
  104: 'Font library revision',
  105: 'CPU part number',
  106: 'CPU qualification',
  107: 'CPU temperature range',
  108: 'Compilation of FW date and time',
  109: 'Flash update status',
  110: 'Test date and time',
  114: 'Article number sign level',
  115: 'Production date',
  116: 'End customer',
  117: 'Order number',
  118: 'Bus / vehicle type',
  119: 'Bus builder number',
  208: 'Language',
  401: 'Board temp sensor',
  402: 'Internal CPU temp',
  600: 'Minimum Temp CPU',
  601: 'Maximum Temp CPU',
  602: 'Minimum temp board',
  603: 'Maximum temp board',
  604: 'Maximum input power voltage',
  605: 'Minimum input power voltage',
  606: 'Operating hours',
  607: 'Number of resets',
  1200: 'Over Voltage',
  1201: 'Low Voltage',
  1203: 'Over Heat',
};

/** 0xE3 查询参数：目标设备 + 参数 ID 列表 */
function decodeParamQuery(data: Buffer): Led2Field[] {
  const fields: Led2Field[] = [];
  if (data.length < 1) return genericFields(data);
  fields.push({
    key: '查询设备',
    value: LED2_HARDWARE[data[0]] ?? `0x${data[0].toString(16).padStart(2, '0')}`,
    raw: data[0].toString(16).padStart(2, '0'),
  });
  let pos = 1;
  while (pos + 2 <= data.length) {
    const id = readUintLE(data, pos, 2);
    fields.push({
      key: `参数 ${id}`,
      value: LED2_PARAM_IDS[id] ?? '未知参数',
      raw: data.subarray(pos, pos + 2).toString('hex'),
    });
    pos += 2;
  }
  return fields;
}

/** 0xE4 查询参数应答：（参数 ID + 长度 + 数据）列表 */
function decodeParamAnswer(data: Buffer): Led2Field[] {
  const fields: Led2Field[] = [];
  let pos = 0;
  while (pos + 3 <= data.length) {
    const id = readUintLE(data, pos, 2);
    const size = data[pos + 2];
    const value = data.subarray(pos + 3, Math.min(pos + 3 + size, data.length));
    const text = decodeGbk(value).replace(/\0+$/, '');
    fields.push({
      key: `参数 ${id}`,
      value: LED2_PARAM_IDS[id] ? `${text}（${LED2_PARAM_IDS[id]}）` : text,
      raw: value.toString('hex'),
    });
    pos += 3 + size;
  }
  if (!fields.length) return genericFields(data);
  return fields;
}

/** 0xE5 投诉信息：时间 + （角色 + ID）列表 */
function decodeComplaint(data: Buffer): Led2Field[] {
  const fields: Led2Field[] = [];
  if (data.length < 6) return genericFields(data);
  const stamp = `${2000 + (bcd(data[0]) ?? 0)}-${String(bcd(data[1]) ?? 0).padStart(2, '0')}-${String(
    bcd(data[2]) ?? 0,
  ).padStart(2, '0')} ${String(bcd(data[3]) ?? 0).padStart(2, '0')}:${String(bcd(data[4]) ?? 0).padStart(2, '0')}:${String(
    bcd(data[5]) ?? 0,
  ).padStart(2, '0')}`;
  fields.push({ key: '投诉时间', value: stamp, raw: data.subarray(0, 6).toString('hex') });
  let pos = 6;
  while (pos < data.length) {
    const role = CREW_ROLES[data[pos]] ?? `角色 0x${data[pos].toString(16)}`;
    pos += 1;
    const id = takeText(data, pos, '');
    pos = id.next;
    fields.push({ key: role, value: id.field?.value?.replace(/\0+$/, '') ?? '', raw: id.field?.raw ?? '' });
  }
  return fields;
}

/** 0xF5 报警消息：使能 + 报警内容 */
function decodeAlarm(data: Buffer): Led2Field[] {
  const fields: Led2Field[] = [];
  if (data.length < 1) return genericFields(data);
  fields.push({ key: '报警', value: data[0] ? '开启报警' : '关闭报警' });
  const content = takeText(data, 1, '报警内容');
  if (content.field) fields.push(content.field);
  return fields;
}


