/**
 * 协议的几句现成话。
 *
 * 协议名、摘要、切帧方式、文档来源——这几样东西要在好几个地方出现：
 * 工具展示页摆协议块、协议索引页摆一行、协议详情页摆头部。
 * 各写一遍就会走样（有的地方说「按 0xAA 切帧」，有的地方说「按分隔符切帧」），
 * 所以只在这里说一次。
 */
import type { ProtocolDocRef, ProtocolTemplate } from '../../../../shared/tools';

/** 定界规则：说人话 */
export function framingText(template: ProtocolTemplate): string {
  const f = template.framing;
  switch (f.kind) {
    case 'delimiter':
      return `按分隔符 0x${f.delimiter ?? ''} 切帧`;
    case 'fixed':
      return `每帧固定 ${f.fixedLength ?? 0} 字节`;
    case 'length':
      return `长度字段在第 ${f.lengthOffset ?? 0} 字节、${f.lengthSize ?? 2} 字节，${
        f.lengthEndian === 'le' ? '小端' : '大端'
      }`;
    case 'timeout':
      return `不定界：空闲 ${f.idleMs ?? 200} 毫秒切一条`;
    default:
      return '按插件规则切帧';
  }
}

/**
 * 文档来源：说人话。
 *
 * 说明书只有两种：代码里带来的「内置」，和现场改过的「现场版」。
 * 以前还有「导入」「插件自带」两类，现在它们都是记录区里同一篇文档的来历，
 * 不再是文档的两种形态。
 */
export function docOriginLabel(origin: ProtocolDocRef['origin']): string {
  switch (origin) {
    case 'local':
      return '现场改过';
    default:
      return '内置';
  }
}
