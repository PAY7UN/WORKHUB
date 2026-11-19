/**
 * 协议详情 → 记录区里的速查。
 *
 * 有帧结构与命令码（解析器给得出）、却没随代码带说明书的协议，
 * 就用协议详情生成一份速查放进记录区。
 *
 * 为什么要这一步：协议详情曾经就地摊在工具区里，那条路已经删了——
 * 工具区只留一个入口，内容得住进记录区，跟说明书住在一起。
 * 有说明书就不生成：说明书是给人写的，比自动生成的速查全，
 * 两份摆在一起只会互相盖。
 */
import type { ProtocolSpec, TransportScope } from '../../shared/tools.ts';
import { findTemplate } from '../../shared/tools.ts';
import { builtinDocNodeIdFor, seedPluginDoc } from '../builtinDocs.ts';
import { BUILTIN_DECODERS } from './decoders/index.ts';
import { specMarkdown } from './specMarkdown.ts';

/**
 * 用协议详情生成一份速查，放进记录区的内置目录。
 *
 * 已经有说明书的不生成。生成失败也不拦服务：速查只是资料，
 * 缺一份不该让整个站起不来。
 *
 * scope 是这套解析适用的接入方式：决定它落在「串口」还是「网口」目录里。
 */
export function seedSpecDoc(
  protocolId: string,
  title: string,
  spec: ProtocolSpec,
  scope?: TransportScope,
): boolean {
  if (builtinDocNodeIdFor(protocolId)) return false;
  const markdown = specMarkdown(spec, title);
  if (!markdown) return false;
  try {
    seedPluginDoc(protocolId, markdown, title, scope);
    return true;
  } catch {
    return false;
  }
}

/** 内置解码器带来的协议：没说明书就用协议详情生成一份 */
export function ensureBuiltinSpecDocs(): void {
  for (const decoder of BUILTIN_DECODERS) {
    if (!decoder.spec) continue;
    const protocolId = decoder.protocolId ?? decoder.id;
    const title = findTemplate(protocolId)?.name ?? decoder.name;
    seedSpecDoc(protocolId, title, decoder.spec, decoder.transports);
  }
}
