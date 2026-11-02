/**
 * 上游模型流式读取。
 *
 * 本模块只负责「读上游 → 解析 SSE 帧 → 分发 reasoning / delta / 错误」，
 * 不持有也不触碰 Express 响应，因此既能服务于问答的边读边转发（SSE 直出），
 * 也能服务于润色的后台任务（客户端断开后仍需继续跑完并留存结果）。
 * 两条链路必须共用本模块，否则错误文案会在润色与问答之间出现分歧。
 */
import type { AgentSettings } from '../shared/types.ts';
import { redact } from '../shared/redact.ts';

/**
 * 上游下发的 token 用量。
 *
 * 字段全部可选：各家实现给的东西并不一致，缺失时按 0 处理而非报错——
 * 用量只用于统计，采集不到不该影响主流程。
 */
export interface TokenUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
}

/** 上游模型返回的 SSE 载荷：字段随厂商与模型而异，按实际读取的键声明 */
export interface SseChunk {
  error?: { message?: string; status_code?: number | string; status_msg?: string };
  base_resp?: { message?: string; status_code?: number | string; status_msg?: string };
  message?: string;
  choices?: Array<{ delta?: { content?: unknown; reasoning_content?: unknown } }>;
  usage?: TokenUsage | null;
}

export interface UpstreamHandlers {
  /** 推理模型（M3 等）的思考内容 */
  onReasoning?: (text: string) => void;
  /** 正文增量；返回 false 表示调用方已提前终止本次读取 */
  onDelta?: (text: string) => boolean | void;
  /** 已映射为用户可读文案的失败原因 */
  onError?: (message: string) => void;
  /** 本次调用的 token 用量；仅在流末尾收到带 usage 的帧时触发一次 */
  onUsage?: (usage: TokenUsage) => void;
}

export class UpstreamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UpstreamError';
  }
}

/**
 * 发往上游的消息。
 *
 * content 为纯文本：问答与润色两条链路都用字符串形式，因此共用同一个流式读取实现，
 * 错误映射与空响应判定不会在两边出现分歧。
 */
export type UpstreamMessage = {
  role: string;
  content: string;
};

/**
 * 上游 status_code → 用户可读文案。
 *
 * 必须映射而不能原样透传：MiniMax 这类网关给出的是 `output new_sensitive (1027)`
 * 之类的内部码，用户看到只会以为程序坏了，既不知道该换预设、拆文档还是换模型。
 * 未收录的码一律回落到原文案，至少不丢信息。
 */
function describeUpstreamError(statusCode: number, raw: string): string {
  const detail = raw.trim();
  switch (statusCode) {
    case 1002:
      return '模型服务限流，请稍后重试，或减少同时进行的润色任务';
    case 1004:
      return '模型账号额度不足，请检查账户余额';
    case 1008:
      return 'API Key 无效或无权限，请到 Agent 设置中重新填写';
    case 1027:
      // 输出阶段的内容审核拦截：模型改写到中途被判违规，整篇作废。
      // 它与文档写得好坏无关，常规手段是压低改动幅度或换一家模型
      return '模型输出被上游内容审核拦截：改写过程中触发了供应商的敏感词规则，本次润色未产生结果。' +
        '可改用改动更小的预设（校对 / 精简）、把长文拆开分段润色，或更换模型后重试';
    default:
      return detail || (Number.isFinite(statusCode) ? `模型服务返回错误（${statusCode}）` : '模型服务返回错误');
  }
}

/**
 * 流式调用上游模型并把内容分发给 handlers。
 *
 * 本函数在结束、失败或被提前终止时均自行 resolve，不向调用方抛出——
 * 错误一律经 onError 上报，避免每个调用点各写一遍 try/catch 而漏掉状态收敛。
 */
export async function readUpstreamStream(opts: {
  cfg: AgentSettings;
  messages: UpstreamMessage[];
  signal: AbortSignal;
  handlers: UpstreamHandlers;
}): Promise<void> {
  const { cfg, messages, signal, handlers } = opts;
  const { onReasoning, onDelta, onError, onUsage } = handlers;
  const endpoint = `${cfg.baseUrl.replace(/\/+$/, '')}/chat/completions`;

  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const upstream = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.apiKey}`,
        ...(cfg.groupId ? { 'MiniMax-Group-Id': cfg.groupId } : {}),
      },
      body: JSON.stringify({
        model: cfg.model,
        messages,
        temperature: cfg.temperature,
        stream: true,
        // OpenAI 兼容协议中 include_usage 默认为 false，网关据此决定是否下发 token 用量；
        // 统计功能依赖它，故显式声明。未知字段会被网关忽略，实测带该参数请求正常返回
        stream_options: { include_usage: true },
      }),
      signal,
    });

    if (!upstream.ok || !upstream.body) {
      // 上游错误体原文可能回显请求内容（含 Authorization 头），脱敏后再往外发
      const detail = redact((await upstream.text().catch(() => '')).slice(0, 300));
      const hint =
        upstream.status === 401 || upstream.status === 403
          ? 'API Key 无效或无权限'
          : upstream.status === 404
            ? '接口地址或模型名不正确'
            : upstream.status === 429
              ? '触发限流或额度不足'
              : `模型服务返回 HTTP ${upstream.status}`;
      onError?.(`${hint}${detail ? `：${detail}` : ''}`);
      return;
    }

    reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let emitted = 0;
    let hasReasoning = false;
    // 被调用方主动终止：与失败区分开，不应再触发 onError
    let stopped = false;

    const handlePayload = (payload: string) => {
      if (!payload || payload === '[DONE]' || stopped) return;
      let obj: SseChunk;
      try {
        obj = JSON.parse(payload);
      } catch {
        return; // 心跳等非 JSON 行
      }
      // usage 必须先于错误分支提取：该帧同时带 base_resp.status_code = 0，
      // 会被下面的错误判定 return 掉。放在其后就永远收不到 token 数——
      // 而它恰好出现在 [DONE] 前一帧，是整个流里唯一有 usage 的地方。
      // 此处不 return：usage 帧 choices 为空，继续往下走不会产生副作用。
      if (obj?.usage) onUsage?.(obj.usage);
      // 部分网关以 HTTP 200 返回 JSON 错误体，这里统一转成错误
      const apiError = obj?.error ?? obj?.base_resp;
      if (apiError) {
        const code = apiError.status_code === undefined ? NaN : Number(apiError.status_code);
        const raw = redact(String(apiError.message ?? apiError.status_msg ?? obj?.message ?? ''));
        // status_code 为 0 表示业务层成功，不算错误
        if (apiError.status_code === undefined || Number(apiError.status_code) !== 0) {
          onError?.(describeUpstreamError(code, raw));
          stopped = true;
        }
        return;
      }
      const delta = obj?.choices?.[0]?.delta ?? {};
      const think = typeof delta.reasoning_content === 'string' ? delta.reasoning_content : '';
      const text = typeof delta.content === 'string' ? delta.content : '';
      if (think) {
        hasReasoning = true;
        onReasoning?.(think);
      }
      if (text) {
        emitted++;
        if (onDelta?.(text) === false) {
          stopped = true;
          return;
        }
      }
    };

    for (;;) {
      if (stopped) break;
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('data:')) handlePayload(trimmed.slice(5).trim());
      }
    }
    // 处理末尾没有换行符的残留载荷
    if (!stopped) {
      const rest = buffer.trim();
      if (rest.startsWith('data:')) handlePayload(rest.slice(5).trim());
    }

    if (stopped) {
      await reader.cancel().catch(() => undefined);
      return;
    }

    // 避免静默空白：没有任何正文时给出可定位的原因
    if (emitted === 0) {
      onError?.(
        hasReasoning
          ? '模型只返回了思考过程而未输出正文，请重试，或在 Agent 设置里改用非推理模型'
          : '模型未返回任何内容，请检查模型名与 API Key，或稍后重试',
      );
    }
  } catch (e) {
    if ((e as Error)?.name === 'AbortError') {
      // 取消属预期行为，不算失败；调用方需自行把任务收敛到终态
      return;
    }
    onError?.(`调用模型服务失败：${(e as Error)?.message ?? '网络异常'}`);
  } finally {
    reader?.releaseLock?.();
  }
}