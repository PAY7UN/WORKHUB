/**
 * 数据分析的回归测试。
 *
 * 这一层最怕两件事：数错、和列名对不上还硬算。
 * 所以断言全盯在数字上——平均值、中位数、分组汇总、命中行数，
 * 以及「列不存在」时必须报错而不是给一个空结果。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { analyze, formatAnalyzeResult, inferType, numericStats, parseDelimited, parseTable } from './dataAnalyze.ts';

const CSV = ['部门,销售额,人数', '甲,100,2', '乙,200,4', '甲,300,6', '丙,,3'].join('\n');

test('分隔文本能解析：引号里的逗号不算分隔符', () => {
  const rows = parseDelimited('a,b\n"x,y",z', ',');
  assert.deepEqual(rows, [
    ['a', 'b'],
    ['x,y', 'z'],
  ]);
});

test('JSON 数组被解析成行', () => {
  const { rows, columns } = parseTable(JSON.stringify([{ 名字: '甲', 分数: 90 }]));
  assert.deepEqual(columns, ['名字', '分数']);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]['分数'], 90);
});

test('CSV 的数字会被转成数字，缺失留空', () => {
  const { rows } = parseTable(CSV);
  assert.equal(rows.length, 4);
  assert.equal(rows[0]['销售额'], 100);
  assert.equal(rows[3]['销售额'], '');
  assert.equal(rows[3]['部门'], '丙');
});

test('列类型推断：数值、布尔、文本各归各位', () => {
  assert.equal(inferType([1, 2, 3]), 'number');
  assert.equal(inferType([true, false]), 'boolean');
  assert.equal(inferType(['甲', '乙']), 'string');
  assert.equal(inferType(['1', '2']), 'number');
});

test('数值统计量算得对', () => {
  const stats = numericStats([1, 2, 3, 4]);
  assert.equal(stats.min, 1);
  assert.equal(stats.max, 4);
  assert.equal(stats.sum, 10);
  assert.equal(stats.mean, 2.5);
  assert.equal(stats.median, 2.5);
});

test('画像：给出每列的类型、缺失与极值', () => {
  const result = analyze({ source: CSV, op: 'describe' });
  assert.equal(result.rows, 4);
  const sales = result.profiles?.find((p) => p.name === '销售额');
  assert.ok(sales);
  assert.equal(sales.type, 'number');
  assert.equal(sales.missing, 1);
  assert.equal(sales.count, 3);
  assert.equal(sales.min, 100);
  assert.equal(sales.max, 300);
  assert.equal(sales.mean, 200);
});

test('分组汇总：按部门分组，求和与均值都对', () => {
  const result = analyze({ source: CSV, op: 'groupby', groupBy: '部门' });
  const jia = result.groups?.find((g) => g.key === '甲');
  assert.ok(jia);
  assert.equal(jia.count, 2);
  assert.equal(jia.stats['销售额_sum'], 400);
  assert.equal(jia.stats['销售额_mean'], 200);
  assert.equal(jia.stats['人数_sum'], 8);
});

test('筛选：命中数与命中行都对', () => {
  const result = analyze({ source: CSV, op: 'filter', column: '部门', condition: 'eq', value: '甲' });
  assert.equal(result.matchedCount, 2);
  assert.equal(result.matched?.length, 2);
});

test('筛选支持数值比较', () => {
  const result = analyze({ source: CSV, op: 'filter', column: '销售额', condition: 'gte', value: '200' });
  assert.equal(result.matchedCount, 2);
});

test('排序取前 N：默认从大到小', () => {
  const result = analyze({ source: CSV, op: 'top', column: '销售额', limit: 2 });
  assert.equal(result.matched?.length, 2);
  assert.equal(result.matched?.[0]['销售额'], 300);
  assert.equal(result.matched?.[1]['销售额'], 200);
});

test('列名写错时直接报错，并列出可用的列', () => {
  assert.throws(() => analyze({ source: CSV, op: 'groupby', groupBy: '不存在' }), /没有这些列/);
  assert.throws(() => analyze({ source: CSV, op: 'filter', column: '不存在' }), /可用的列/);
});

test('内容既不是 JSON 也不是表格时给的是人话', () => {
  assert.throws(() => analyze({ source: '随便一段话' }), /没有解析出任何数据行|解析不了/);
  assert.throws(() => analyze({ source: '   ' }), /没有数据可分析/);
});

test('结果能写成人能读的样子', () => {
  const text = formatAnalyzeResult(analyze({ source: CSV, op: 'describe' }), 'describe');
  assert.ok(text.includes('共 4 行'));
  assert.ok(text.includes('销售额'));
});
