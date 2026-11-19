import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ChannelManager } from './manager.ts';
import { ConfigError } from './config.ts';
import type { DriverHandlers } from './driver.ts';
import { listPlugins, listTemplates } from './plugins/registry.ts';
import { loadPlugins } from './plugins/loader.ts';
import { appliesToTransport, transportScopeText } from '../../shared/tools.ts';

/**
 * 串口与网口的解析插件不是同一套。
 *
 * 车载屏（通达 LED2）插在本机串口线上，定位终端（JT/T 808）走 TCP 连平台——
 * 两边不是同一类设备，协议清单也不该是同一份。
 * 这组测试盯的就是这条界线：插件认自己的口，界面对不上时不给选，
 * 服务端开通道时也要拦下来。
 */

/** 内存驱动：不用真硬件也能开通道 */
function fakeManager(): ChannelManager {
  return new ChannelManager((_tool, _config, _handlers: DriverHandlers) => ({
    async start() {
      /* 内存驱动，开箱即用 */
    },
    async stop() {
      /* 没什么可关的 */
    },
    async send(data: Buffer) {
      return data.length;
    },
    peers() {
      return ['内存口'];
    },
  }));
}

/** 一个能装上的最小插件实现 */
const MINIMAL_ENTRY = [
  'export function createParser() { return { push() { return []; }, flush() { return []; }, pending() { return 0; } }; }',
  'export function decode(frame) { return { text: "", hex: "" }; }',
].join('\n');

test('内置插件各自认自己的接入方式：车载屏归串口，808 归网口', async () => {
  const plugins = await listPlugins();

  const led2 = plugins.find((p) => p.id === 'tongda-led2');
  assert.ok(led2, '内置的通达 LED2 应该在插件清单里');
  assert.deepEqual(led2.transports, ['serial']);

  const jt808 = plugins.find((p) => p.id === 'jt-t808');
  assert.ok(jt808, '内置的 JT/T 808 应该在插件清单里');
  assert.deepEqual(jt808.transports, ['tcp']);

  // 各自不越界：串口插件不到网口去，网口插件也不到串口去
  assert.equal(appliesToTransport(led2.transports, 'serial'), true);
  assert.equal(appliesToTransport(led2.transports, 'tcp'), false);
  assert.equal(appliesToTransport(jt808.transports, 'tcp'), true);
  assert.equal(appliesToTransport(jt808.transports, 'serial'), false);
});

test('协议模板的适用范围跟它的插件对得上', async () => {
  const templates = await listTemplates();

  const led2 = templates.find((t) => t.id === 'tongda-led2');
  assert.ok(led2);
  assert.deepEqual(led2.transports, ['serial']);

  const jt808 = templates.find((t) => t.id === 'jt-t808');
  assert.ok(jt808);
  assert.deepEqual(jt808.transports, ['tcp']);

  // 「不解析」不挑口：哪种口上都能先看着原始字节
  const raw = templates.find((t) => t.id === 'raw');
  assert.ok(raw);
  assert.equal(appliesToTransport(raw.transports, 'serial'), true);
  assert.equal(appliesToTransport(raw.transports, 'tcp'), true);
});

test('开通道：解析插件跟接入方式对不上要拦下来', async () => {
  const manager = fakeManager();
  const opened: string[] = [];

  try {
    // 对得上的都开得了（界面上选插件时会连协议一起带上）
    const serial = await manager.start({
      tool: 'serial',
      config: { port: 'COM1' },
      protocolId: 'tongda-led2',
      pluginId: 'tongda-led2',
    });
    opened.push(serial.id);
    assert.equal(serial.templateId, 'tongda-led2');

    const net = await manager.start({
      tool: 'tcp',
      config: { mode: 'listen', host: '0.0.0.0', port: '7612' },
      protocolId: 'jt-t808',
      pluginId: 'jt-t808',
    });
    opened.push(net.id);
    assert.equal(net.templateId, 'jt-t808');

    // 对不上的：串口线上开 808、车载屏协议挂到网口上——都该拦下来
    await assert.rejects(
      () =>
        manager.start({
          tool: 'serial',
          config: { port: 'COM1' },
          protocolId: 'jt-t808',
          pluginId: 'jt-t808',
        }),
      (err: unknown) => {
        assert.ok(err instanceof ConfigError);
        assert.match(err.message, /JT\/T 808/);
        assert.match(err.message, /串口/);
        return true;
      },
    );
    await assert.rejects(
      () =>
        manager.start({
          tool: 'tcp',
          config: { mode: 'listen', host: '0.0.0.0', port: '7613' },
          protocolId: 'tongda-led2',
          pluginId: 'tongda-led2',
        }),
      ConfigError,
    );

    // 只给插件不给协议也一样拦得住：拦的是插件，不是协议
    await assert.rejects(
      () => manager.start({ tool: 'serial', config: { port: 'COM1' }, pluginId: 'jt-t808' }),
      ConfigError,
    );
  } finally {
    // 会话开着就有定时器在跑：不清掉，测试进程退不出来
    for (const id of opened) await manager.stop(id);
  }
});

test('按协议开通道也一样：协议自带的应用范围也得守住', async () => {
  const manager = fakeManager();

  try {
    // jt-t808 协议只归网口——串口线上开它同样该被拦下
    await assert.rejects(
      () => manager.start({ tool: 'serial', config: { port: 'COM1' }, protocolId: 'jt-t808' }),
      ConfigError,
    );

    // 调试模式（不解析）在哪种口上都能开
    const raw = await manager.start({ tool: 'serial', config: { port: 'COM1' } });
    assert.equal(raw.templateId, 'raw');
  } finally {
    // 会话开着就有定时器在跑：不清掉，测试进程退不出来
    for (const s of manager.list()) await manager.stop(s.id);
  }
});

test('适用范围的说法：给人看的、不是给机器看的', () => {
  assert.equal(transportScopeText(['serial']), '串口');
  assert.equal(transportScopeText(['serial', 'tcp']), '串口 / 网口');
  assert.equal(transportScopeText(undefined), '不限接入方式');
  assert.equal(transportScopeText([]), '不限接入方式');
});

test('外部插件清单里写适用范围：写对了跟着走', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'workhub-plugin-scope-'));
  const sub = join(dir, 'scoped');
  mkdirSync(sub);
  writeFileSync(
    join(sub, 'manifest.json'),
    JSON.stringify({
      id: 'scoped-demo',
      name: '示例网口协议',
      transports: ['tcp'],
      protocol: {
        name: '示例网口协议',
        framing: { kind: 'delimiter', delimiter: '0a' },
      },
    }),
    'utf8',
  );
  writeFileSync(join(sub, 'index.mjs'), MINIMAL_ENTRY, 'utf8');

  try {
    const result = await loadPlugins(dir);
    assert.equal(result.warnings.length, 0);
    const plugin = result.plugins[0];
    assert.deepEqual(plugin.manifest.transports, ['tcp']);
    // 插件自带的协议也跟着：这套协议只归网口
    assert.deepEqual(plugin.template?.transports, ['tcp']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('外部插件清单里适用范围写错了：记警告，不装它', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'workhub-plugin-scope-bad-'));
  const sub = join(dir, 'bad-scope');
  mkdirSync(sub);
  writeFileSync(
    join(sub, 'manifest.json'),
    JSON.stringify({ id: 'bad-scope', name: '写错了的', transports: ['usb'] }),
    'utf8',
  );
  writeFileSync(join(sub, 'index.mjs'), MINIMAL_ENTRY, 'utf8');

  try {
    const result = await loadPlugins(dir);
    assert.equal(result.plugins.length, 0);
    assert.equal(result.warnings.length, 1);
    // 得说清楚错在哪儿：插件作者才知道要改什么
    assert.match(result.warnings[0], /serial/);
    assert.match(result.warnings[0], /tcp/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('外部插件没写适用范围：不挑口，两边都用得上', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'workhub-plugin-scope-any-'));
  const sub = join(dir, 'any');
  mkdirSync(sub);
  writeFileSync(
    join(sub, 'manifest.json'),
    JSON.stringify({ id: 'any-demo', name: '哪儿都能用的' }),
    'utf8',
  );
  writeFileSync(join(sub, 'index.mjs'), MINIMAL_ENTRY, 'utf8');

  try {
    const result = await loadPlugins(dir);
    assert.equal(result.warnings.length, 0);
    assert.equal(result.plugins[0].manifest.transports, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
