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
import type { DecodedField, ProtocolSpec } from '../../../shared/tools.ts';
import type { DecodedFrame, FrameSource } from '../parser.ts';
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

/** 全部内置解码器（它们也是内置插件） */
export const BUILTIN_DECODERS: NamedDecoder[] = [tongdaLed2];
