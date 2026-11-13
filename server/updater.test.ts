/**
 * 自动升级的单元测试。
 *
 * 重点测「会判断错的地方」：版本比较、更新源优先级、托管方式判断。
 * 下载、解包、换代码那些要碰真实的文件和进程，放在端到端里验。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  compareVersions,
  resolveUpdateSource,
  planUpgradeRestart,
  fetchManifest,
  type UpdateSource,
} from './updater.ts';

test('版本比较：按数字段比，不受 v 前缀和预发布标记干扰', () => {
  assert.equal(compareVersions('0.2.0', '0.1.0'), 1);
  assert.equal(compareVersions('0.1.0', '0.2.0'), -1);
  assert.equal(compareVersions('1.0.0', '1.0.0'), 0);
  assert.equal(compareVersions('v1.2.3', '1.2.3'), 0);
  assert.equal(compareVersions('0.2.0-beta', '0.2.0'), 0, '预发布标记在我们这儿不算版本差异');
  assert.equal(compareVersions('0.10.0', '0.9.0'), 1, '0.10 比 0.9 新，别按字符串比');
  assert.equal(compareVersions('1.2', '1.2.0'), 0);
  assert.equal(compareVersions('2', '1.9.9'), 1);
});

test('更新源：自定义源优先于 GitHub', () => {
  // 内网部署拿不到 GitHub，有自定义源就必须走自定义源
  const custom = resolveUpdateSource({
    WORKHUB_UPDATE_MANIFEST: 'https://intranet/manifest.json',
    WORKHUB_UPDATE_URL: 'https://intranet/pkg.zip',
  });
  assert.equal(custom.kind, 'manifest');

  const direct = resolveUpdateSource({ WORKHUB_UPDATE_URL: 'https://intranet/pkg.zip' });
  assert.equal(direct.kind, 'url');

  const gh = resolveUpdateSource({});
  assert.equal(gh.kind, 'github');
  assert.match(gh.url, /releases\/latest$/);

  // 仓库名可配：项目要是 fork 了或者搬家了，不用改代码
  const forked = resolveUpdateSource({ WORKHUB_UPDATE_REPO: 'someone/FORK' });
  assert.match(forked.url, /someone\/FORK/);
});

test('更新源：旧变量名不再生效', () => {
  // 旧名不认：配了它等于没配。
  // 认旧名的真正代价不是「升级失灵」，而是两套名长期并存——
  // 改了新名却因为旧名还在而没生效，这比直接失灵更难查。
  const old = resolveUpdateSource({ MDHUB_UPDATE_MANIFEST: 'https://intranet/manifest.json' });
  assert.equal(old.kind, 'github');

  const oldDirect = resolveUpdateSource({ MDHUB_UPDATE_URL: 'https://intranet/pkg.zip' });
  assert.equal(oldDirect.kind, 'github');

  const oldRepo = resolveUpdateSource({ MDHUB_UPDATE_REPO: 'someone/FORK' });
  assert.doesNotMatch(oldRepo.url, /someone\/FORK/);
});

test('更新源：新旧同时配时只认新名', () => {
  const both = resolveUpdateSource({
    WORKHUB_UPDATE_MANIFEST: 'https://new/manifest.json',
    MDHUB_UPDATE_MANIFEST: 'https://old/manifest.json',
  });
  assert.equal(both.url, 'https://new/manifest.json');
});

test('托管方式判断：谁在管这个进程，决定升级后谁来拉起', () => {
  // Windows 服务宿主：有看门狗，它会拉
  assert.equal(planUpgradeRestart({ WORKHUB_SERVICE_HOST: '1' }).mode, 'host');
  // 托盘：托盘盯着服务进程，死了会拉
  assert.equal(planUpgradeRestart({ WORKHUB_PARENT_PID: '1234' }).mode, 'tray');
  // 运维自己指定了重启命令
  assert.equal(planUpgradeRestart({ WORKHUB_RESTART_CMD: 'systemctl restart workhub' }).mode, 'command');
  // systemd / pm2
  assert.equal(planUpgradeRestart({ INVOCATION_ID: 'abc' }).mode, 'supervisor');
  assert.equal(planUpgradeRestart({ PM2_HOME: '/root/.pm2' }).mode, 'supervisor');
  // 什么都没有：裸跑，自己拉
  assert.equal(planUpgradeRestart({}).mode, 'self');

  // 宿主/托盘排在命令前面：它们已经在管这个进程了，
  // 再按命令去重启就是两套人同时管，抢端口
  assert.equal(
    planUpgradeRestart({ WORKHUB_SERVICE_HOST: '1', WORKHUB_RESTART_CMD: 'systemctl restart x' }).mode,
    'host',
  );
});

test('GitHub Release 清单：认得升级包资产，也认得配套的校验文件', async () => {
  const release = {
    tag_name: 'v0.3.0',
    body: '修了一堆东西',
    published_at: '2026-01-01T00:00:00Z',
    assets: [
      { name: 'workhub-server-0.3.0.zip', browser_download_url: 'https://example/pkg.zip', size: 1234 },
      { name: 'workhub-server-0.3.0.zip.sha256', browser_download_url: 'https://example/pkg.zip.sha256' },
    ],
  };
  const calls: string[] = [];
  const fakeFetch = (async (url: string) => {
    calls.push(String(url));
    if (String(url).endsWith('.sha256')) {
      return new Response('abc123  workhub-server-0.3.0.zip\n', { status: 200 });
    }
    return new Response(JSON.stringify(release), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;

  const source: UpdateSource = { kind: 'github', url: 'https://api.github.com/repos/a/b/releases/latest' };
  const manifest = await fetchManifest(source, fakeFetch);
  assert.ok(manifest);
  assert.equal(manifest.version, '0.3.0');
  assert.equal(manifest.url, 'https://example/pkg.zip');
  assert.equal(manifest.sha256, 'abc123');
  assert.equal(manifest.notes, '修了一堆东西');
  assert.ok(calls.length >= 2, '校验文件也要去取');
});

test('GitHub Release 清单：没发 Release 或没有产物，说人话', async () => {
  const notFound = (async () => new Response('{}', { status: 404 })) as unknown as typeof fetch;
  await assert.rejects(
    () => fetchManifest({ kind: 'github', url: 'https://x/releases/latest' }, notFound),
    /还没有发布 Release/,
  );

  const noAsset = (async () =>
    new Response(JSON.stringify({ tag_name: 'v0.3.0', assets: [] }), { status: 200 })) as unknown as typeof fetch;
  await assert.rejects(
    () => fetchManifest({ kind: 'github', url: 'https://x/releases/latest' }, noAsset),
    /没有 workhub-server-\*\.zip 产物/,
  );
});

test('自定义清单：认得 version / url / sha256', async () => {
  const fakeFetch = (async () =>
    new Response(
      JSON.stringify({
        version: '0.4.0',
        url: 'https://intranet/workhub-server-0.4.0.zip',
        sha256: 'deadbeef',
        notes: '内网版',
      }),
      { status: 200 },
    )) as unknown as typeof fetch;

  const manifest = await fetchManifest(
    { kind: 'manifest', url: 'https://intranet/manifest.json' },
    fakeFetch,
  );
  assert.ok(manifest);
  assert.equal(manifest.version, '0.4.0');
  assert.equal(manifest.url, 'https://intranet/workhub-server-0.4.0.zip');
  assert.equal(manifest.sha256, 'deadbeef');
});

test('包直链源：下载前不知道版本，返回 null', async () => {
  const manifest = await fetchManifest({ kind: 'url', url: 'https://intranet/latest.zip' });
  assert.equal(manifest, null, '版本在包里，下载完才知道');
});
