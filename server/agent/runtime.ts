/**
 * agent 运行时：一个 agent 自己跑的循环。
 *
 * 循环长这样：
 *   想 → 做一个动作 → 看结果 → 再想 → …… → 收工
 *
 * 动作只有四种：调工具、派活给别人、反问用户、收工给结论。
 * 每次只做一个动作——多动作的模型看起来利索，实际上出问题时无法定位是哪一步错了，
 * 而且中途失败就全盘皆输。
 *
 * 模型为什么用「正文 + JSON 块」而不是官方的 tool_calls：
 * 上游是各家 OpenAI 兼容网关，对 tools 的支持参差不齐；
 * 而正文还有额外好处——它就是给人看的进展说明，白捡。
 */
import type { AgentAction, AgentEvent, AgentRole } from '../../shared/agent.ts';
import { extractJsonBlock, stripJsonBlock, VisibleTextFilter } from '../../shared/jsonBlock.ts';
import { readUpstreamStream, type UpstreamMessage } from '../upstream.ts';
import { findSkill } from '../skills/registry.ts';
import { findSkillRunner, type SkillRunContext, type SkillRunResult } from '../skills/runners.ts';
import { insertAgentUsage } from '../db.ts';
import type { AgentSettings } from '../../shared/types.ts';
import { findAgentRole } from './roles.ts';

/** 一次对话里的一轮 */
export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

/** 跑一个 agent 的输入 */
export interface RunAgentOptions {
  /** 谁在跑 */
  role: AgentRole;
  /** 这一轮要做的事 */
  task: string;
  /** 之前的对话 */
  history?: ChatTurn[];
  /** 模型配置 */
  cfg: AgentSettings;
  /** 执行者 */
  userId: string;
  isAdmin: boolean;
  signal?: AbortSignal;
  /** 事件出口 */
  onEvent?: (event: AgentEvent) => void;
  /** 委派深度：0 是总控，往下逐层加 */
  depth?: number;
  /** 最多走几步 */
  maxSteps?: number;
}

/** 跑完的结果 */
export interface RunAgentOutcome {
  /** 最终回答 */
  text: string;
  /** 是不是在反问用户 */
  asked: boolean;
  /** 用过的能力 */
  usedSkills: string[];
}

/** 最多走几步：再多就是在原地打转 */
const DEFAULT_MAX_STEPS = 8;
/** 最多往下派几层：总控 → 专业 agent 就够了 */
const MAX_DELEGATE_DEPTH = 1;
/** 工具结果喂回模型时的长度上限：太长会把上下文撑爆 */
const MAX_TOOL_TEXT = 6000;

/* ------------------------------ 提示词 ------------------------------ */

/** 一份能力的参数说明 */
function describeParams(skillId: string): string {
  const skill = findSkill(skillId);
  if (!skill || !skill.params.length) return '';
  return skill.params.map((p) => `${p.key}${p.required ? '（必填）' : ''}`).join('、');
}

/**
 * 给模型看的工具清单。
 *
 * 只列这个角色能用的：模型看不到不该用的工具，就不会去惦记它们。
 */
function toolSection(role: AgentRole): string {
  const lines: string[] = [];
  for (const id of role.tools) {
    const skill = findSkill(id);
    if (!skill) continue;
    const params = describeParams(id);
    lines.push(`- ${id}（${skill.name}）：${skill.description || skill.summary}${params ? `｜参数：${params}` : ''}`);
  }
  if (!lines.length) return '（你没有可用的工具）';
  return lines.join('\n');
}

/** 能派给谁 */
function delegateSection(role: AgentRole): string {
  if (!role.canDelegate) return '';
  const targets = ['web', 'data', 'docs']
    .map((id) => findAgentRole(id))
    .filter((r): r is AgentRole => Boolean(r));
  if (!targets.length) return '';
  return targets.map((t) => `- ${t.id}（${t.name}）：${t.summary}`).join('\n');
}

/** 动作协议说明 */
const PROTOCOL = [
  '输出格式：',
  '先用一两句话说你现在要做什么（这段会实时显示给用户，别写内心戏，写要做什么）。',
  '然后给出一个 json 代码块，块里是这一步的动作：',
  '',
  '```json',
  '{"action":"tool","skillId":"能力 id","params":{"参数名":"值"},"reason":"为什么这么做"}',
  '```',
  '',
  '动作只有四种：',
  '- tool：调一份能力。skillId 必须是你清单里的 id，params 是它的参数。',
  '- delegate：把活儿派给另一个 agent。agentId 用下面的 id，instruction 写清要它做什么（要自足，别写「上面那些」）。',
  '- ask：反问用户。instruction 写要问什么——缺关键信息时用这个，不要猜。',
  '- answer：收工。text 写给用户的最终回答，可以分几段。',
  '',
  '一次只给一个动作。拿到结果再决定下一步。',
].join('\n');

/** 拼出系统提示 */
function buildSystemPrompt(role: AgentRole): string {
  const parts = [role.systemPrompt, '', PROTOCOL, '', '你可用的能力：', toolSection(role)];
  const delegates = delegateSection(role);
  if (delegates) {
    parts.push('', '你能派给这些 agent：', delegates);
  }
  return parts.join('\n');
}

/* ------------------------------ 动作解析 ------------------------------ */

/** 把 JSON 里的参数摊平成字符串字典 */
function normalizeParams(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (value === null || value === undefined) continue;
    if (typeof value === 'object') {
      out[key] = JSON.stringify(value);
    } else {
      out[key] = String(value);
    }
  }
  return out;
}

/**
 * 从模型输出里解析出动作。
 *
 * 认三种形态：
 * - 有 JSON 块：按动作协议解析；
 * - JSON 坏了但有正文：正文就是回答（模型放弃结构化、改说话了）；
 * - 什么都没有：也算回答，交给上层判定。
 */
export function parseAction(raw: string): { action?: AgentAction; broken?: boolean } {
  const prose = stripJsonBlock(raw).trim();
  const block = extractJsonBlock(raw);
  if (!block) return { action: { kind: 'answer', text: prose } };

  let parsed: unknown;
  try {
    parsed = JSON.parse(block);
  } catch {
    return prose ? { action: { kind: 'answer', text: prose } } : { broken: true };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return prose ? { action: { kind: 'answer', text: prose } } : { broken: true };
  }

  const obj = parsed as Record<string, unknown>;
  const kindRaw = String(obj.action ?? obj.type ?? '').toLowerCase();
  const reason = typeof obj.reason === 'string' ? obj.reason : undefined;

  if (kindRaw === 'tool' || kindRaw === 'call' || kindRaw === 'skill') {
    const skillId = String(obj.skillId ?? obj.skill ?? obj.tool ?? obj.id ?? '').trim();
    return {
      action: {
        kind: 'tool',
        skillId,
        params: normalizeParams(obj.params ?? obj.arguments ?? obj.args),
        reason,
      },
    };
  }
  if (kindRaw === 'delegate' || kindRaw === 'handoff') {
    return {
      action: {
        kind: 'delegate',
        agentId: String(obj.agentId ?? obj.agent ?? obj.to ?? '').trim(),
        instruction: String(obj.instruction ?? obj.task ?? obj.message ?? '').trim(),
        reason,
      },
    };
  }
  if (kindRaw === 'ask' || kindRaw === 'question') {
    return {
      action: {
        kind: 'ask',
        instruction: String(obj.instruction ?? obj.question ?? obj.text ?? '').trim(),
        reason,
      },
    };
  }
  if (kindRaw === 'answer' || kindRaw === 'final' || kindRaw === 'done') {
    return { action: { kind: 'answer', text: String(obj.text ?? obj.answer ?? obj.content ?? prose).trim(), reason } };
  }

  // 动作名不认识：有正文就当回答，没有就当坏动作
  return prose ? { action: { kind: 'answer', text: prose } } : { broken: true };
}

/* ------------------------------ 运行 ------------------------------ */

/** 跑一个 agent */
export async function runAgent(opts: RunAgentOptions): Promise<RunAgentOutcome> {
  const {
    role,
    task,
    history = [],
    cfg,
    userId,
    isAdmin,
    signal,
    onEvent,
    depth = 0,
    maxSteps = DEFAULT_MAX_STEPS,
  } = opts;

  const emit = (event: AgentEvent) => {
    try {
      onEvent?.(event);
    } catch {
      /* 事件出口坏了不该带崩主流程 */
    }
  };

  emit({ type: 'agent.start', agentId: role.id, agentName: role.name, task });

  const messages: UpstreamMessage[] = [
    { role: 'system', content: buildSystemPrompt(role) },
    ...history.map((h) => ({ role: h.role, content: h.content })),
    { role: 'user', content: task },
  ];

  /** 这轮用过的能力：去重，且把子 agent 用过的也算进来 */
  const usedSkills = new Set<string>();
  /** 上一次工具的产出：下一步可以接着算，不用再取一遍 */
  let lastOutput = '';

  for (let step = 0; step < maxSteps; step += 1) {
    const call = await callModel(cfg, messages, signal, (text) => emit({ type: 'delta', agentId: role.id, text }));

    if (call.error) {
      emit({ type: 'error', message: call.error });
      return { text: call.error, asked: false, usedSkills: [...usedSkills] };
    }

    const { action, broken } = parseAction(call.text);

    if (broken || !action) {
      messages.push({ role: 'assistant', content: call.text });
      messages.push({ role: 'user', content: '你给的 JSON 解析不了。请只给一个动作，格式照示例来。' });
      continue;
    }

    if (action.kind === 'answer') {
      const text = (action.text ?? '').trim() || '（没有给出内容）';
      emit({ type: 'agent.done', agentId: role.id, agentName: role.name, text });
      return { text, asked: false, usedSkills: [...usedSkills] };
    }

    if (action.kind === 'ask') {
      const text = action.instruction?.trim() || '（模型想反问但没说清楚要问什么）';
      emit({ type: 'agent.done', agentId: role.id, agentName: role.name, text });
      return { text, asked: true, usedSkills: [...usedSkills] };
    }

    if (action.kind === 'tool') {
      const outcome = await runTool(action, {
        role,
        cfg,
        userId,
        isAdmin,
        signal,
        lastOutput,
        emit,
      });
      if (outcome.usedSkill) usedSkills.add(outcome.usedSkill);
      if (outcome.ok) lastOutput = outcome.payload ?? '';
      messages.push({ role: 'assistant', content: call.text });
      messages.push({ role: 'user', content: outcome.text });
      continue;
    }

    // delegate
    const target = findAgentRole(action.agentId ?? '');
    if (!target) {
      messages.push({ role: 'assistant', content: call.text });
      messages.push({
        role: 'user',
        content: `没有这个 agent：${action.agentId || '（空）'}。能派给谁，看你的清单。`,
      });
      continue;
    }
    if (depth >= MAX_DELEGATE_DEPTH) {
      messages.push({ role: 'assistant', content: call.text });
      messages.push({ role: 'user', content: '不能再往下派了，这活儿你自己做。' });
      continue;
    }

    const instruction = action.instruction?.trim();
    emit({
      type: 'delegate',
      agentId: role.id,
      toAgentId: target.id,
      toAgentName: target.name,
      instruction: instruction ?? '',
    });

    const subTask = [`原始需求：${task}`, '', `你的分工：${instruction || target.summary}`].join('\n');
    const sub = await runAgent({
      role: target,
      task: subTask,
      cfg,
      userId,
      isAdmin,
      signal,
      onEvent: onEvent,
      depth: depth + 1,
      maxSteps,
    });

    messages.push({ role: 'assistant', content: call.text });
    messages.push({
      role: 'user',
      content: [`【${target.name}】的回报：`, sub.text].join('\n'),
    });
    // 子 agent 用过的能力也算这轮用过的：对外只交代一次，交代全
    for (const id of sub.usedSkills) usedSkills.add(id);
    if (sub.asked) {
      // 子 agent 在反问用户：把问题原样带上去，让总控来问
      emit({ type: 'agent.done', agentId: role.id, agentName: role.name, text: sub.text });
      return { text: sub.text, asked: true, usedSkills: [...usedSkills] };
    }
  }

  // 步数用完：让模型直接给结论，不要再拖
  messages.push({ role: 'user', content: '不要再调工具了。就用手上已有的结果，给用户一份结论。' });
  const final = await callModel(cfg, messages, signal, (text) => emit({ type: 'delta', agentId: role.id, text }));
  const text = final.error ? final.error : stripJsonBlock(final.text).trim() || '（没有给出结论）';
  emit({ type: 'agent.done', agentId: role.id, agentName: role.name, text });
  return { text, asked: false, usedSkills: [...usedSkills] };
}

/** 调一次模型，把正文攒起来 */
async function callModel(
  cfg: AgentSettings,
  messages: UpstreamMessage[],
  signal: AbortSignal | undefined,
  onVisible: (text: string) => void,
): Promise<{ text: string; error?: string }> {
  const filter = new VisibleTextFilter();
  let text = '';
  let error: string | undefined;

  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort);

  await readUpstreamStream({
    cfg,
    messages,
    signal: controller.signal,
    handlers: {
      onDelta: (chunk) => {
        text += chunk;
        const visible = filter.feed(chunk);
        if (visible) onVisible(visible);
      },
      onError: (message) => {
        error = message;
      },
      onUsage: (usage) => {
        insertAgentUsage({ scene: 'chat', model: cfg.model, usage });
      },
    },
  });

  if (controller.signal.aborted && signal?.aborted && !error) error = '已中止';
  signal?.removeEventListener('abort', onAbort);

  return { text, error };
}

/** 调一份能力 */
async function runTool(
  action: { skillId?: string; params?: Record<string, string>; reason?: string },
  ctx: {
    role: AgentRole;
    cfg: AgentSettings;
    userId: string;
    isAdmin: boolean;
    signal?: AbortSignal;
    lastOutput: string;
    emit: (event: AgentEvent) => void;
  },
): Promise<{ ok: boolean; text: string; usedSkill?: string; payload?: string }> {
  const skillId = action.skillId ?? '';
  const skill = findSkill(skillId);

  if (!skill) {
    return { ok: false, text: `没有这个能力：${skillId || '（空）'}。可用的是：${ctx.role.tools.join('、')}` };
  }
  if (!ctx.role.tools.includes(skillId)) {
    return { ok: false, text: `你不许用 ${skillId}。你能用的是：${ctx.role.tools.join('、')}` };
  }
  const runner = findSkillRunner(skillId);
  if (!runner) {
    return { ok: false, text: `${skillId} 没有可执行的服务端实现，跑不了。` };
  }

  ctx.emit({
    type: 'tool.start',
    agentId: ctx.role.id,
    skillId,
    skillName: skill.name,
    params: action.params ?? {},
  });

  const runCtx: SkillRunContext = {
    userId: ctx.userId,
    isAdmin: ctx.isAdmin,
    cfg: ctx.cfg,
    upstream: ctx.lastOutput,
    signal: ctx.signal,
  };

  let result: SkillRunResult;
  try {
    result = await runner(action.params ?? {}, runCtx);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ctx.emit({
      type: 'tool.result',
      agentId: ctx.role.id,
      skillId,
      skillName: skill.name,
      ok: false,
      summary: '失败',
      output: message,
    });
    return {
      ok: false,
      usedSkill: skillId,
      text: `${skill.name} 跑失败了：${message}\n换个办法，或者改用别的做法。`,
    };
  }

  const output = result.output ?? '';
  ctx.emit({
    type: 'tool.result',
    agentId: ctx.role.id,
    skillId,
    skillName: skill.name,
    ok: true,
    summary: result.summary,
    output: output.length > 2000 ? `${output.slice(0, 2000)}…` : output,
  });

  const truncated = output.length > MAX_TOOL_TEXT ? `${output.slice(0, MAX_TOOL_TEXT)}…（已截断）` : output;
  return {
    ok: true,
    usedSkill: skillId,
    payload: result.payload ?? output,
    text: [`【${skill.name}】${result.summary}`, '', truncated].join('\n'),
  };
}
