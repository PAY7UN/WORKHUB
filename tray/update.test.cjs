'use strict';
/**
 * 托盘自更新的单元测试。
 *
 * 重点覆盖「判断」类的逻辑：版本号比较、更新源的选择、
 * 从 Release 里认包、解包后找程序根。
 *
 * 不测「真的下载并替换文件」——那要真网络、真进程、真文件锁，
 * 属于集成测试的活儿（scripts/verify-upgrade.mjs 那条路）。
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  checkTrayUpdate,
  compareVersions,
  fetchTrayManifest,
  locateAppRoot,
  prepareUpdaterRuntime,
  resolveUpdateSource,
  sha256File,
  verifyChecksum,
} = require('./update.cjs');

/** 造一个假的 fetch，按 URL 返回预设内容 */
function fakeFetch(routes) {
  return async (url) => {
    const key = Object.keys(routes).find((k) => String(url).includes(k));
    if (!key) return { ok: false, status: 404 };
    const value = routes[key];
    if (value && typeof value === 'object' && 'status' in value) {
      return { ok: value.status < 400, status: value.status, json: async () => value.body };
    }
    return { ok: true, status: 200, json: async () => value };
  };
}

test('版本号比较：数字大小、位数不同、前缀 v', () => {
  assert.equal(compareVersions('0.1.0', '0.1.0'), 0);
  assert.equal(compareVersions('0.2.0', '0.1.9'), 1);
  assert.equal(compareVersions('0.1.0', '0.2.0'), -1);
  assert.equal(compareVersions('v0.2.0', '0.2.0'), 0);
  assert.equal(compareVersions('0.10.0', '0.9.0'), 1);
  assert.equal(compareVersions('1.0', '1.0.0'), 0);
});

test('版本号比较：预发布标记忽略', () => {
  // 内部工具不区分 beta 与正式版：同一个版本号就是同一个版本
  assert.equal(compareVersions('0.2.0-beta', '0.2.0'), 0);
});

test('更新源优先级：清单 > 直链 > GitHub', () => {
  const withManifest = resolveUpdateSource(
    { update: { manifest: 'https://a/manifest.json', url: 'https://a/p.zip' } },
    {},
  );
  assert.equal(withManifest.kind, 'manifest');
  assert.equal(withManifest.url, 'https://a/manifest.json');

  const withUrl = resolveUpdateSource({ update: { url: 'https://a/p.zip' } }, {});
  assert.equal(withUrl.kind, 'url');

  const fallback = resolveUpdateSource({}, {});
  assert.equal(fallback.kind, 'github');
  assert.match(fallback.url, /repos\/PAY7UN\/WORKHUB\/releases\/latest/);
});

test('更新源：环境变量能覆盖配置', () => {
  const source = resolveUpdateSource(
    { update: { repo: 'a/b' } },
    { WORKHUB_UPDATE_MANIFEST: 'https://x/m.json' },
  );
  assert.equal(source.kind, 'manifest');
  assert.equal(source.url, 'https://x/m.json');
});

test('更新源：旧变量名仍然生效，新名优先', () => {
  // 托盘与服务端必须读到同一个值：两边规则不一致的症状是
  // 「托盘连的是 A，服务端跑在 B」，属于最难查的那一类
  const old = resolveUpdateSource({}, { MDHUB_UPDATE_MANIFEST: 'https://old/m.json' });
  assert.equal(old.kind, 'manifest');
  assert.equal(old.url, 'https://old/m.json');

  const both = resolveUpdateSource(
    {},
    { WORKHUB_UPDATE_MANIFEST: 'https://new/m.json', MDHUB_UPDATE_MANIFEST: 'https://old/m.json' },
  );
  assert.equal(both.url, 'https://new/m.json');
});

test('从 Release 里认托盘包：只认 workhub-tray-*.zip', async () => {
  const fetchImpl = fakeFetch({
    'releases/latest': {
      tag_name: 'v0.3.0',
      body: '说明',
      assets: [
        { name: 'workhub-server-0.3.0.zip', browser_download_url: 'https://x/server.zip', size: 1 },
        { name: 'workhub-tray-0.3.0.zip', browser_download_url: 'https://x/tray.zip', size: 2 },
      ],
    },
  });
  const manifest = await fetchTrayManifest(
    { kind: 'github', url: 'https://api/releases/latest' },
    fetchImpl,
  );
  assert.equal(manifest.version, '0.3.0');
  assert.equal(manifest.url, 'https://x/tray.zip');
  assert.equal(manifest.notes, '说明');
});

test('从 Release 里认托盘包：没有托盘包就报错（别装没看见）', async () => {
  const fetchImpl = fakeFetch({
    'releases/latest': {
      tag_name: 'v0.3.0',
      assets: [{ name: 'workhub-server-0.3.0.zip', browser_download_url: 'https://x/server.zip' }],
    },
  });
  await assert.rejects(
    () => fetchTrayManifest({ kind: 'github', url: 'https://api/releases/latest' }, fetchImpl),
    /没有 workhub-tray-.*\.zip/,
  );
});

test('清单源：直接读出版本与下载地址', async () => {
  const fetchImpl = fakeFetch({
    'manifest.json': { version: '0.4.0', url: 'https://x/tray.zip', sha256: 'abc' },
  });
  const manifest = await fetchTrayManifest(
    { kind: 'manifest', url: 'https://x/manifest.json' },
    fetchImpl,
  );
  assert.equal(manifest.version, '0.4.0');
  assert.equal(manifest.sha256, 'abc');
});

test('查更新：没有新版本 / 有新版本 / 查不到，三种结果分得开', async () => {
  const same = await checkTrayUpdate({
    currentVersion: '0.3.0',
    source: { kind: 'github', url: 'https://api/releases/latest' },
    fetchImpl: fakeFetch({
      'releases/latest': {
        tag_name: 'v0.3.0',
        assets: [{ name: 'workhub-tray-0.3.0.zip', browser_download_url: 'https://x/tray.zip' }],
      },
    }),
  });
  assert.equal(same.updateAvailable, false);
  assert.equal(same.error, null);

  const newer = await checkTrayUpdate({
    currentVersion: '0.3.0',
    source: { kind: 'github', url: 'https://api/releases/latest' },
    fetchImpl: fakeFetch({
      'releases/latest': {
        tag_name: 'v0.4.0',
        assets: [{ name: 'workhub-tray-0.4.0.zip', browser_download_url: 'https://x/tray.zip' }],
      },
    }),
  });
  assert.equal(newer.updateAvailable, true);
  assert.equal(newer.latest.version, '0.4.0');

  const broken = await checkTrayUpdate({
    currentVersion: '0.3.0',
    source: { kind: 'github', url: 'https://api/releases/latest' },
    fetchImpl: async () => ({ ok: false, status: 500 }),
  });
  assert.equal(broken.updateAvailable, false);
  assert.match(broken.error, /500/);
});

test('找程序根：解压出来直接是 exe，或多套一层目录', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'workhub-app-root-'));
  try {
    // 形态一：解压出来就是程序目录
    const flat = path.join(base, 'flat');
    fs.mkdirSync(path.join(flat, 'resources'), { recursive: true });
    fs.writeFileSync(path.join(flat, 'resources', 'app.asar'), 'x');
    assert.equal(locateAppRoot(flat), flat);

    // 形态二：外面多套一层
    const nested = path.join(base, 'nested');
    const inner = path.join(nested, 'WorkHub');
    fs.mkdirSync(path.join(inner, 'resources'), { recursive: true });
    fs.writeFileSync(path.join(inner, 'resources', 'app.asar'), 'x');
    assert.equal(locateAppRoot(nested), inner);

    // 认不出来就别乱动：原样返回
    const unknown = path.join(base, 'unknown');
    fs.mkdirSync(unknown, { recursive: true });
    assert.equal(locateAppRoot(unknown), unknown);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('更新器运行时：把托盘旁边的运行时文件复制一份出去用', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'workhub-updater-runtime-'));
  try {
    // 假装这就是装好的托盘目录
    const appDir = path.join(base, 'app');
    fs.mkdirSync(path.join(appDir, 'resources'), { recursive: true });
    fs.writeFileSync(path.join(appDir, 'WorkHub.exe'), 'exe');
    fs.writeFileSync(path.join(appDir, 'icudtl.dat'), 'icu');
    fs.writeFileSync(path.join(appDir, 'v8_context_snapshot.bin'), 'snapshot');
    fs.writeFileSync(path.join(appDir, 'resources', 'app.asar'), 'asar');

    const staging = path.join(base, 'staging');
    fs.mkdirSync(staging, { recursive: true });
    const { updaterExe, updaterDir } = prepareUpdaterRuntime(
      staging,
      appDir,
      path.join(appDir, 'WorkHub.exe'),
    );

    // 更新器得能在托盘目录之外跑起来
    assert.equal(path.dirname(updaterExe), updaterDir);
    assert.notEqual(path.dirname(updaterExe), appDir);
    assert.ok(fs.existsSync(updaterExe));
    // 运行时文件得一起复制过去：少一个（ICU 数据）那个 exe 就起不来
    assert.ok(fs.existsSync(path.join(updaterDir, 'icudtl.dat')));
    assert.ok(fs.existsSync(path.join(updaterDir, 'v8_context_snapshot.bin')));
    // 目录不复制：asar 有几百 MB，node 模式也读不了它
    assert.ok(!fs.existsSync(path.join(updaterDir, 'resources')));
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('更新器运行时：托盘程序没复制成功就报错（别默默更新失败）', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'workhub-updater-runtime-bad-'));
  try {
    const appDir = path.join(base, 'app');
    fs.mkdirSync(appDir, { recursive: true });
    const staging = path.join(base, 'staging');
    assert.throws(
      () => prepareUpdaterRuntime(staging, appDir, path.join(appDir, 'WorkHub.exe')),
      /复制更新器运行时失败/,
    );
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('校验：哈希对得上放行，对不上拦下', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workhub-sha-'));
  try {
    const file = path.join(dir, 'a.bin');
    fs.writeFileSync(file, 'hello');
    const hash = await sha256File(file);
    await verifyChecksum(file, hash); // 对得上，不抛
    await assert.rejects(() => verifyChecksum(file, 'deadbeef'), /校验失败/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
