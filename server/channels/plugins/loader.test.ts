import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadPlugins } from './loader.ts';
import { findPlugin, listPlugins, listTemplates, pluginWarnings } from './registry.ts';

/**
 * 夹具插件目录：给「开发者发布的插件能不能装上」这条路径做测试用。
 *
 * 放在 server/channels/fixtures/plugins/ 下，不放在任何插件候选目录里——
 * 仓库根的 plugins/ 是给人装插件的地方，夹具混进去会在界面上冒出一条没人要的协议。
 */
const FIXTURE_PLUGIN_DIR = fileURLToPath(new URL('../fixtures/plugins', import.meta.url));

/** 造一个临时插件目录 */
function makePluginDir(manifest: unknown, entry?: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'workhub-plugin-'));
  const sub = join(dir, 'demo');
  mkdirSync(sub);
  writeFileSync(join(sub, 'manifest.json'), JSON.stringify(manifest), 'utf8');
  if (entry !== undefined) writeFileSync(join(sub, 'index.mjs'), entry, 'utf8');
  return dir;
}

test('开发者发布的插件：清单与实现都对，就装得上', async () => {
  const dir = makePluginDir(
    {
      id: 'demo-line',
      name: '示例文本行',
      publisher: '示例厂商',
      version: '2.1.0',
      summary: '一行一条。',
      protocol: {
        name: '示例文本行',
        framing: { kind: 'delimiter', delimiter: '0a' },
        encoding: 'utf8',
      },
    },
    [
      'export function createParser() {',
      '  let buf = Buffer.alloc(0);',
      '  return {',
      '    push(chunk) { buf = Buffer.concat([buf, chunk]); const out = []; let i;',
      '      while ((i = buf.indexOf(0x0a)) !== -1) { const line = buf.subarray(0, i); buf = buf.subarray(i + 1); out.push(Buffer.from(line)); }',
      '      return out; },',
      '    flush() { const rest = buf; buf = Buffer.alloc(0); return rest.length ? [rest] : []; },',
      '    pending() { return buf.length; },',
      '  };',
      '}',
      'export function decode(frame) { return { text: frame.toString("utf8"), hex: frame.toString("hex"), fields: [{ key: "内容", value: frame.toString("utf8").trim() }] }; }',
    ].join('\n'),
  );

  try {
    const result = await loadPlugins(dir);
    assert.equal(result.warnings.length, 0);
    assert.equal(result.plugins.length, 1);
    const plugin = result.plugins[0];
    assert.equal(plugin.manifest.id, 'demo-line');
    assert.equal(plugin.manifest.publisher, '示例厂商');
    assert.equal(plugin.manifest.version, '2.1.0');
    // 自带协议 → 多出一种协议类型，默认解析插件就是它自己
    assert.equal(plugin.template?.id, 'demo-line');
    assert.equal(plugin.template?.decoder, 'demo-line');

    // 实现真的能干活：切帧 + 解字段
    const parser = plugin.createParser();
    const frames = parser.push(Buffer.from('你好\n世界\n', 'utf8'));
    assert.equal(frames.length, 2);
    const decoded = plugin.decode(frames[0]);
    assert.equal(decoded.fields?.[0].value, '你好');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('插件坏了只记警告，别的插件照装', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'workhub-plugin-bad-'));
  // 清单缺 id
  const bad = join(dir, 'bad-manifest');
  mkdirSync(bad);
  writeFileSync(join(bad, 'manifest.json'), JSON.stringify({ name: '没有 id' }), 'utf8');
  // 清单没问题，但入口模块没导出该导出的函数
  const bad2 = join(dir, 'bad-entry');
  mkdirSync(bad2);
  writeFileSync(
    join(bad2, 'manifest.json'),
    JSON.stringify({ id: 'bad-entry', name: '坏入口' }),
    'utf8',
  );
  writeFileSync(join(bad2, 'index.mjs'), 'export const nothing = 1;', 'utf8');
  // 好的那个
  const good = join(dir, 'good');
  mkdirSync(good);
  writeFileSync(
    join(good, 'manifest.json'),
    JSON.stringify({ id: 'good', name: '好的' }),
    'utf8',
  );
  writeFileSync(
    join(good, 'index.mjs'),
    [
      'export function createParser() { return { push() { return []; }, flush() { return []; }, pending() { return 0; } }; }',
      'export function decode(frame) { return { text: "", hex: "" }; }',
    ].join('\n'),
    'utf8',
  );

  try {
    const result = await loadPlugins(dir);
    assert.equal(result.plugins.length, 1);
    assert.equal(result.plugins[0].manifest.id, 'good');
    assert.equal(result.warnings.length, 2);
    assert.ok(result.warnings.some((w) => w.includes('bad-manifest')));
    assert.ok(result.warnings.some((w) => w.includes('bad-entry')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('插件目录不存在不算错：没装插件是正常状态', async () => {
  const result = await loadPlugins(join(tmpdir(), 'workhub-not-exist-dir'));
  assert.equal(result.plugins.length, 0);
  assert.equal(result.warnings.length, 0);
});

test('开发者发布的插件装得上（发布者署名能对上）', async () => {
  const result = await loadPlugins(FIXTURE_PLUGIN_DIR);
  const example = result.plugins.find((p) => p.manifest.id === 'demo-vendor-line');
  assert.ok(example, '夹具插件应该被装上');
  assert.equal(example.manifest.publisher, '示例设备组');
  assert.equal(example.template?.framing.kind, 'delimiter');
});

test('注册表：内置插件与开发者发布的插件摆在一起，署名各不相同', async () => {
  // 让注册表去夹具目录里找开发者插件（真实安装位是仓库根的 plugins/）
  process.env.WORKHUB_PLUGIN_DIR = FIXTURE_PLUGIN_DIR;
  const plugins = await listPlugins();
  // 内置的：署项目目名
  const builtin = plugins.find((p) => p.id === 'tongda-led2');
  assert.ok(builtin, '内置的通达 LED2 应该在插件清单里');
  assert.equal(builtin.builtin, true);
  assert.equal(builtin.publisher, 'WorkHub 内置');
  // 开发者发布的：署名开发者
  const external = plugins.find((p) => p.id === 'demo-vendor-line');
  assert.ok(external, '夹具插件应该在插件清单里');
  assert.equal(external.builtin, false);
  assert.equal(external.publisher, '示例设备组');

  // 协议类型：内置的 + 插件自带的
  const templates = await listTemplates();
  assert.ok(templates.some((tpl) => tpl.id === 'tongda-led2'));
  assert.ok(templates.some((tpl) => tpl.id === 'demo-vendor-line'));

  // 插件自带的协议，默认解析插件就是它自己
  const demo = await findPlugin('demo-vendor-line');
  assert.ok(demo);
  assert.equal(demo.protocolId, 'demo-vendor-line');

  assert.deepEqual(await pluginWarnings(), []);
});
