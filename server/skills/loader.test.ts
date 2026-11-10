/**
 * 能力加载器的回归测试。
 *
 * 能力是磁盘上的文件，所以加载器必须扛得住「用户手写坏了」这种情况：
 * 写坏的能力要么被跳过并说清楚为什么，要么整个清单都读不出来——后者不可接受。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { parseSkillFrontmatter, loadSkillsFromRoot, loadSkillDir } = await import('./loader.ts');

function makeRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'workhub-skill-test-'));
  test.after(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // 临时目录删不掉就留着，不影响断言
    }
  });
  return dir;
}

function writeSkill(root: string, slug: string, md: string, manifest?: unknown): void {
  const dir = join(root, slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), md, 'utf8');
  if (manifest !== undefined) writeFileSync(join(dir, 'skill.json'), JSON.stringify(manifest), 'utf8');
}

test('frontmatter：拆出字段、metadata 与正文', () => {
  const md = ['---', 'name: demo', 'description: 用来做某件事', 'metadata:', '  id: demo.one', '  category: system', '---', '', '正文第一行'].join('\n');
  const { fields, metadata, body } = parseSkillFrontmatter(md);
  assert.equal(fields.name, 'demo');
  assert.equal(fields.description, '用来做某件事');
  assert.equal(metadata.id, 'demo.one');
  assert.equal(metadata.category, 'system');
  assert.equal(body, '正文第一行');
});

test('frontmatter：没有 frontmatter 时整份都当正文', () => {
  const { fields, metadata, body } = parseSkillFrontmatter('# 标题\n\n正文');
  assert.deepEqual(fields, {});
  assert.deepEqual(metadata, {});
  assert.equal(body, '# 标题\n\n正文');
});

test('读一份能力：说明书与执行契约合成一条规格', () => {
  const root = makeRoot();
  writeSkill(
    root,
    'demo-one',
    ['---', 'name: demo-one', 'description: 演示能力', 'metadata:', '  id: demo.one', '---', '', '用法说明'].join('\n'),
    { name: '演示', category: 'system', method: 'POST', endpoint: '/demo', params: [{ key: 'q', label: '问题', type: 'text', required: true }] },
  );

  const { skills, warnings } = loadSkillsFromRoot(root, 'builtin', () => false);
  assert.equal(warnings.length, 0);
  assert.equal(skills.length, 1);
  const skill = skills[0];
  assert.equal(skill.id, 'demo.one');
  assert.equal(skill.name, '演示');
  assert.equal(skill.description, '演示能力');
  assert.equal(skill.instructions, '用法说明');
  assert.equal(skill.endpoint, '/demo');
  assert.equal(skill.params.length, 1);
  // 声明了端点就能跑，哪怕服务端还没有实现
  assert.equal(skill.executable, true);
});

test('写坏的能力：缺 name 或 description 时记下问题，不影响别的能力', () => {
  const root = makeRoot();
  writeSkill(root, 'good', ['---', 'name: good', 'description: 好的', '---', '', '正文'].join('\n'));
  writeSkill(root, 'bad', ['---', 'description: 缺 name', '---', '', '正文'].join('\n'));

  const { skills, warnings } = loadSkillsFromRoot(root, 'builtin', () => false);
  assert.equal(skills.length, 1);
  assert.equal(skills[0].id, 'good');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /bad/);
});

test('skill.json 解析坏了：记下问题，能力仍能读出来', () => {
  const root = makeRoot();
  const dir = join(root, 'broken');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), ['---', 'name: broken', 'description: 坏的执行契约', '---', '', '正文'].join('\n'), 'utf8');
  writeFileSync(join(dir, 'skill.json'), '{ 不是 JSON', 'utf8');

  const { skills, warnings } = loadSkillsFromRoot(root, 'builtin', () => false);
  assert.equal(skills.length, 1);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /skill.json 解析失败/);
});

test('以 _ 开头的目录是模板不是能力，跳过', () => {
  const root = makeRoot();
  writeSkill(root, '_template', ['---', 'name: template', 'description: 模板', '---', '', '正文'].join('\n'));
  const { skills } = loadSkillsFromRoot(root, 'builtin', () => false);
  assert.equal(skills.length, 0);
});

test('enabled: false 的能力不加载', () => {
  const root = makeRoot();
  writeSkill(root, 'off', ['---', 'name: off', 'description: 关掉的', '---', '', '正文'].join('\n'), { enabled: false });
  const { skills } = loadSkillsFromRoot(root, 'builtin', () => false);
  assert.equal(skills.length, 0);
});

test('有服务端执行体的能力才算能跑', () => {
  const root = makeRoot();
  writeSkill(root, 'with-runner', ['---', 'name: with-runner', 'description: 有实现', '---', '', '正文'].join('\n'));
  const loaded = loadSkillDir(join(root, 'with-runner'), 'builtin', 'with-runner', (id) => id === 'with-runner');
  assert.ok(loaded);
  assert.equal(loaded.spec.executable, true);
});

test('两条调用路得分清楚：有执行体的走服务端，只声明端点的按契约直接调', () => {
  const root = makeRoot();
  writeSkill(root, 'with-runner', ['---', 'name: with-runner', 'description: 有实现', '---', '', '正文'].join('\n'));
  writeSkill(
    root,
    'by-endpoint',
    ['---', 'name: by-endpoint', 'description: 只声明了端点', '---', '', '正文'].join('\n'),
    { method: 'POST', endpoint: '/demo' },
  );

  const runnerSkill = loadSkillDir(join(root, 'with-runner'), 'builtin', 'with-runner', (id) => id === 'with-runner');
  assert.ok(runnerSkill);
  assert.equal(runnerSkill.spec.hasRunner, true);

  const endpointSkill = loadSkillDir(join(root, 'by-endpoint'), 'builtin', 'by-endpoint', () => false);
  assert.ok(endpointSkill);
  // 能跑，但服务端没有执行体：界面按契约里的 method + endpoint 直接调
  assert.equal(endpointSkill.spec.executable, true);
  assert.equal(endpointSkill.spec.hasRunner, false);
});
