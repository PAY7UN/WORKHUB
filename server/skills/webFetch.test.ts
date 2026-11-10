/**
 * 网页请求的回归测试。
 *
 * 重点在三处：
 * - HTML 抽正文：脚本、样式、导航不能混进正文，段落不能糊成一行；
 * - 分流：同一个接口返回 JSON 就得给结构化数据，不是当文本糊过去；
 * - 边界：地址不合法、请求头写错、超大响应截断，都要给出人话原因。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';

import { fetchWeb, htmlToText } from './webFetch.ts';

/** 起一个本地服务，测试期间用 */
async function startServer(handler: (url: string, body: string) => { status?: number; type?: string; body: string }): Promise<{
  url: string;
  close: () => Promise<void>;
}> {
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      const result = handler(req.url ?? '/', body);
      res.writeHead(result.status ?? 200, { 'Content-Type': result.type ?? 'text/plain; charset=utf-8' });
      res.end(result.body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test('HTML 抽正文：脚本样式被丢掉，标题留下，段落分行', () => {
  const html = `
    <html><head><title>示例页面</title>
      <style>body{color:red}</style>
      <script>console.log('别进来')</script>
    </head>
    <body>
      <nav>首页 关于</nav>
      <p>第一段内容。</p>
      <p>第二段内容。</p>
    </body></html>`;
  const { title, text } = htmlToText(html);
  assert.equal(title, '示例页面');
  assert.ok(text.includes('第一段内容。'));
  assert.ok(text.includes('第二段内容。'));
  assert.ok(!text.includes('console.log'), '脚本内容不该进正文');
  assert.ok(!text.includes('color:red'), '样式不该进正文');
  assert.ok(text.includes('\n'), '段落之间该有换行');
});

test('HTML 实体被还原', () => {
  const { text } = htmlToText('<p>a &amp; b &lt;c&gt; &quot;d&quot;</p>');
  assert.ok(text.includes('a & b'));
  assert.ok(text.includes('<c>'));
  assert.ok(text.includes('"d"'));
});

test('JSON 响应被解析成结构化数据', async () => {
  const server = await startServer(() => ({
    type: 'application/json',
    body: JSON.stringify({ items: [1, 2, 3], total: 3 }),
  }));
  try {
    const result = await fetchWeb({ url: `${server.url}/api/items` });
    assert.equal(result.kind, 'json');
    assert.equal(result.status, 200);
    assert.deepEqual((result.data as { total: number }).total, 3);
    assert.ok(result.text.includes('"total"'));
  } finally {
    await server.close();
  }
});

test('请求头与请求体会真的发出去', async () => {
  let seenHeader = '';
  let seenBody = '';
  const server = await startServer((_url, body) => {
    seenBody = body;
    return { body: 'ok' };
  });
  const original = globalThis.fetch;
  try {
    // 用包装过的 fetch 顺手把请求头记下来：服务端拿不到请求对象
    globalThis.fetch = (async (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const headers = init?.headers as Record<string, string> | undefined;
      seenHeader = String(headers?.['X-Test'] ?? '');
      return original(input, init);
    }) as typeof fetch;

    await fetchWeb({
      url: `${server.url}/api/ping`,
      method: 'POST',
      headers: JSON.stringify({ 'X-Test': 'yes' }),
      body: '{"a":1}',
    });
    assert.equal(seenHeader, 'yes');
    assert.equal(seenBody, '{"a":1}');
  } finally {
    globalThis.fetch = original;
    await server.close();
  }
});

test('地址不合法时给的是人话原因', async () => {
  await assert.rejects(() => fetchWeb({ url: 'not-a-url' }), /地址不合法/);
  await assert.rejects(() => fetchWeb({ url: 'file:///etc/passwd' }), /只支持 http\/https/);
  await assert.rejects(() => fetchWeb({ url: '' }), /请给出要请求的地址/);
});

test('请求头不是合法 JSON 时说清楚是请求头的问题', async () => {
  await assert.rejects(() => fetchWeb({ url: 'http://127.0.0.1:1/x', headers: '{oops' }), /请求头不是合法的 JSON/);
  await assert.rejects(
    () => fetchWeb({ url: 'http://127.0.0.1:1/x', headers: '["a"]' }),
    /请求头要是一个 JSON 对象/,
  );
});

test('响应体超过上限会被截断并如实标记', async () => {
  const big = 'x'.repeat(3 * 1024 * 1024);
  const server = await startServer(() => ({ body: big }));
  try {
    const result = await fetchWeb({ url: `${server.url}/big` });
    assert.equal(result.truncated, true);
    // 读到的是「看到的字节数」，最多多出一个数据块
    assert.ok(result.bytes <= 2 * 1024 * 1024 + 64 * 1024);
    assert.ok(result.text.length <= 20000);
  } finally {
    await server.close();
  }
});
