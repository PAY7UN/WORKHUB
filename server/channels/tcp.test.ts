import assert from 'node:assert/strict';
import net from 'node:net';
import test, { type TestContext } from 'node:test';

import { ChannelManager } from './manager.ts';
import { createTcpDriver } from './tcp.ts';
import { buildJt808Frame, Jt808Parser, parseJt808Header, unescapeJt808 } from './decoders/jt808.ts';

/** 等到条件成立为止 */
async function waitFor(check: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('等待超时');
}

/** 找一个空着的端口 */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

/** 终端注册正文：够长就能把注册信息读全 */
function registerBody(): Buffer {
  const fixed = (text: string, len: number): Buffer => {
    const buf = Buffer.alloc(len, 0x20);
    buf.write(text.slice(0, len), 0, 'latin1');
    return buf;
  };
  return Buffer.concat([
    Buffer.from([0x31, 0x32]),
    Buffer.from([0x30, 0x31]),
    fixed('TESTMANU001', 11),
    fixed('MODEL-TEST-001', 30),
    fixed('123456789012345', 15),
    fixed('V1.0.0', 20),
    Buffer.alloc(10),
    Buffer.from([0x00]),
  ]);
}

/** 一个连上来的终端：它收什么我们都记着 */
interface Terminal {
  socket: net.Socket;
  received: Buffer[];
}

/** 连上来并收字节的终端 */
function connectTerminal(port: number): Promise<Terminal> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    const received: Buffer[] = [];
    socket.on('data', (chunk: Buffer) => received.push(chunk));
    socket.once('error', reject);
    socket.once('connect', () => resolve({ socket, received }));
  });
}

/**
 * 起一个真的 TCP 监听通道。
 *
 * 这条测试跑的是完整的一程：终端连进来 → 发注册帧 → 平台回注册应答。
 * 用的不是假驱动，是真的 socket——网络注册这件事本身就在网络上。
 */
async function startTcpChannel(
  t: TestContext,
): Promise<{ manager: ChannelManager; sessionId: string; port: number }> {
  const manager = new ChannelManager();
  const port = await freePort();
  const session = await manager.start({
    tool: 'tcp',
    config: { mode: 'listen', host: '127.0.0.1', port: String(port) },
    protocolId: 'jt-t808',
  });
  // 收尾一定要做：会话里有个每秒推状态的定时器，不关掉进程就走不掉
  t.after(async () => {
    await manager.stop(session.id);
  });
  return { manager, sessionId: session.id, port };
}

test('网口监听：终端连上来就是对端，能看见它在', async (t) => {
  const { manager, sessionId, port } = await startTcpChannel(t);
  const terminal = await connectTerminal(port);
  t.after(() => terminal.socket.destroy());

  await waitFor(() => manager.get(sessionId)!.peers.length === 1);
  const peers = manager.get(sessionId)!.peers;
  assert.equal(peers.length, 1);
  assert.match(peers[0], /^127\.0\.0\.1:\d+$/);
});

test('网络注册：终端发注册，平台自动回注册应答', async (t) => {
  const { port } = await startTcpChannel(t);
  const terminal = await connectTerminal(port);
  t.after(() => terminal.socket.destroy());

  terminal.socket.write(buildJt808Frame({ messageId: 0x0001, body: registerBody(), seq: 17 }));

  // 平台得回一帧 0x8001 注册应答
  await waitFor(() => terminal.received.reduce((n, b) => n + b.length, 0) > 0);
  const raw = Buffer.concat(terminal.received);
  const frames = new Jt808Parser().push(raw);
  assert.equal(frames.length, 1);
  const header = parseJt808Header(frames[0]);
  assert.equal(header?.messageId, 0x8001);
  assert.equal(header?.seq, 17);
  assert.equal(header?.checksumOk, true);
  // 正文：应答序列号(2) + 应答标志(1)
  const body = unescapeJt808(frames[0]).subarray(12, frames[0].length - 1);
  assert.equal(body.readUInt16BE(0), 17);
  assert.equal(body[2], 0);
});

test('网络注册：心跳也要有应答', async (t) => {
  const { port } = await startTcpChannel(t);
  const terminal = await connectTerminal(port);
  t.after(() => terminal.socket.destroy());

  terminal.socket.write(buildJt808Frame({ messageId: 0x0002, body: Buffer.alloc(0), seq: 3 }));

  await waitFor(() => terminal.received.reduce((n, b) => n + b.length, 0) > 0);
  const frames = new Jt808Parser().push(Buffer.concat(terminal.received));
  assert.equal(frames.length, 1);
  assert.equal(parseJt808Header(frames[0])?.messageId, 0x8002);
});

test('收到的字节会被解成记录：注册信息摊在字段里', async (t) => {
  const { manager, sessionId, port } = await startTcpChannel(t);
  const terminal = await connectTerminal(port);
  t.after(() => terminal.socket.destroy());

  terminal.socket.write(buildJt808Frame({ messageId: 0x0001, body: registerBody(), seq: 1 }));
  await waitFor(() => manager.records(sessionId).some((r) => r.direction === 'in'));

  const record = manager.records(sessionId).find((r) => r.direction === 'in');
  assert.ok(record);
  const fields = Object.fromEntries((record.fields ?? []).map((f) => [f.key, f.value]));
  assert.equal(fields['终端编号'], '123456789012345');
  assert.equal(fields['制造商编码'], 'TESTMANU001');
  assert.match(record.summary ?? '', /终端注册/);
  assert.ok(record.peer, '记录里要带上是哪个终端发来的');
});

test('组包发送：平台能往下发一条文本信息', async (t) => {
  const { manager, sessionId, port } = await startTcpChannel(t);
  const terminal = await connectTerminal(port);
  t.after(() => terminal.socket.destroy());

  await waitFor(() => manager.get(sessionId)!.peers.length === 1);
  const peer = manager.get(sessionId)!.peers[0];
  const result = await manager.buildFrame(
    sessionId,
    { kind: 'platform.text', args: { text: 'hello', flag: '0' } },
    peer,
  );
  assert.ok(result.sent > 0);

  await waitFor(() => terminal.received.reduce((n, b) => n + b.length, 0) > 0);
  const frames = new Jt808Parser().push(Buffer.concat(terminal.received));
  assert.equal(frames.length, 1);
  const inner = unescapeJt808(frames[0]);
  assert.equal(parseJt808Header(inner)?.messageId, 0x8101);
  assert.equal(inner.subarray(13, inner.length - 1).toString('utf8'), 'hello');

  // 发出去的那一帧也得进记录，而且得解得对
  await waitFor(() => manager.records(sessionId).some((r) => r.direction === 'out'));
  const out = manager.records(sessionId).find((r) => r.direction === 'out');
  assert.ok(out);
  assert.match(out.summary ?? '', /文本信息下发/);
});

test('一个终端断开了，端口还开着，别的终端还能连', async (t) => {
  const { manager, sessionId, port } = await startTcpChannel(t);

  const first = await connectTerminal(port);
  await waitFor(() => manager.get(sessionId)!.peers.length === 1);
  first.socket.destroy();
  await waitFor(() => manager.get(sessionId)!.peers.length === 0);

  const second = await connectTerminal(port);
  t.after(() => second.socket.destroy());
  await waitFor(() => manager.get(sessionId)!.peers.length === 1);
  assert.equal(manager.get(sessionId)!.status, 'running');
});

test('主动连接：本机当客户端去连对端', async (t) => {
  // 对端扮演平台，终端反过来当客户端
  const server = net.createServer();
  const got: Buffer[] = [];
  const accepted = new Promise<net.Socket>((resolve) => {
    server.once('connection', (socket) => {
      socket.on('data', (c: Buffer) => got.push(c));
      resolve(socket);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  const manager = new ChannelManager();
  const session = await manager.start({
    tool: 'tcp',
    config: { mode: 'connect', host: '127.0.0.1', port: String(port) },
    protocolId: 'jt-t808',
  });
  t.after(async () => {
    await manager.stop(session.id);
    server.close();
  });

  // 连接建立后，对端发一帧心跳，本机应该回心跳应答
  const peer = await accepted;
  peer.write(buildJt808Frame({ messageId: 0x0002, body: Buffer.alloc(0), seq: 8 }));

  await waitFor(() => got.reduce((n, b) => n + b.length, 0) > 0);
  const frames = new Jt808Parser().push(Buffer.concat(got));
  assert.equal(frames.length, 1);
  assert.equal(parseJt808Header(frames[0])?.messageId, 0x8002);
});

test('监听失败要报错，不能留一个「起不来的会话」', async () => {
  const manager = new ChannelManager();
  const port = await freePort();
  // 先占住这个端口
  const blocker = net.createServer();
  await new Promise<void>((resolve) => blocker.listen(port, '127.0.0.1', () => resolve()));
  await assert.rejects(
    () =>
      manager.start({
        tool: 'tcp',
        config: { mode: 'listen', host: '127.0.0.1', port: String(port) },
        protocolId: 'jt-t808',
      }),
    /监听/,
  );
  blocker.close();
});

test('发数据要指定对端才发得出去', async (t) => {
  const { manager, sessionId, port } = await startTcpChannel(t);
  const terminal = await connectTerminal(port);
  t.after(() => terminal.socket.destroy());

  await waitFor(() => manager.get(sessionId)!.peers.length === 1);
  const peer = manager.get(sessionId)!.peers[0];
  await manager.send(sessionId, Buffer.from('ping'), peer);
  await waitFor(() => terminal.received.length > 0);
  assert.equal(Buffer.concat(terminal.received).toString('utf8'), 'ping');
});

test('驱动直接用：广播发出去就是每个对端都收一份', async (t) => {
  const port = await freePort();
  const peers: string[] = [];
  const received: Buffer[] = [];
  const driver = createTcpDriver(
    { mode: 'listen', host: '127.0.0.1', port },
    {
      onData: (chunk) => {
        received.push(chunk);
      },
      onStatus: () => undefined,
      onPeers: (list) => {
        peers.length = 0;
        peers.push(...list);
      },
    },
  );
  await driver.start();
  t.after(async () => {
    await driver.stop();
  });

  const terminal = await connectTerminal(port);
  t.after(() => terminal.socket.destroy());

  await waitFor(() => peers.length === 1);
  await driver.send(Buffer.from('broadcast'));
  // 广播是往每个对端发：终端那边才收得到
  await waitFor(() => terminal.received.length > 0);
  assert.equal(Buffer.concat(terminal.received).toString('utf8'), 'broadcast');

  // 反过来：终端发来的字节，驱动这边也得收到
  terminal.socket.write('from-terminal');
  await waitFor(() => received.length > 0);
  assert.equal(Buffer.concat(received).toString('utf8'), 'from-terminal');
});
