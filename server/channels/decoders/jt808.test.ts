import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildJt808Command,
  buildJt808Frame,
  decodeJt808,
  escapeJt808,
  Jt808Parser,
  jt808Checksum,
  parseJt808Header,
  unescapeJt808,
} from './jt808.ts';

/** ASCII 定长字段：不够长补空格，多了截断 */
function fixed(text: string, length: number): Buffer {
  const buf = Buffer.alloc(length, 0x20);
  buf.write(text.slice(0, length), 0, 'latin1');
  return buf;
}

/** BCD 时间：YYMMDDHHmmss */
function bcdBytes(text: string): Buffer {
  const buf = Buffer.alloc(text.length / 2);
  for (let i = 0; i < buf.length; i++) {
    buf[i] = Number.parseInt(text.slice(i * 2, i * 2 + 2), 16);
  }
  return buf;
}

/** 终端注册正文：101 字节 */
function registerBody(): Buffer {
  return Buffer.concat([
    Buffer.from([0x31, 0x32]), // 省份编码 3132
    Buffer.from([0x30, 0x31]), // 市域编码 3031
    fixed('TESTMANU001', 11), // 制造商编码
    fixed('MODEL-TEST-001', 30), // 终端型号
    fixed('123456789012345', 15), // 终端编号
    fixed('V1.0.0', 20), // 固件版本号
    bcdBytes('13800138000'), // SIM 卡号（BCD）
    Buffer.from([0x00]), // 终端认证类型
  ]);
}

/** 位置信息正文：23 字节 */
function positionBody(): Buffer {
  const body = Buffer.alloc(23);
  body[0] = 0x00; // 标志
  body.writeInt32BE(116397128, 1); // 经度 116.397128
  body.writeInt32BE(39916527, 5); // 纬度 39.916527
  body.writeInt16BE(1000, 9); // 高度 100.0 米
  body.writeUInt16BE(300, 11); // 速度 30.0 千米/小时
  body.writeUInt16BE(90, 13); // 方向 90 度
  bcdBytes('261118103000').copy(body, 15); // 定位时间
  body[21] = 8; // 卫星数
  body[22] = 0x01; // 定位状态：有效、北纬、东经
  return body;
}

/** 字段数组转对象 */
function fieldMap(fields: { key: string; value: string }[]): Record<string, string> {
  return Object.fromEntries(fields.map((f) => [f.key, f.value]));
}

/* ------------------------------ 转义与校验 ------------------------------ */

test('转义把 7E/7D/7F 换成两字节，解转义还原', () => {
  const raw = Buffer.from([0x00, 0x7e, 0x7d, 0x7f, 0x01]);
  const escaped = escapeJt808(raw);
  assert.deepEqual([...escaped], [0x00, 0x7d, 0x01, 0x7d, 0x02, 0x7d, 0x04, 0x01]);
  assert.deepEqual([...unescapeJt808(escaped)], [...raw]);
});

test('老设备不转 0x7F 时，7F 原样保留', () => {
  const escaped = escapeJt808(Buffer.from([0x7f]), false);
  assert.deepEqual([...escaped], [0x7f]);
});

test('落单的 0x7D 不当成转义序列', () => {
  assert.deepEqual([...unescapeJt808(Buffer.from([0x01, 0x7d]))], [0x01, 0x7d]);
});

test('校验码是消息体属性到正文末字节的异或', () => {
  const frame = buildJt808Frame({ messageId: 0x0002, body: Buffer.alloc(0), seq: 1 });
  const inner = frame.subarray(1, frame.length - 1);
  // 帧结构：0x7E | 消息头(12) | 校验码 | 0x7E
  assert.equal(frame[0], 0x7e);
  assert.equal(frame[frame.length - 1], 0x7e);
  assert.equal(jt808Checksum(inner.subarray(0, inner.length - 1)), inner[inner.length - 1]);
});

test('组出来的帧：消息头字段与正文对得上', () => {
  const body = registerBody();
  const frame = buildJt808Frame({ messageId: 0x0001, body, seq: 0x1234 });
  const inner = unescapeJt808(frame.subarray(1, frame.length - 1));
  const header = parseJt808Header(inner);
  assert.ok(header);
  assert.equal(header.messageId, 0x0001);
  assert.equal(header.seq, 0x1234);
  assert.equal(header.declaredLength, body.length);
  assert.equal(header.bodyLength, body.length);
  assert.equal(header.checksumOk, true);
  assert.equal(header.encrypted, false);
  assert.equal(header.subPackage, false);
});

/* ------------------------------ 切帧 ------------------------------ */

test('一帧切出来并解析出注册信息', () => {
  const frame = buildJt808Frame({ messageId: 0x0001, body: registerBody(), seq: 7 });
  const parser = new Jt808Parser();
  const frames = parser.push(frame);
  assert.equal(frames.length, 1);
  const decoded = decodeJt808(frames[0]);
  assert.equal(decoded.messageId, 0x0001);
  assert.equal(decoded.messageName, '终端注册');
  const fields = fieldMap(decoded.fields);
  assert.equal(fields['省份编码'], '3132');
  assert.equal(fields['市域编码'], '3031');
  assert.equal(fields['制造商编码'], 'TESTMANU001');
  assert.equal(fields['终端型号'], 'MODEL-TEST-001');
  assert.equal(fields['终端编号'], '123456789012345');
  assert.equal(fields['固件版本号'], 'V1.0.0');
});

test('一帧被拆成多段喂入也能切出来', () => {
  const frame = buildJt808Frame({ messageId: 0x0002, body: Buffer.alloc(0), seq: 3 });
  const parser = new Jt808Parser();
  assert.equal(parser.push(frame.subarray(0, 4)).length, 0);
  assert.equal(parser.push(frame.subarray(4, 9)).length, 0);
  const frames = parser.push(frame.subarray(9));
  assert.equal(frames.length, 1);
  assert.equal(decodeJt808(frames[0]).messageId, 0x0002);
});

test('连续多帧粘在一起能逐帧切开', () => {
  const stream = Buffer.concat([
    buildJt808Frame({ messageId: 0x0001, body: registerBody(), seq: 1 }),
    buildJt808Frame({ messageId: 0x0002, body: Buffer.alloc(0), seq: 2 }),
    buildJt808Frame({ messageId: 0x0200, body: positionBody(), seq: 3 }),
  ]);
  const frames = new Jt808Parser().push(stream);
  assert.equal(frames.length, 3);
  assert.deepEqual(
    frames.map((f) => decodeJt808(f).messageId),
    [0x0001, 0x0002, 0x0200],
  );
});

test('噪声字节会被丢掉，不影响后续切帧', () => {
  const frame = buildJt808Frame({ messageId: 0x0002, body: Buffer.alloc(0), seq: 1 });
  const frames = new Jt808Parser().push(Buffer.concat([Buffer.from([0xaa, 0xbb, 0xcc]), frame]));
  assert.equal(frames.length, 1);
});

test('分包收齐了才拼成一条完整消息', () => {
  // 正文前面加 4 字节：包序号 + 总包数
  const part = (index: number, total: number, payload: Buffer): Buffer =>
    Buffer.concat([Buffer.from([0x00, index, 0x00, total]), payload]);

  const parser = new Jt808Parser();
  const first = buildJt808Frame({ messageId: 0x0999, body: part(1, 2, Buffer.from('ABC')), seq: 1 });
  const second = buildJt808Frame({ messageId: 0x0999, body: part(2, 2, Buffer.from('DEF')), seq: 1 });
  // 分包位：消息体属性 bit14
  first.writeUInt16BE(first.readUInt16BE(1) | (1 << 14), 1);
  second.writeUInt16BE(second.readUInt16BE(1) | (1 << 14), 1);

  assert.equal(parser.push(first).length, 0); // 还缺一半
  const frames = parser.push(second);
  assert.equal(frames.length, 1);
  const decoded = decodeJt808(frames[0]);
  assert.equal(decoded.messageId, 0x0999);
  // 两半拼起来是 ABCDEF
  assert.equal(decoded.fields.find((f) => f.key === '正文')?.raw, '414243444546');
});

/* ------------------------------ 解析 ------------------------------ */

test('心跳解析出来并给出该回什么', () => {
  const frame = buildJt808Frame({ messageId: 0x0002, body: Buffer.alloc(0), seq: 9 });
  const decoded = decodeJt808(frame.subarray(1, frame.length - 1));
  assert.equal(decoded.messageName, '终端心跳');
  assert.equal(fieldMap(decoded.fields)['心跳'], '终端在线');
  assert.ok(decoded.reply);
  assert.equal(decoded.reply.note, '心跳应答');
  // 回的是 0x8002，正文为空
  const replyInner = unescapeJt808(decoded.reply.data.subarray(1, decoded.reply.data.length - 1));
  const replyHeader = parseJt808Header(replyInner);
  assert.equal(replyHeader?.messageId, 0x8002);
  assert.equal(replyHeader?.bodyLength, 0);
  assert.equal(replyHeader?.seq, 9);
});

test('终端注册要回注册应答，序列号沿用终端那一帧', () => {
  const frame = buildJt808Frame({ messageId: 0x0001, body: registerBody(), seq: 42 });
  const decoded = decodeJt808(frame.subarray(1, frame.length - 1));
  assert.ok(decoded.reply);
  assert.equal(decoded.reply.note, '注册应答');
  const replyInner = unescapeJt808(decoded.reply.data.subarray(1, decoded.reply.data.length - 1));
  const replyHeader = parseJt808Header(replyInner);
  assert.equal(replyHeader?.messageId, 0x8001);
  assert.equal(replyHeader?.seq, 42);
  assert.equal(replyHeader?.checksumOk, true);
  // 正文：应答序列号(2) + 应答标志(1)
  const replyBody = replyInner.subarray(12, replyInner.length - 1);
  assert.equal(replyBody.readUInt16BE(0), 42);
  assert.equal(replyBody[2], 0);
});

test('终端补注册要回补注册应答', () => {
  const frame = buildJt808Frame({ messageId: 0x0005, body: registerBody(), seq: 5 });
  const decoded = decodeJt808(frame.subarray(1, frame.length - 1));
  assert.equal(decoded.reply?.note, '补注册应答');
  const replyInner = unescapeJt808(decoded.reply!.data.subarray(1, decoded.reply!.data.length - 1));
  assert.equal(parseJt808Header(replyInner)?.messageId, 0x8005);
});

test('位置信息解析出经纬度、速度与定位状态', () => {
  const frame = buildJt808Frame({ messageId: 0x0200, body: positionBody(), seq: 11 });
  const decoded = decodeJt808(frame.subarray(1, frame.length - 1));
  const fields = fieldMap(decoded.fields);
  assert.equal(fields['经度'], '116.397128°');
  assert.equal(fields['纬度'], '39.916527°');
  assert.equal(fields['高度'], '100.0 米');
  assert.equal(fields['速度'], '30.0 千米/小时');
  assert.equal(fields['方向'], '90°');
  assert.equal(fields['定位时间'], '2026-11-18 10:30:00');
  assert.equal(fields['卫星数'], '8');
  assert.equal(fields['定位状态'], '定位有效，北纬，东经');
});

test('车辆状态信息解析出状态位', () => {
  const frame = buildJt808Frame({ messageId: 0x0300, body: Buffer.from([0x01, 0x02]), seq: 1 });
  const decoded = decodeJt808(frame.subarray(1, frame.length - 1));
  const fields = fieldMap(decoded.fields);
  assert.equal(fields['车辆状态'], '紧急报警');
  assert.equal(fields['扩展车辆状态'], '主电源状态');
});

test('校验码不对的帧会标出来', () => {
  const frame = buildJt808Frame({ messageId: 0x0002, body: Buffer.alloc(0), seq: 1 });
  const inner = Buffer.from(frame.subarray(1, frame.length - 1));
  inner[inner.length - 1] ^= 0xff; // 改坏校验码
  const decoded = decodeJt808(inner);
  assert.equal(decoded.checksumOk, false);
  assert.match(fieldMap(decoded.fields)['校验码'], /不对/);
  // 校验不过就不自动回包——回一个校验码也错的东西没用
  assert.equal(decoded.reply, undefined);
});

/* ------------------------------ 组包 ------------------------------ */

/**
 * 组出来的完整报文（带 0x7E 包头包尾、转义过）也得能解。
 *
 * 记录里「发出去的那一帧」就是这种形状——解错了那条记录等于没发。
 */
test('组出来的完整报文也能解：解转义、摘包头包尾', () => {
  const frame = buildJt808Command({ kind: 'platform.text', args: { text: 'hi' } });
  assert.equal(frame[0], 0x7e);
  assert.equal(frame[frame.length - 1], 0x7e);
  const decoded = decodeJt808(frame);
  assert.equal(decoded.messageId, 0x8101);
  assert.equal(decoded.checksumOk, true);
  assert.equal(fieldMap(decoded.fields)['文本内容'], 'hi');
});

test('正文里有 0x7E 也能往返：转义出去再解回来', () => {
  const body = Buffer.from([0x00, 0x7e, 0x7d, 0x7f]); // 标志 + 三个要转义的字节
  const frame = buildJt808Frame({ messageId: 0x0999, body, seq: 1 });
  // 转义后长度变长了
  assert.ok(frame.length > body.length + 12 + 2);
  const decoded = decodeJt808(frame);
  assert.equal(decoded.messageId, 0x0999);
  assert.equal(decoded.checksumOk, true);
  assert.equal(decoded.fields.find((f) => f.key === '正文')?.raw, '007E7D7F');
});
test('组平台注册应答：正文是应答序列号加应答标志', () => {
  const frame = buildJt808Command({ kind: 'platform.register.reply', args: { seq: '7' } });
  const inner = unescapeJt808(frame.subarray(1, frame.length - 1));
  const header = parseJt808Header(inner);
  assert.equal(header?.messageId, 0x8001);
  assert.equal(header?.seq, 7);
  assert.equal(header?.checksumOk, true);
  const body = inner.subarray(12, inner.length - 1);
  assert.equal(body.length, 3);
  assert.equal(body.readUInt16BE(0), 7);
  assert.equal(body[2], 0);
});

test('组注册应答失败时带上失败原因', () => {
  const frame = buildJt808Command({
    kind: 'platform.register.reply',
    args: { seq: '7', result: '1', reason: '3' },
  });
  const inner = unescapeJt808(frame.subarray(1, frame.length - 1));
  const body = inner.subarray(12, inner.length - 1);
  assert.equal(body.length, 4);
  assert.equal(body[2], 1);
  assert.equal(body[3], 3);
});

test('组平台通用应答：应答序列号、被应答消息 ID 与结果', () => {
  const frame = buildJt808Command({
    kind: 'platform.general.reply',
    args: { seq: '12', messageId: '0x0200', result: '0' },
  });
  const inner = unescapeJt808(frame.subarray(1, frame.length - 1));
  assert.equal(parseJt808Header(inner)?.messageId, 0x8004);
  const body = inner.subarray(12, inner.length - 1);
  assert.equal(body.readUInt16BE(0), 12);
  assert.equal(body.readUInt16BE(2), 0x0200);
  assert.equal(body[4], 0);
});

test('组文本信息下发：正文是标志加文本', () => {
  const frame = buildJt808Command({ kind: 'platform.text', args: { text: 'AB', flag: '0' } });
  const inner = unescapeJt808(frame.subarray(1, frame.length - 1));
  assert.equal(parseJt808Header(inner)?.messageId, 0x8101);
  const body = inner.subarray(12, inner.length - 1);
  assert.equal(body[0], 0);
  assert.equal(body.subarray(1).toString('utf8'), 'AB');
});

test('组实时位置查询：正文为空', () => {
  const frame = buildJt808Command({ kind: 'platform.location.query', args: { seq: '2' } });
  const inner = unescapeJt808(frame.subarray(1, frame.length - 1));
  const header = parseJt808Header(inner);
  assert.equal(header?.messageId, 0x8103);
  assert.equal(header?.bodyLength, 0);
});

test('不会组的命令要报错，别默默发一帧废数据', () => {
  assert.throws(() => buildJt808Command({ kind: 'platform.nope', args: {} }), /不会组这条命令/);
});
