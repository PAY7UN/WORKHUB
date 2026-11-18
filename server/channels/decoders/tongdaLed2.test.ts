import assert from 'node:assert/strict';
import test from 'node:test';

import { buildLed2Frame, decodeLed2, Led2Parser, led2ChecksumOk } from './tongdaLed2.ts';

/**
 * 文档里的示例帧。
 *
 * 按字节分段拼，避免长 hex 串抄错。
 * 注意：文档的 0x04 与 0x16 两例字节数与 LEN 字段差 1（文档漏了一个校验字节），
 * 这里按 LEN + 校验 + 帧尾补齐；0xF5 那例内容多一个字节且校验和对不上，同样按协议重算。
 */
const FRAMES = {
  broadcast: ['BB', '10', '0F', '01', '45152603101600000000', 'C900', '55'].join(''),
  broadcastUp: ['BB', '10', '0F', '01', '00091505071100000000', '5B00', '55'].join(''),
  broadcastDown: ['BB', '10', '0F', '01', '30161505071180000000', '1801', '55'].join(''),
  route: [
    'BB',
    '10',
    '1F',
    '02',
    '0B',
    'B2DC D6BE BAC0 3730 37CF DF',
    '04',
    'BBAACFC4',
    '08',
    'BBA8C7C5C9E7C7F8',
    '8610',
    '55',
  ]
    .join('')
    .replace(/ /g, ''),
  innerScreen: ['BB', '10', '13', '03', '20C6F0B5E3D5BE20BBAACFC4200F6E', '6E08', '55'].join(''),
  innerAd: ['BB', '10', '12', '04', '0B', '33C9CFB3B5B5C4C8CBB6E0', '14', '1A08', '55'].join(''),
  station: ['BB', '10', '18', '08', '80', '8A', '20C6F0B5E3D5BE20BBA8C7C5C9E7C7F820', 'D90C', '55'].join(''),
  routeBi: [
    'BB',
    '10',
    '21',
    '10',
    '0B',
    'B2DC D6BE BAC0 3730 37CF DF',
    '08',
    'BBA8C7C5C9E7C7F8',
    '00',
    '04',
    'BBAACFC4',
    '00',
    '9610',
    '55',
  ]
    .join('')
    .replace(/ /g, ''),
  side: [
    'BB',
    '10',
    '50',
    '11',
    '08',
    '00',
    '04',
    'BBAACFC4',
    '01',
    '08',
    'BFAAB8A3CBC2B6AB',
    '02',
    '06',
    'D6F1C9BDD4B0',
    '03',
    '0A',
    'CFE6D1C5C2B7CEF7BFDA',
    '04',
    '06',
    'B3B1D7DABDD6',
    '05',
    '08',
    'BBF0D1E6C2B7BFDA',
    '06',
    '08',
    'D7D8CAF7C2B7BFDA',
    '07',
    '08',
    'BBA8C7C5C9E7C7F8',
    '682E',
    '55',
  ].join(''),
  schedule: ['BB', '10', '09', '12', '0600', '161E', '6500', '55'].join(''),
  fare: ['BB', '10', '0E', '13', '80', '03', '322E30', '03', '312E38', 'DE01', '55'].join(''),
  texts: ['BB', '10', '10', '14', '02', '01', '03', '313233', '02', '03', '343536', '7401', '55'].join(''),
  crew: [
    'BB',
    '10',
    '2A',
    '16',
    '02',
    '01',
    '06',
    '313233343536',
    '00',
    '08',
    'B6AB B2BF B9AB BDBB',
    '0C',
    'C9EE DBDA B6AB B2BF B9AB BDBB',
    '02',
    '00000000',
    '6C10',
    '55',
  ]
    .join('')
    .replace(/ /g, ''),
  alarm: ['BB', '10', '0E', 'F5', '01', '07', '5741524E494E47', '3103', '55'].join(''),
  passenger1: ['BB', '10', '12', 'E2', '00000001', '02', '20030000', 'EE020000', '1A02', '55'].join(''),
  passenger2: [
    'BB',
    '10',
    '1B',
    'E2',
    '00000002',
    '01',
    '1F020000',
    'B3010000',
    '02',
    '20030000',
    'EE020000',
    'FA02',
    '55',
  ].join(''),
  paramQuery: ['BB', '10', '0A', 'E3', '01', '6400', 'B004', '1602', '55'].join(''),
  paramAnswer: ['BB', '01', '0E', 'E4', '6400', '06', '312E302E3100', '4B02', '55'].join(''),
};

function hex(s: string): Buffer {
  return Buffer.from(s, 'hex');
}

/** 把字段数组转成对象，方便断言 */
function fieldMap(fields: { key: string; value: string }[]): Record<string, string> {
  return Object.fromEntries(fields.map((f) => [f.key, f.value]));
}

test('校验和按 ADDR 到最后一个数据字节累加，16 位小端', () => {
  const frame = hex(FRAMES.broadcast);
  assert.equal(led2ChecksumOk(frame), true);
  const bad = Buffer.from(frame);
  bad[4] = 0x46; // 改一个数据字节
  assert.equal(led2ChecksumOk(bad), false);
});

test('切出一帧并解析广播线路状态', () => {
  const parser = new Led2Parser();
  const frames = parser.push(hex(FRAMES.broadcast));
  assert.equal(frames.length, 1);
  const parsed = decodeLed2(frames[0]);
  assert.equal(parsed.command, '广播线路状态');
  assert.equal(parsed.device, 'GPS 终端');
  const fields = fieldMap(parsed.fields);
  assert.equal(fields['时间'], '2016-10-26 15:45:00');
  assert.equal(fields['星期'], '星期3');
  assert.equal(fields['上下行'], '上行');
  assert.equal(fields['到离站'], '离站，站点序号 0');
});

test('广播上下行按 bit7 判定', () => {
  const up = decodeLed2(hex(FRAMES.broadcastUp));
  assert.equal(fieldMap(up.fields)['上下行'], '上行');
  assert.equal(fieldMap(up.fields)['时间'], '2011-07-15 09:00:00');
  const down = decodeLed2(hex(FRAMES.broadcastDown));
  assert.equal(fieldMap(down.fields)['上下行'], '下行');
  assert.equal(fieldMap(down.fields)['时间'], '2011-07-15 16:30:00');
});

test('路牌字符解析出线路名与起终点', () => {
  const parsed = decodeLed2(hex(FRAMES.route));
  assert.equal(parsed.command, '路牌字符');
  const fields = fieldMap(parsed.fields);
  assert.equal(fields['线路名'], '曹志豪707线');
  assert.equal(fields['起点站'], '华夏');
  assert.equal(fields['终点站'], '花桥社区');
});

test('报站解析出到离站、上下行与内容', () => {
  const parsed = decodeLed2(hex(FRAMES.station));
  const fields = fieldMap(parsed.fields);
  assert.equal(fields['到离站'], '到站，站点序号 0');
  assert.equal(fields['上下行'], '下行，总站点数 10');
  assert.equal(fields['报站内容'], '起点站 花桥社区');
});

test('首末班时间与票价按 BCD 与长度前缀解析', () => {
  const schedule = fieldMap(decodeLed2(hex(FRAMES.schedule)).fields);
  assert.equal(schedule['首班时间'], '6:00');
  assert.equal(schedule['末班时间'], '22:30');

  const fare = fieldMap(decodeLed2(hex(FRAMES.fare)).fields);
  assert.equal(fare['季节标志'], '春节');
  assert.equal(fare['投币价格'], '2.0');
  assert.equal(fare['刷卡价格'], '1.8');
});

test('文本信息按条数与长度解析', () => {
  const fields = fieldMap(decodeLed2(hex(FRAMES.texts)).fields);
  assert.equal(fields['条数'], '2');
  assert.equal(fields['文本列表'], '#1 123，#2 456');
});

test('报警消息解析出使能与内容', () => {
  const fields = fieldMap(decodeLed2(hex(FRAMES.alarm)).fields);
  assert.equal(fields['报警'], '开启报警');
  assert.equal(fields['报警内容'], 'WARNING');
});

test('客流数据解析出每个门的上下车人数', () => {
  const one = fieldMap(decodeLed2(hex(FRAMES.passenger1)).fields);
  assert.equal(one['门数'], '1');
  assert.equal(one['门 2'], '上车 800 人，下车 750 人');

  const two = fieldMap(decodeLed2(hex(FRAMES.passenger2)).fields);
  assert.equal(two['门数'], '2');
  assert.equal(two['门 1'], '上车 543 人，下车 435 人');
  assert.equal(two['门 2'], '上车 800 人，下车 750 人');
});

test('查询参数与应答按小端参数 ID 解析', () => {
  const query = fieldMap(decodeLed2(hex(FRAMES.paramQuery)).fields);
  assert.equal(query['查询设备'], '车外头牌');
  assert.equal(query['参数 100'], 'hardware revision');
  assert.equal(query['参数 1200'], 'Over Voltage');

  const answer = fieldMap(decodeLed2(hex(FRAMES.paramAnswer)).fields);
  assert.equal(answer['参数 100'], '1.0.1（hardware revision）');
});

test('侧牌站点列表按序号与长度解析', () => {
  const parsed = decodeLed2(hex(FRAMES.side));
  assert.equal(parsed.command, '侧牌字符');
  const fields = fieldMap(parsed.fields);
  assert.equal(fields['总站点数'], '8');
  assert.match(fields['站点列表'], /0\. 华夏/);
  assert.match(fields['站点列表'], /7\. 花桥社区/);
});

test('一帧被拆成多段喂入也能切出来', () => {
  const parser = new Led2Parser();
  const frame = hex(FRAMES.route);
  assert.equal(parser.push(frame.subarray(0, 3)).length, 0);
  assert.equal(parser.push(frame.subarray(3, 10)).length, 0);
  const frames = parser.push(frame.subarray(10));
  assert.equal(frames.length, 1);
  assert.equal(decodeLed2(frames[0]).command, '路牌字符');
});

test('连续多帧粘在一起能逐帧切开', () => {
  const parser = new Led2Parser();
  const stream = hex(FRAMES.broadcast + FRAMES.route + FRAMES.alarm);
  const frames = parser.push(stream);
  assert.equal(frames.length, 3);
  assert.deepEqual(
    frames.map((f) => decodeLed2(f).command),
    ['广播线路状态', '路牌字符', '报警消息'],
  );
});

test('噪声字节会被丢掉，不影响后续切帧', () => {
  const parser = new Led2Parser();
  const frames = parser.push(hex('AABBCC' + FRAMES.alarm));
  assert.equal(frames.length, 1);
  assert.equal(decodeLed2(frames[0]).command, '报警消息');
});

test('行驶证信息按角色与长度解析', () => {
  const fields = fieldMap(decodeLed2(hex(FRAMES.crew)).fields);
  assert.equal(fields['人数'], '2');
  assert.match(fields['人员 1'], /司机，工号 123456/);
  assert.match(fields['人员 1'], /姓名 东部公交/);
  assert.match(fields['人员 1'], /分公司 深圳东部公交/);
  assert.match(fields['人员 2'], /售票员 \/ 乘务员/);
});

test('构造帧的校验和与长度字段符合协议', () => {
  const frame = buildLed2Frame(0x10, 0x01, hex('45152603101600000000'));
  assert.equal(frame.toString('hex').toUpperCase(), FRAMES.broadcast);
});

test('构造帧时命令码与数据都会带上', () => {
  const frame = buildLed2Frame(0x10, 0xf5, hex('074641524E494E47'));
  const parsed = decodeLed2(frame);
  assert.equal(parsed.command, '报警消息');
  assert.equal(led2ChecksumOk(frame), true);
});
