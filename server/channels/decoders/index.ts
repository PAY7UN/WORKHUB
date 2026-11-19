/**
 * 具名解码器（内置）。
 *
 * 通用定界规则（分隔符、定长、长度字段）能覆盖大多数现场，
 * 但有些协议不是「切出来再按编码读」就行的——它们有自己的帧头帧尾、
 * 自己的校验和范围、自己的一堆命令码。给这类协议写一个解码器，
 * 它连切帧带读字段一起管，通用规则就不用被硬掰成能表达它们的样子。
 *
 * 内置解码器只是**插件的一种**：它是随安装包发布的那一种。
 * 开发者自己发布的插件走 server/channels/plugins/ 那条路，
 * 两者在界面上一视同仁（都出现在「解析插件类型」里），只是署名不同。
 */
import type { DecodedField, ProtocolBuild, ProtocolSpec, TransportScope } from '../../../shared/tools.ts';
import type { DecodedFrame, EncodeRequest, FrameSource } from '../parser.ts';
import {
  JT808_BUILDS,
  JT808_COMMAND_FIELDS,
  JT808_DECODER_ID,
  JT808_FRAME_PARTS,
  JT808_MESSAGES,
  Jt808Parser,
  buildJt808Command,
  decodeJt808,
} from './jt808.ts';
import {
  LED2_ADDRESSES,
  LED2_COMMAND_FIELDS,
  LED2_COMMANDS,
  LED2_DECODER_ID,
  LED2_FRAME_PARTS,
  Led2Parser,
  decodeLed2,
} from './tongdaLed2.ts';

/** 一个具名解码器 */
export interface NamedDecoder {
  /** 解码器 id，与协议模板里的 decoder 字段对应 */
  id: string;
  /** 人看的名字 */
  name: string;
  /** 一句话说明这个协议讲的是什么 */
  summary?: string;
  /** 发布者：内置的署项目名，外部的署开发者 */
  publisher?: string;
  /** 版本号 */
  version?: string;
  /** 属于哪套协议（协议类型 id） */
  protocolId?: string;
  /**
   * 适用于哪些接入方式。
   *
   * 串口接的车载屏与网口接的定位终端不是一套东西：
   * LED2 跑在串口上，JT/T 808 跑在 TCP 上。
   * 写清楚了，界面在串口页就不该出现 808 的插件，反之亦然。
   *
   * 不写 = 不挑，哪儿的口都能用。
   */
  transports?: TransportScope;
  /**
   * 协议详情：帧结构、地址表、命令码表、每条命令的数据区字段含义。
   *
   * 控制台全屏摊开的就是它——选了这套协议，就得让人看清这套协议具体长什么样。
   * 只有具名解码器给得出这些：通用定界规则不认识帧结构与命令码。
   */
  spec?: ProtocolSpec;
  /** 切帧器：自己决定一帧到哪儿为止 */
  createParser(): FrameSource;
  /** 解一帧：读成文本与字段 */
  decode(frame: Buffer): DecodedFrame;
  /**
   * 组包：把一条命令组装成字节帧。
   *
   * 「解析」是把收到的字节读成人话，「组包」反过来——给人几个参数，
   * 组装成字节发出去。能组哪些、每条要填什么参数，由解码器说了算
   * （见 builds），界面照着渲染表单，不自己猜。
   */
  encode?(request: EncodeRequest): Buffer | null;
  /** 能组哪些命令 */
  builds?: ProtocolBuild[];
}

/**
 * 把结构化字段拼成一句人话。
 *
 * 记录列表里每条只显示一行字，这行字得让人一眼看出「这是什么消息」，
 * 所以取前几个字段拼起来，值太长就截断。
 */
function summarize(fields: DecodedField[], head: string): string {
  const parts = fields
    .filter((f) => f.value && f.key)
    .slice(0, 3)
    .map((f) => `${f.key}：${f.value}`);
  const body = parts.join('，');
  if (!body) return head;
  return `${head} · ${body.length > 60 ? `${body.slice(0, 60)}…` : body}`;
}

/** 通达 LED2 解码器 */
const tongdaLed2: NamedDecoder = {
  id: LED2_DECODER_ID,
  name: '通达 LED2',
  summary: '车载屏协议：帧头 BB、硬件地址、长度、命令码、数据、16 位小端校验和、帧尾 55。',
  publisher: 'WorkHub 内置',
  version: '1.0.0',
  protocolId: LED2_DECODER_ID,
  // 车载屏是插在本机串口线上的设备
  transports: ['serial'],
  spec: {
    frame: [...LED2_FRAME_PARTS],
    addresses: [...LED2_ADDRESSES],
    // 对象字面量里的数字键（0x01）会被转成十进制字符串（"1"），
    // 所以这里得自己转回十六进制，不能直接拿 key 当码值用。
    commands: Object.entries(LED2_COMMANDS).map(([code, name]) => {
      const num = Number(code);
      return {
        code: `0x${num.toString(16).toUpperCase().padStart(2, '0')}`,
        name,
        fields: LED2_COMMAND_FIELDS[num],
      };
    }),
    notes: [
      '校验和：从硬件地址累加到最后一个数据字节，16 位、小端存放（低字节在前）。',
      'LEN=0 是长帧：真实数据长度放在 DATA0/DATA1（低字节在前）。',
      '中文一律 GBK；BCD 与十进制混用——首末班时间（0x12）是十进制，别当 BCD 读。',
    ],
  },
  createParser: () => new Led2Parser(),
  decode: (frame: Buffer): DecodedFrame => {
    const parsed = decodeLed2(frame);
    const fields: DecodedField[] = parsed.fields.map((f) => ({ key: f.key, value: f.value, raw: f.raw }));
    const head = `${parsed.device} · ${parsed.command}`;
    return {
      // 文本列放十六进制：具名协议的正文已经拆进 fields 了，
      // 再塞一遍长文本只会让表格挤成一团
      text: frame.toString('hex').toUpperCase(),
      hex: frame.toString('hex').toUpperCase(),
      fields,
      summary: summarize(fields, head),
    };
  },
};

/** JT/T 808 解码器 */
const jt808: NamedDecoder = {
  id: JT808_DECODER_ID,
  name: 'JT/T 808',
  summary:
    '道路运输车辆卫星定位系统（JT/T 808-2019）：帧标志 7E、消息体属性、序列号、消息 ID、数据长度、异或校验。' +
    '终端注册与心跳平台自动应答，也能按命令组包下发。',
  publisher: 'WorkHub 内置',
  version: '1.0.0',
  protocolId: JT808_DECODER_ID,
  // 终端是客户端、平台是服务端：走 TCP，不是串口线
  transports: ['tcp'],
  spec: {
    frame: [...JT808_FRAME_PARTS],
    commands: Object.entries(JT808_MESSAGES).map(([code, meta]) => {
      const num = Number(code);
      return {
        code: `0x${num.toString(16).toUpperCase().padStart(4, '0')}`,
        name: meta.name,
        note: `${meta.dir === 'up' ? '终端→平台' : '平台→终端'}${meta.note ? `，${meta.note}` : ''}`,
        fields: JT808_COMMAND_FIELDS[num],
      };
    }),
    notes: [
      '消息体属性 bit0~9 是消息体长度，bit13 是加密位，bit14 是分包位。',
      '校验码：消息体属性到消息体末字节逐字节异或。',
      '包内的 0x7E 转义成 0x7D 0x01，0x7D 转义成 0x7D 0x02，0x7F 转义成 0x7D 0x04（2019 版新增，老设备多半只转前两个）。',
      '终端注册（0x0001）平台必须回注册应答（0x8001），心跳（0x0002）必须回心跳应答（0x8002）——本解码器自动回。',
      '终端是客户端、平台是服务端：终端连平台的端口（常用 7612），哪条连接就是哪个终端。',
      '位置信息（0x0200）里的经纬度单位是 1e-6 度、高度 0.1 米、速度 0.1 千米/小时，时间是 BCD 的 YYMMDDHHmmss。',
    ],
  },
  createParser: () => new Jt808Parser(),
  decode: (frame: Buffer): DecodedFrame => {
    const parsed = decodeJt808(frame);
    const fields: DecodedField[] = parsed.fields;
    const code = `0x${parsed.messageId.toString(16).toUpperCase().padStart(4, '0')}`;
    return {
      text: frame.toString('hex').toUpperCase(),
      hex: frame.toString('hex').toUpperCase(),
      fields,
      summary: summarize(fields, `${parsed.messageName}（${code}）`),
      // 该回什么由解码器说了算：注册应答、心跳应答
      reply: parsed.reply,
    };
  },
  builds: JT808_BUILDS,
  encode: (request: EncodeRequest): Buffer => buildJt808Command(request),
};

/** 全部内置解码器（它们也是内置插件） */
export const BUILTIN_DECODERS: NamedDecoder[] = [tongdaLed2, jt808];
