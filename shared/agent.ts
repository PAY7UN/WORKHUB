/**
 * 对话式 agent 的共享契约。
 *
 * 这一层只定义形状：动作、角色、事件。
 * 具体的循环在 server/agent/runtime.ts，前端渲染在 src/components/app/AgentPanel.tsx。
 *
 * 为什么动作是一份 JSON 而不是「工具调用」：
 * 上游是 OpenAI 兼容接口，各家网关对 tools/tool_calls 的支持参差不齐。
 * 用「正文 + 一个 JSON 块」当协议，所有兼容网关都认，
 * 而且模型的思考过程能原样留在正文里，用户看得见它为什么这么做。
 */

/**
 * agent 能做的四件事。
 *
 * - `tool`：调一份能力（skill）。
 * - `delegate`：把活儿派给另一个 agent（专业分工）。
 * - `ask`：反问用户（缺信息时不要瞎猜）。
 * - `answer`：收工，给出最终回答。
 */
export type AgentActionKind = 'tool' | 'delegate' | 'ask' | 'answer';

/** 模型给出的一个动作 */
export interface AgentAction {
  kind: AgentActionKind;
  /** kind==='tool'：能力 id */
  skillId?: string;
  /** kind==='tool'：参数 */
  params?: Record<string, string>;
  /** kind==='delegate'：目标 agent id */
  agentId?: string;
  /** kind==='delegate' / 'ask'：要交给对方的话 */
  instruction?: string;
  /** kind==='answer'：给用户的最终回答 */
  text?: string;
  /** 模型自己的说明：为什么这么做（给人看） */
  reason?: string;
}

/**
 * 一个 agent 角色。
 *
 * 角色 = 系统提示 + 工具白名单。
 * 白名单是边界而不是建议：文档检索的 agent 不该能发网络请求，
 * 网页 agent 也不该能读到库里加密文档的正文。
 */
export interface AgentRole {
  id: string;
  name: string;
  /** 一句话说明这个 agent 负责什么 */
  summary: string;
  /** 系统提示：角色设定与工作方式 */
  systemPrompt: string;
  /** 可调用的能力 id */
  tools: string[];
  /** 能不能把活儿派给别的 agent */
  canDelegate: boolean;
}

/** agent 运行时往外推的事件 */
export type AgentEvent =
  /** 某个 agent 开始干活 */
  | { type: 'agent.start'; agentId: string; agentName: string; task: string }
  /** 模型正文增量（给人看的进展） */
  | { type: 'delta'; agentId: string; text: string }
  /** 开始调能力 */
  | {
      type: 'tool.start';
      agentId: string;
      skillId: string;
      skillName: string;
      params: Record<string, string>;
    }
  /** 能力跑完了 */
  | {
      type: 'tool.result';
      agentId: string;
      skillId: string;
      skillName: string;
      ok: boolean;
      summary: string;
      output: string;
    }
  /** 把活儿派给了另一个 agent */
  | {
      type: 'delegate';
      agentId: string;
      toAgentId: string;
      toAgentName: string;
      instruction: string;
    }
  /** 某个 agent 收工了 */
  | { type: 'agent.done'; agentId: string; agentName: string; text: string }
  /** 出错了 */
  | { type: 'error'; message: string };

/** 一轮对话的输入 */
export interface AgentChatRequest {
  /** 这一轮用户说的话 */
  message: string;
  /** 历史对话（不含本轮） */
  history?: Array<{ role: 'user' | 'assistant'; content: string }>;
  /** 指定由哪个 agent 起手；不填走总控 */
  agentId?: string;
}

/** 一次对话的结果 */
export interface AgentChatResult {
  /** 最终回答 */
  answer: string;
  /** 用过的能力 id */
  usedSkills: string[];
  /** 是否反问了用户 */
  asked: boolean;
}
