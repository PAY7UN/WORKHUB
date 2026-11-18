/**
 * 帧解析：把一条字节流按定界规则拆成一帧帧。
 *
 * 「一条记录」是怎么来的，全在这里：
 * 字节流没有「条」的概念，全靠定界规则切出来。
 * 四种定界方式覆盖了绝大多数现场：
 *
 * - delimiter：按分隔符切（换行最常见）
 * - fixed：每 N 字节一条（定长协议）
 * - length：长度字段说了算（第几个字节、几字节、大端还是小端）
 * - timeout：不定界，闲下来就切一刀（自定义二进制协议兜底）
 *
 * 为什么放在服务端而不是前端：
 * 切帧必须跨 chunk 进行——一帧常常被拆成好几包，
 * 拿到一半的帧没法在前端拼。
 *
 * 这四种是**引擎能力**，不是协议清单：
 * 内置协议现在只有「不解析」与带具名解码器的「通达 LED2」，
 * 但要加一条新协议模板（自带 framing 的那种），底座就在这儿。
 */
import type { ChannelEncoding, DecodedField, Framing, ProtocolTemplate } from '../../shared/tools.ts';

/** 十六进制串转字节：允许空格、冒号与 0x 前缀 */
export function parseHex(input: string): Buffer {
  const cleaned = input.replace(/0x/gi, '').replace(/[\s:,-]/g, '');
  if (!cleaned) return Buffer.alloc(0);
  if (cleaned.length % 2 !== 0) throw new Error('十六进制长度必须是偶数');
  if (!/^[0-9a-f]+$/i.test(cleaned)) throw new Error('含有非十六进制字符');
  return Buffer.from(cleaned, 'hex');
}

/** 字节转十六进制（大写、无分隔） */
export function toHex(bytes: Buffer): string {
  return bytes.toString('hex').toUpperCase();
}

/**
 * 帧解析器。
 *
 * 用法：来一段字节就 push 一次，返回能确定的完整帧；
 * 通道关闭或空闲超时时 flush，把没凑齐的残余也吐出来。
 */
export class FrameParser implements FrameSource {
  private buffer: Buffer = Buffer.alloc(0);
  private readonly framing: Framing;

  constructor(framing: Framing) {
    this.framing = framing;
  }

  /** 喂进一段字节，返回本次能够确定的完整帧 */
  push(chunk: Buffer): Buffer[] {
    if (!chunk.length) return [];
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;

    switch (this.framing.kind) {
      case 'delimiter':
        return this.takeDelimited();
      case 'fixed':
        return this.takeFixed();
      case 'length':
        return this.takeLength();
      case 'timeout':
        // 不定界：等空闲超时再切，中间不产出任何帧
        return [];
    }
  }

  /** 结束（或空闲超时）时把残余吐出来 */
  flush(): Buffer[] {
    if (!this.buffer.length) return [];
    const rest = this.buffer;
    this.buffer = Buffer.alloc(0);
    return [rest];
  }

  /** 还压在手里的字节数（提示「半帧」时用得上） */
  pending(): number {
    return this.buffer.length;
  }

  /** 按分隔符切：分隔符本身不计入帧内容 */
  private takeDelimited(): Buffer[] {
    const delimiter = parseHex(this.framing.delimiter ?? '0d0a');
    if (!delimiter.length) return [];

    const frames: Buffer[] = [];
    for (;;) {
      const idx = this.buffer.indexOf(delimiter);
      if (idx === -1) break;
      if (idx > 0) frames.push(this.buffer.subarray(0, idx));
      this.buffer = this.buffer.subarray(idx + delimiter.length);
    }
    return frames;
  }

  /** 定长：每 N 字节一条 */
  private takeFixed(): Buffer[] {
    const size = this.framing.fixedLength ?? 0;
    if (size <= 0) return [];

    const frames: Buffer[] = [];
    while (this.buffer.length >= size) {
      frames.push(this.buffer.subarray(0, size));
      this.buffer = this.buffer.subarray(size);
    }
    return frames;
  }

  /** 长度字段：值就是本帧多长 */
  private takeLength(): Buffer[] {
    const offset = this.framing.lengthOffset ?? 0;
    const size = this.framing.lengthSize ?? 2;
    if (offset < 0 || size <= 0 || size > 4) return [];

    const headerSize = offset + size;
    const frames: Buffer[] = [];
    for (;;) {
      if (this.buffer.length < headerSize) break;
      const value = this.readLength(this.buffer, offset, size);
      // 长度字段算不算它自己那几个字节，由协议说了算
      const total = this.framing.lengthIncludesHeader ? value : value + headerSize;
      if (total <= 0 || total > 1024 * 1024) break;
      if (this.buffer.length < total) break;
      frames.push(this.buffer.subarray(0, total));
      this.buffer = this.buffer.subarray(total);
    }
    return frames;
  }

  /** 读长度字段 */
  private readLength(buf: Buffer, offset: number, size: number): number {
    const slice = buf.subarray(offset, offset + size);
    if (this.framing.lengthEndian === 'le') {
      // 小端：先到的字节是低位
      let value = 0;
      for (let i = slice.length - 1; i >= 0; i--) value = value * 256 + slice[i];
      return value;
    }
    let value = 0;
    for (const byte of slice) value = value * 256 + byte;
    return value;
  }
}

/** 解码出来的一帧 */
export interface DecodedFrame {
  /** 按编码解码后的文本 */
  text: string;
  /** 原始字节的十六进制 */
  hex: string;
  /** 模板要求按 JSON 解析时的结构化结果 */
  parsed?: unknown;
  /** 具名解码器读出来的字段列表 */
  fields?: DecodedField[];
  /** 具名解码器给出的摘要 */
  summary?: string;
}

/**
 * 切帧器的统一外形。
 *
 * 通用定界器（FrameParser）与具名解码器自带的切帧器（如 Led2Parser）
 * 对上层是同一件事：喂进字节，吐出切好的帧。抽象成这一个形状，
 * 会话管理器就不必知道底下用的是哪套切帧规则。
 */
export interface FrameSource {
  /** 喂进一段字节，返回本次能够确定的完整帧 */
  push(chunk: Buffer): Buffer[];
  /** 结束（或空闲超时）时把残余吐出来 */
  flush(): Buffer[];
  /** 还压在手里的字节数 */
  pending(): number;
}

/**
 * 解码一帧。
 *
 * 编码决定「怎么读」，hex 那份始终留着：
 * 现场调试时最常问的是「原始字节到底是什么」，
 * 只给解码后的文本会让人怀疑是自己读错了。
 */
export function decodeFrame(bytes: Buffer, template: ProtocolTemplate): DecodedFrame {
  const hex = toHex(bytes);
  const text = decodeText(bytes, template.encoding);

  if (!template.json) return { text, hex };

  try {
    return { text, hex, parsed: JSON.parse(text) as unknown };
  } catch {
    // 解析不了不算错：这帧可能本来就不是 JSON，留原文即可
    return { text, hex };
  }
}

/** 按编码把字节读成文本 */
export function decodeText(bytes: Buffer, encoding: ChannelEncoding): string {
  switch (encoding) {
    case 'utf8':
      return bytes.toString('utf8');
    case 'latin1':
      return bytes.toString('latin1');
    case 'ascii':
      return bytes.toString('ascii');
    case 'hex':
      return toHex(bytes);
  }
}
