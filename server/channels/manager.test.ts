import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ChannelManager } from './manager.ts';
import { ConfigError } from './config.ts';
import type { DriverHandlers } from './driver.ts';
import { RAW_PROTOCOL_ID, type ProtocolTemplate } from '../../shared/tools.ts';

/**
 * 测试用的文本行模板。
 *
 * 内置清单里没有通用定界模板了（那些「谁也不像」，只会把人带偏），
 * 但引擎照样支持按分隔符切帧——这里就地造一条，
 * 验的是「字节流 → 一条条记录」这条链路本身。
 */
const TEXT_LINE = {
  id: 'text-line',
  name: '文本行',
  summary: '按换行分行，UTF-8 解码。',
  framing: { kind: 'delimiter', delimiter: '0d0a' },
  encoding: 'utf8',
} satisfies ProtocolTemplate;

/** 等到条件成立为止 */
async function waitFor(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('等待超时');
}

/**
 * 内存驱动：不用真串口也能把整条路跑一遍。
 *
 * 真串口要硬件，CI 上没有——但「切帧 → 记记录 → 记录开关 → 停止」
 * 这些逻辑跟底下是不是真串口没关系，测它们不该被硬件卡住。
 */
function fakeChannel(): {
  manager: ChannelManager;
  /** 喂一段收到的字节 */
  feed: (data: Buffer | string) => void;
} {
  let handlers: DriverHandlers | null = null;
  const manager = new ChannelManager((_tool, _config, h) => {
    handlers = h;
    return {
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
    };
  });
  return {
    manager,
    feed: (data) => {
      assert.ok(handlers, '驱动还没建起来');
      handlers.onData(typeof data === 'string' ? Buffer.from(data, 'utf8') : data, '内存口');
    },
  };
}

/** 串口参数：测试里只需要一个像样的口名 */
const PORT = { port: 'COM1' };

test('收到的数据按协议切好记成一条条记录', async () => {
  const { manager, feed } = fakeChannel();
  const session = await manager.start({ tool: 'serial', config: PORT, template: TEXT_LINE });

  feed('hello\r\nworld\r\n');
  await waitFor(() => manager.records(session.id).length >= 2);

  const records = manager.records(session.id);
  assert.equal(records[0].text, 'hello');
  assert.equal(records[1].text, 'world');
  assert.equal(records[0].direction, 'in');
  assert.ok(records[0].peer, '记录里应当带上对端地址');
  await manager.stop(session.id);
});

test('往通道里发的数据也会记一条（方向是「发」）', async () => {
  const { manager } = fakeChannel();
  const session = await manager.start({ tool: 'serial', config: PORT, template: TEXT_LINE });

  await manager.send(session.id, Buffer.from('pong\r\n', 'utf8'));
  const outgoing = manager.records(session.id).find((r) => r.direction === 'out');
  assert.ok(outgoing, '发出去的数据应当留一条记录');
  assert.equal(outgoing.text, 'pong\r\n');
  assert.equal(outgoing.hex, '706F6E670D0A');
  await manager.stop(session.id);
});

test('记录游标：after 只给序号比它大的，不会重复也不会漏', async () => {
  const { manager, feed } = fakeChannel();
  const session = await manager.start({ tool: 'serial', config: PORT, template: TEXT_LINE });

  feed('a\r\n');
  await waitFor(() => manager.records(session.id).length >= 1);
  feed('b\r\n');
  await waitFor(() => manager.records(session.id).length >= 2);

  const all = manager.records(session.id);
  const cursor = all[0].id;
  const tail = manager.records(session.id, cursor);
  assert.equal(tail.length, 1);
  assert.equal(tail[0].id, all[1].id);
  await manager.stop(session.id);
});

test('停掉通道：状态变成已停止，残余的半帧也会吐出来', async () => {
  const { manager, feed } = fakeChannel();
  const session = await manager.start({ tool: 'serial', config: PORT, template: TEXT_LINE });

  feed('no-delimiter');
  // 等字节真的进了解析器再停：不停的话，残余的半帧还没进解析器
  await waitFor(() => manager.get(session.id)!.bytesIn > 0);
  await manager.stop(session.id);

  assert.equal(manager.get(session.id)!.status, 'stopped');
  const records = manager.records(session.id);
  assert.equal(records.length, 1);
  assert.equal(records[0].text, 'no-delimiter');
});

test('记录开关：关掉一个方向，那个方向就不再进记录表（字节数照常）', async () => {
  const { manager, feed } = fakeChannel();
  const session = await manager.start({ tool: 'serial', config: PORT, template: TEXT_LINE });

  feed('one\r\n');
  await waitFor(() => manager.records(session.id).length >= 1);

  manager.setRecording(session.id, { recordIn: false });
  feed('two\r\n');
  await waitFor(() => manager.get(session.id)!.bytesIn >= 8);

  assert.equal(manager.records(session.id).filter((r) => r.direction === 'in').length, 1);
  await manager.stop(session.id);
});

test('记录开关：关掉「记录发出的数据」，发出去的就不留记录', async () => {
  const { manager } = fakeChannel();
  const session = await manager.start({ tool: 'serial', config: PORT, template: TEXT_LINE });

  manager.setRecording(session.id, { recordOut: false });
  await manager.send(session.id, Buffer.from('pong\r\n', 'utf8'));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(manager.records(session.id).filter((r) => r.direction === 'out').length, 0);

  manager.setRecording(session.id, { recordOut: true });
  await manager.send(session.id, Buffer.from('pong2\r\n', 'utf8'));
  await waitFor(() => manager.records(session.id).filter((r) => r.direction === 'out').length >= 1);
  assert.equal(manager.records(session.id).filter((r) => r.direction === 'out')[0].text, 'pong2\r\n');
  await manager.stop(session.id);
});

test('参数不对要拦下来，不能把垃圾传给串口', async () => {
  const { manager } = fakeChannel();
  await assert.rejects(
    () => manager.start({ tool: 'serial', config: { port: '' } }),
    ConfigError,
  );
  await assert.rejects(
    () => manager.start({ tool: 'serial', config: { port: 'COM1', baudRate: '9600.5' } }),
    ConfigError,
  );
  await assert.rejects(
    () => manager.start({ tool: 'serial', config: { port: 'COM1', dataBits: '9' } }),
    ConfigError,
  );
});

test('协议是这一次选的：选了走那套，不选就只记原始字节', async () => {
  const { manager } = fakeChannel();
  const raw = await manager.start({ tool: 'serial', config: PORT });
  assert.equal(raw.templateId, RAW_PROTOCOL_ID);

  const led2 = await manager.start({
    tool: 'serial',
    config: PORT,
    protocolId: 'tongda-led2',
  });
  assert.equal(led2.templateId, 'tongda-led2');

  // 选了不存在的协议，退回调试模式，而不是让整个服务挂掉
  const bogus = await manager.start({
    tool: 'serial',
    config: PORT,
    protocolId: 'nope',
  });
  assert.equal(bogus.templateId, RAW_PROTOCOL_ID);

  await manager.stop(raw.id);
  await manager.stop(led2.id);
  await manager.stop(bogus.id);
});
