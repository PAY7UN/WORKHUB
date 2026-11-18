import assert from 'node:assert/strict';
import test from 'node:test';
import {
  convertDocumentToMarkdown,
  csvToMarkdown,
  htmlToMarkdown,
  textToMarkdown,
} from './docToMarkdown.ts';

test('HTML 转 Markdown：标题、列表、表格都要留住', () => {
  const html = [
    '<html><head><title>通达协议</title></head><body>',
    '<h1>帧结构</h1>',
    '<p>一帧由 <strong>帧头</strong> 与 <em>帧尾</em> 组成。</p>',
    '<ul><li>帧头 BB</li><li>帧尾 55</li></ul>',
    '<table><tr><th>段</th><th>长度</th></tr><tr><td>帧头</td><td>1 字节</td></tr></table>',
    '<script>console.log(1)</script>',
    '</body></html>',
  ].join('');

  const { markdown, pageTitle } = htmlToMarkdown(html);
  assert.equal(pageTitle, '通达协议');
  assert.match(markdown, /# 帧结构/);
  assert.match(markdown, /\*\*帧头\*\*/);
  assert.match(markdown, /- 帧头 BB/);
  assert.match(markdown, /\| 段 \| 长度 \|/);
  assert.match(markdown, /\| 帧头 \| 1 字节 \|/);
  // 脚本不是正文，不能进文档
  assert.doesNotMatch(markdown, /console\.log/);
});

test('CSV 转 Markdown 表格', () => {
  const markdown = csvToMarkdown('段,长度\n帧头,1\n帧尾,1');
  assert.match(markdown, /\| 段 \| 长度 \|/);
  assert.match(markdown, /\| 帧头 \| 1 \|/);
  assert.match(markdown, /\| 帧尾 \| 1 \|/);
});

test('纯文本转 Markdown：明显的标题行提上来', () => {
  const markdown = textToMarkdown('一、帧结构\n\n帧头 BB，帧尾 55。\n\n二、命令码');
  assert.match(markdown, /## 一、帧结构/);
  assert.match(markdown, /## 二、命令码/);
  assert.match(markdown, /帧头 BB，帧尾 55。/);
});

test('上传的文件按文件名分派格式', async () => {
  const csv = await convertDocumentToMarkdown({
    bytes: Buffer.from('a,b\n1,2', 'utf8'),
    filename: 'params.csv',
  });
  assert.equal(csv.kind, 'csv');
  assert.match(csv.markdown, /\| a \| b \|/);

  const text = await convertDocumentToMarkdown({
    bytes: Buffer.from('一、帧结构\n\n帧头 BB。', 'utf8'),
    filename: 'readme.txt',
  });
  assert.equal(text.kind, 'text');
  assert.match(text.markdown, /## 一、帧结构/);
});

test('不认识的格式不丢内容，但要提醒一句', async () => {
  const result = await convertDocumentToMarkdown({
    bytes: Buffer.from('随便一段话', 'utf8'),
    filename: 'note.xyz',
  });
  assert.match(result.markdown, /随便一段话/);
  assert.equal(result.warnings.length, 1);
});

test('HTML 的 doctype 不能混进正文', () => {
  const { markdown } = htmlToMarkdown(
    '<!doctype html>\n<html><body><h1>帧结构</h1></body></html>',
  );
  assert.doesNotMatch(markdown, /doctype/i);
  assert.match(markdown, /# 帧结构/);
});

test('上传 HTML 时用网页自己的标题', async () => {
  const result = await convertDocumentToMarkdown({
    bytes: Buffer.from('<html><head><title>通达协议</title></head><body>x</body></html>', 'utf8'),
    filename: 'manual.html',
  });
  assert.equal(result.title, '通达协议');

  const named = await convertDocumentToMarkdown({
    bytes: Buffer.from('<html><head><title>通达协议</title></head><body>x</body></html>', 'utf8'),
    filename: 'manual.html',
    title: '厂家说明书',
  });
  assert.equal(named.title, '厂家说明书');
});
