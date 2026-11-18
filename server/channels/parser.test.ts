import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeFrame, FrameParser, parseHex, toHex } from './parser.ts';
import type { ProtocolTemplate } from '../../shared/tools.ts';

const textTemplate: ProtocolTemplate = {
  id: 'text-line',
  name: '文本行',
  summary: '',
  framing: { kind: 'delimiter', delimiter: '0d0a' },
  encoding: 'utf8',
};

test('parseHex：允许空格与 0x 前缀，遇到奇数长度要报错', () => {
  assert.deepEqual(parseHex('0d0a'), Buffer.from([0x0d, 0x0a]));
  assert.deepEqual(parseHex('AA BB'), Buffer.from([0xaa, 0xbb]));
  assert.deepEqual(parseHex('0xAA'), Buffer.from([0xaa]));
  assert.throws(() => parseHex('abc'));
  assert.throws(() => parseHex('zz'));
  assert.deepEqual(parseHex(''), Buffer.alloc(0));
});

test('toHex：大写、不带分隔符', () => {
  assert.equal(toHex(Buffer.from([0x0d, 0x0a, 0xff])), '0D0AFF');
});

test('分隔符切帧：一帧被拆到两个 chunk 里也能拼回来', () => {
  const parser = new FrameParser(textTemplate.framing);

  const first = parser.push(Buffer.from('he'));
  assert.equal(first.length, 0);

  const second = parser.push(Buffer.from('llo\r\nwor'));
  assert.equal(second.length, 1);
  assert.equal(second[0].toString('utf8'), 'hello');

  const third = parser.push(Buffer.from('ld\r\n'));
  assert.equal(third.length, 1);
  assert.equal(third[0].toString('utf8'), 'world');
});

test('分隔符切帧：结尾没有分隔符的残余留在缓冲里，等 flush', () => {
  const parser = new FrameParser(textTemplate.framing);
  parser.push(Buffer.from('abc\r\nde'));
  assert.equal(parser.pending(), 2);

  const flushed = parser.flush();
  assert.equal(flushed.length, 1);
  assert.equal(flushed[0].toString('utf8'), 'de');
});

test('定长切帧：不足一帧的字节压着等下一段', () => {
  const parser = new FrameParser({ kind: 'fixed', fixedLength: 4 });

  const frames = parser.push(Buffer.from([1, 2, 3, 4, 5, 6]));
  assert.equal(frames.length, 1);
  assert.deepEqual([...frames[0]], [1, 2, 3, 4]);
  assert.equal(parser.pending(), 2);
});

test('长度字段切帧：大端，长度不含字段本身', () => {
  const parser = new FrameParser({
    kind: 'length',
    lengthOffset: 2,
    lengthSize: 2,
    lengthEndian: 'be',
    lengthIncludesHeader: false,
  });

  // 头部：00 02（占位） + 00 03（长度 3）
  const frames = parser.push(Buffer.from([0x00, 0x02, 0x00, 0x03, 0xaa, 0xbb, 0xcc]));
  assert.equal(frames.length, 1);
  assert.equal(frames[0].length, 7);
  assert.deepEqual([...frames[0]], [0x00, 0x02, 0x00, 0x03, 0xaa, 0xbb, 0xcc]);
});

test('长度字段切帧：小端，且长度含字段本身', () => {
  const parser = new FrameParser({
    kind: 'length',
    lengthOffset: 0,
    lengthSize: 2,
    lengthEndian: 'le',
    lengthIncludesHeader: true,
  });

  // 长度 4（小端 04 00），含头共 4 字节
  const frames = parser.push(Buffer.from([0x04, 0x00, 0x11, 0x22]));
  assert.equal(frames.length, 1);
  assert.equal(frames[0].length, 4);
});

test('长度字段切帧：数据没到齐就先不出帧', () => {
  const parser = new FrameParser({
    kind: 'length',
    lengthOffset: 0,
    lengthSize: 2,
    lengthEndian: 'be',
    lengthIncludesHeader: false,
  });

  const frames = parser.push(Buffer.from([0x00, 0x05, 0x01, 0x02]));
  assert.equal(frames.length, 0);
  assert.equal(parser.pending(), 4);
});

test('空闲切帧：不定界，只在 flush 时出帧', () => {
  const parser = new FrameParser({ kind: 'timeout', idleMs: 200 });
  assert.equal(parser.push(Buffer.from([1, 2, 3])).length, 0);

  const flushed = parser.flush();
  assert.equal(flushed.length, 1);
  assert.equal(flushed[0].length, 3);
});

test('decodeFrame：文本按编码解，十六进制始终留着', () => {
  const decoded = decodeFrame(Buffer.from('hi', 'utf8'), textTemplate);
  assert.equal(decoded.text, 'hi');
  assert.equal(decoded.hex, '6869');
  assert.equal(decoded.parsed, undefined);
});

test('decodeFrame：JSON 模板解析不出结构时留原文，不算错', () => {
  const jsonTemplate: ProtocolTemplate = { ...textTemplate, json: true };

  const ok = decodeFrame(Buffer.from('{"a":1}', 'utf8'), jsonTemplate);
  assert.deepEqual(ok.parsed, { a: 1 });

  const bad = decodeFrame(Buffer.from('not json', 'utf8'), jsonTemplate);
  assert.equal(bad.parsed, undefined);
  assert.equal(bad.text, 'not json');
});
