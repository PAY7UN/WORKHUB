/**
 * 会话汇总：把一份会话痕迹喂给模型，要回一段「这个会话干了什么」。
 *
 * 复用 agent 的配置与上游实现（同一份凭据、同一套错误文案），
 * 不走 runAgent——那是带工具循环的交互流，这里只需要一次「进文本、出文本」。
 * 「流式收整段」的样板照抄 server/skills/runners.ts 的 agentAsk。
 */
import { readUpstreamStream } from '../upstream.ts';
import type { AgentSettings } from '../../shared/types.ts';
import type { SessionTrace } from './codebuddy.ts';
import { traceToPrompt } from './codebuddy.ts';

const SYSTEM_PROMPT = `你是一个开发工作日志的撰写助手。用户会给你一个编码会话里改动的文件清单与 diff，请你推断这个会话在做什么，输出一份简短的中文小结。

要求：
- 按这个骨架输出（没有对应内容的小节写「未发现」）：
  **干了什么**：一两句话概括会话目的与主要改动。
  **查了什么问题**：从 diff 推断过程中排查/调研的问题。
  **结论**：改动的最终效果或方向；如果 diff 看不出结论，就写「尚未完成」。
- 只依据 diff 与文件路径推断，禁止编造 diff 里没有的事实。
- 总长不超过 150 字，不使用列表以外的修饰，不提「diff」「用户」这些词。`;

const USER_TEMPLATE = (trace: string) => `${trace}\n\n请按系统要求输出小结。`;

/**
 * 调一次模型拿小结。失败抛错（调度器记日志、下轮重试），成功返回纯文本。
 */
export async function summarizeSession(
  cfg: AgentSettings,
  trace: SessionTrace,
  signal?: AbortSignal,
): Promise<string> {
  const controller = new AbortController();
  signal?.addEventListener('abort', () => controller.abort(), { once: true });
  let answer = '';
  let failure = '';
  await readUpstreamStream({
    cfg,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: USER_TEMPLATE(traceToPrompt(trace)) },
    ],
    signal: controller.signal,
    handlers: {
      onDelta: (text) => {
        answer += text;
      },
      onError: (message) => {
        failure = message;
      },
    },
  });
  if (failure) throw new Error(failure);
  const text = answer.trim();
  if (!text) throw new Error('模型未返回任何内容');
  return text;
}
