/**
 * agent 运行时的回归测试。
 *
 * 模型输出的形状是这一层唯一要对付的东西：
 * - 动作写在代码块里（正常）
 * - 动作直接甩出来，没有代码块（模型偷懒）
 * - 只有散文，没有动作（模型改主意了，直接答）
 * - JSON 坏了（有散文就当散文答，没散文才让它重写）
 *
 * 这些都要认，认错了就表现为「agent 不干活」或者「agent 胡言乱语」。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const workDir = mkdtempSync(join(tmpdir(), 'workhub-agent-test-'));
process.env.WORKHUB_DB_V2 = join(workDir, 'agent.db');
// 服务端的配置在 import 时就校验密钥（缺了直接拒绝启动）。
// CI 上没有 .env，本地也未必有：测试自己给一把，别依赖运行者的环境。
process.env.WORKHUB_SECRET ??= 'workhub-agent-test-secret-0123456789abcdef';

const { parseAction } = await import('./runtime.ts');
const { VisibleTextFilter } = await import('../../shared/jsonBlock.ts');

test.after(() => {
  try {
    rmSync(workDir, { recursive: true, force: true });
  } catch {
    // 临时目录删不掉就留着，不影响断言
  }
});

test('工具动作被认出来', () => {
  const { action } = parseAction(
    '我先去把这个页面取回来。\n\n```json\n{"action":"tool","skillId":"web.fetch","params":{"url":"https://a.com"},"reason":"要正文"}\n```',
  );
  assert.equal(action?.kind, 'tool');
  assert.equal(action?.skillId, 'web.fetch');
  assert.deepEqual(action?.params, { url: 'https://a.com' });
  assert.equal(action?.reason, '要正文');
});

test('参数里的数字与对象被摊平成字符串', () => {
  const { action } = parseAction(
    '```json\n{"action":"tool","skillId":"data.analyze","params":{"limit":5,"groupBy":["部门","季度"]}}\n```',
  );
  assert.deepEqual(action?.params, { limit: '5', groupBy: '["部门","季度"]' });
});

test('委派动作被认出来', () => {
  const { action } = parseAction(
    '```json\n{"action":"delegate","agentId":"web","instruction":"取回这个页面的正文"}\n```',
  );
  assert.equal(action?.kind, 'delegate');
  assert.equal(action?.agentId, 'web');
  assert.equal(action?.instruction, '取回这个页面的正文');
});

test('反问与收工被认出来', () => {
  const ask = parseAction('```json\n{"action":"ask","instruction":"要哪个季度的？"}\n```');
  assert.equal(ask.action?.kind, 'ask');
  assert.equal(ask.action?.instruction, '要哪个季度的？');

  const answer = parseAction('```json\n{"action":"answer","text":"一共 12 条。"}\n```');
  assert.equal(answer.action?.kind, 'answer');
  assert.equal(answer.action?.text, '一共 12 条。');
});

test('只有散文时当作回答', () => {
  const { action } = parseAction('这个页面讲的是发布流程的三个步骤。');
  assert.equal(action?.kind, 'answer');
  assert.ok(action?.text?.includes('发布流程'));
});

test('JSON 坏了但有散文时当作回答', () => {
  const { action } = parseAction('我先说结论。\n\n```json\n{"action":\n```');
  assert.equal(action?.kind, 'answer');
  assert.ok(action?.text?.includes('我先说结论'));
});

test('JSON 坏了又没散文时才算坏，让它重写', () => {
  const { action, broken } = parseAction('```json\n{"action":\n```');
  assert.equal(action, undefined);
  assert.equal(broken, true);
});

test('动作名不认识但有正文时当作回答', () => {
  const { action } = parseAction('```json\n{"action":"dance","text":"跳舞"}\n```\n顺便一提。');
  assert.equal(action?.kind, 'answer');
});

test('代码块在流式到达时会被剔掉，正文照常给人看', () => {
  const filter = new VisibleTextFilter();
  const chunks = ['我要去取这个页', '面。\n\n```js', 'on\n{"action":"tool"}', '\n```'];
  let visible = '';
  for (const chunk of chunks) visible += filter.feed(chunk);
  visible += filter.flush();
  assert.ok(visible.includes('我要去取这个页面。'));
  assert.ok(!visible.includes('action'));
  assert.ok(!visible.includes('```'));
});

test('围栏标记被切成两半时也不会漏出 JSON', () => {
  const filter = new VisibleTextFilter();
  let visible = '';
  for (const chunk of ['说明。\n\n``', '`json\n{"a":1}\n``', '`']) visible += filter.feed(chunk);
  visible += filter.flush();
  assert.ok(visible.includes('说明。'));
  assert.ok(!visible.includes('"a"'));
});
