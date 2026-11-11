/**
 * agent 循环的端到端测试。
 *
 * 这里不测解析（解析有单测），测的是**整条链路接不接得上**：
 * 模型说要调能力 → 能力真的跑了 → 结果真的喂回模型 → 模型接着做 → 最后给出结论。
 *
 * 上游用一个假的 OpenAI 兼容服务顶上：
 * 按对话轮次返回不同的动作，于是整个循环可以被完整地走一遍，
 * 不需要真的联网调模型。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const workDir = mkdtempSync(join(tmpdir(), 'workhub-agent-loop-'));
process.env.WORKHUB_DB_V2 = join(workDir, 'agent.db');
process.env.USER_SKILLS_DIR = join(workDir, 'user-skills');
// 服务端的配置在 import 时就校验密钥（缺了直接拒绝启动）。
// CI 上没有 .env，本地也未必有：测试自己给一把，别依赖运行者的环境。
process.env.WORKHUB_SECRET ??= 'workhub-agent-test-secret-0123456789abcdef';

const { runAgent } = await import('./runtime.ts');
const { findAgentRole } = await import('./roles.ts');
type AgentEvent = import('../../shared/agent.ts').AgentEvent;

/** 假上游 + 假数据接口 */
async function startFakeUpstream(): Promise<{
  baseUrl: string;
  close: () => Promise<void>;
  requests: number;
}> {
  const state = { requests: 0 };
  let port = 0;
  const server: Server = createServer((req, res) => {
    if (req.url?.startsWith('/v1/chat/completions')) {
      let body = '';
      req.on('data', (c) => {
        body += c;
      });
      req.on('end', () => {
        state.requests += 1;
        const parsed = JSON.parse(body) as { messages: Array<{ role: string; content: string }> };
        const turns = parsed.messages.length;

        // 按轮次给不同的动作，把整条链路走一遍：
        // 取数 → 算数 → 收工
        const content =
          turns === 2
            ? `我先把数据取回来。\n\n\`\`\`json\n{"action":"tool","skillId":"web.fetch","params":{"url":"http://127.0.0.1:${port}/api/items"}}\n\`\`\``
            : turns === 4
              ? '接着算一下。\n\n```json\n{"action":"tool","skillId":"data.analyze","params":{"op":"describe"}}\n```'
              : '```json\n{"action":"answer","text":"一共 3 行，平均分 80。"}\n```';

        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
      });
      return;
    }

    // 假的数据接口
    if (req.url?.startsWith('/api/items')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify([
          { 姓名: '甲', 分数: 90 },
          { 姓名: '乙', 分数: 60 },
          { 姓名: '丙', 分数: 90 },
        ]),
      );
      return;
    }

    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  port = typeof address === 'object' && address ? address.port : 0;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests: state.requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test('agent 会自己调能力、接着算、最后给结论', async () => {
  const upstream = await startFakeUpstream();
  try {
    const events: AgentEvent[] = [];
    const role = findAgentRole('lead');
    assert.ok(role, '总控角色应该在');

    const outcome = await runAgent({
      role,
      task: '帮我看看这个接口的数据',
      cfg: {
        baseUrl: upstream.baseUrl,
        apiKey: 'test-key',
        model: 'test-model',
        groupId: '',
        temperature: 0,
        allowGuest: false,
        topK: 5,
        contextBudget: 4000,
        ragScope: { mode: 'all', repoIds: [], docIds: [], includeAttachments: true },
      },
      userId: 'tester',
      isAdmin: true,
      onEvent: (event) => events.push(event),
    });

    // 两份能力都被调到了
    assert.deepEqual(outcome.usedSkills, ['web.fetch', 'data.analyze']);
    // 结论是模型给的
    assert.equal(outcome.text, '一共 3 行，平均分 80。');

    // 过程可追溯：谁在干活、调了什么、拿到什么
    const toolStarts = events.filter((e) => e.type === 'tool.start');
    assert.equal(toolStarts.length, 2);
    const toolResults = events.filter((e) => e.type === 'tool.result');
    assert.equal(toolResults.length, 2);
    assert.ok(toolResults.every((e) => e.type === 'tool.result' && e.ok));

    // 取数的结果真的喂给了下一步：数据分析那步的输入里带着接口返回的数据
    const analyzeStart = toolStarts.find((e) => e.type === 'tool.start' && e.skillId === 'data.analyze');
    assert.ok(analyzeStart && analyzeStart.type === 'tool.start');

    // 过程说明被推给了界面
    const deltas = events.filter((e) => e.type === 'delta');
    assert.ok(deltas.length > 0);
  } finally {
    await upstream.close();
  }
});

test('模型要调自己没有的能力时会被拦下，并被告知能用什么', async () => {
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
    });
    req.on('end', () => {
      const parsed = JSON.parse(body) as { messages: Array<{ content: string }> };
      const turns = parsed.messages.length;
      const content =
        turns === 2
          ? '```json\n{"action":"tool","skillId":"doc.list","params":{}}\n```'
          : '```json\n{"action":"answer","text":"知道了。"}\n```';
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  try {
    const role = findAgentRole('data');
    assert.ok(role);
    const outcome = await runAgent({
      role,
      task: '抓点东西',
      cfg: {
        baseUrl: `http://127.0.0.1:${port}/v1`,
        apiKey: 'test-key',
        model: 'test-model',
        groupId: '',
        temperature: 0,
        allowGuest: false,
        topK: 5,
        contextBudget: 4000,
        ragScope: { mode: 'all', repoIds: [], docIds: [], includeAttachments: true },
      },
      userId: 'tester',
      isAdmin: true,
    });

    // 越权的能力没被调用，结果里不该出现它
    assert.equal(outcome.usedSkills.length, 0);
    assert.equal(outcome.text, '知道了。');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('总控可以把活儿派给专业 agent，拿到回报后再汇总', async () => {
  let port = 0;
  const server = createServer((req, res) => {
    // 只有模型接口走对话逻辑，其余一律 404（网页请求是 GET，没有请求体）
    if (!req.url?.startsWith('/v1/chat/completions')) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
      return;
    }
    let body = '';
    req.on('data', (c) => {
      body += c;
    });
    req.on('end', () => {
      const parsed = JSON.parse(body) as { messages: Array<{ role: string; content: string }> };
      const system = parsed.messages[0]?.content ?? '';
      const turns = parsed.messages.length;
      // 总控与网页 agent 的系统提示不一样，靠它认出这是谁在说话
      const isLead = system.includes('你是一个能自己动手的 agent');
      const content = isLead
        ? turns === 2
          ? '这事得让网页去。\n\n```json\n{"action":"delegate","agentId":"web","instruction":"取回这个页面的正文"}\n```'
          : '```json\n{"action":"answer","text":"页面讲的是发布流程。"}\n```'
        : turns === 2
          ? '```json\n{"action":"tool","skillId":"web.fetch","params":{"url":"URL_PAGE"}}\n```'
          : '```json\n{"action":"answer","text":"页面正文：先准备环境，再发布，最后验证。"}\n```';

      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: content.replace('URL_PAGE', `http://127.0.0.1:${port}/page`) } }] })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  port = typeof address === 'object' && address ? address.port : 0;

  try {
    const events: AgentEvent[] = [];
    const role = findAgentRole('lead');
    assert.ok(role);

    const outcome = await runAgent({
      role,
      task: '这个页面讲了什么',
      cfg: {
        baseUrl: `http://127.0.0.1:${port}/v1`,
        apiKey: 'test-key',
        model: 'test-model',
        groupId: '',
        temperature: 0,
        allowGuest: false,
        topK: 5,
        contextBudget: 4000,
        ragScope: { mode: 'all', repoIds: [], docIds: [], includeAttachments: true },
      },
      userId: 'tester',
      isAdmin: true,
      onEvent: (event) => events.push(event),
    });

    // 子 agent 真的干了活：用的是它自己的工具白名单
    assert.deepEqual(outcome.usedSkills, ['web.fetch']);
    // 总控收了子 agent 的回报并给出结论
    assert.equal(outcome.text, '页面讲的是发布流程。');

    // 过程里能看到「派给谁」
    const delegate = events.find((e) => e.type === 'delegate');
    assert.ok(delegate && delegate.type === 'delegate');
    assert.equal(delegate.toAgentId, 'web');
    // 两个 agent 都留下了痕迹
    const started = events.filter((e) => e.type === 'agent.start');
    assert.deepEqual(started.map((e) => (e.type === 'agent.start' ? e.agentId : '')), ['lead', 'web']);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test.after(() => {
  try {
    rmSync(workDir, { recursive: true, force: true });
  } catch {
    /* 临时目录删不掉就留着 */
  }
});
