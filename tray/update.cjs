'use strict';
/**
 * 托盘自更新：查新版本 → 下载 → 校验 → 解包 → 起更新器。
 *
 * 跟服务端升级（server/updater.ts）是同一套思路，原料也一样：
 * **发布时打好的那个 tag 压缩包**。发布页上的资产名必须是
 * `workhub-tray-<版本>.zip`，更新器按这个名字找包——名字对不上就等于没发，
 * 而且使用者那边看不出任何异常：界面只说「没有新版本」，因为压根没找到包。
 *
 * 为什么托盘要自己会升级：
 * 托盘是使用者机器上唯一常驻的东西。服务端的升级由服务自己管（有网页、有接口），
 * 可托盘没有网页——它只有一个托盘图标。真把托盘做成一锤子买卖，
 * 就等于每次升级都要使用者重新下载安装包，那不叫自动更新。
 *
 * 为什么「下载完解压」不算完事：
 * Windows 上运行中的程序换不掉（WorkHub.exe 被占着，app.asar 也被锁着）。
 * 要换就得先让托盘退出，而「退出之后继续把活干完」只能由独立于托盘的进程来做——
 * 所以最后一步是起一个外部更新器（tray/apply-update.cjs），它等托盘退干净了再覆盖。
 *
 * 这一层只做「纯逻辑 + 下载解包」，不碰正在运行的代码：
 * 出问题也只是白下一次，托盘照常在跑。
 */
const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const { createWriteStream, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } = require('node:fs');
const { readFile } = require('node:fs/promises');
const { dirname, join } = require('node:path');
const { tmpdir } = require('node:os');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

/** 托盘升级包的资产名。发布时必须对上这个名字。 */
const ASSET_PATTERN = /^workhub-tray-.*\.zip$/i;
/** 默认的发布仓库 */
const DEFAULT_REPO = 'PAY7UN/WORKHUB';

/**
 * 比较两个版本号。
 *
 * 只认 x.y.z 的数字部分（前面可能有 v），预发布标记一律忽略——
 * 这是内部工具，「0.2.0-beta」和「0.2.0」在我们这儿没有区别。
 *
 * 跟 server/updater.ts 的 compareVersions 是同一套规则：两边判出来的
 * 「有没有新版本」必须一致，否则会出现「网页说该升级、托盘说已是最新」这种
 * 让人不知道该信谁的局面。
 */
function compareVersions(a, b) {
  const parse = (v) =>
    String(v)
      .trim()
      .replace(/^v/i, '')
      .split('-')[0]
      .split('.')
      .map((part) => {
        const n = Number.parseInt(part, 10);
        return Number.isFinite(n) ? n : 0;
      });
  const pa = parse(a);
  const pb = parse(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i += 1) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  return 0;
}

/**
 * 决定更新源。
 *
 * 优先级：自定义清单 > 自定义包直链 > GitHub Releases。
 * 有自定义源就一定用它——内网部署拿不到 GitHub，硬走 GitHub 只会一直失败。
 *
 * 配置来自托盘配置文件（tray.config.json 的 update 段），也可用环境变量覆盖。
 */
function resolveUpdateSource(config = {}, env = process.env) {
  const token = (env.WORKHUB_UPDATE_TOKEN ?? '').trim() || undefined;
  const update = config.update ?? {};
  const manifest = (update.manifest ?? env.MDHUB_UPDATE_MANIFEST ?? '').trim();
  if (manifest) return { kind: 'manifest', url: manifest, token };
  const direct = (update.url ?? env.MDHUB_UPDATE_URL ?? '').trim();
  if (direct) return { kind: 'url', url: direct, token };
  const repo = (update.repo ?? env.MDHUB_UPDATE_REPO ?? DEFAULT_REPO).trim();
  return { kind: 'github', url: `https://api.github.com/repos/${repo}/releases/latest`, token };
}

function authHeaders(token) {
  const headers = {
    'user-agent': 'workhub-tray-updater',
    accept: 'application/vnd.github+json',
  };
  if (token) headers.authorization = `Bearer ${token}`;
  return headers;
}

/**
 * 拿更新清单。
 *
 * 清单的形状跟服务端那份一样：{ version, url, sha256, size, notes }。
 * url 源没法在下载前知道版本（版本在包里），返回 null 让调用方下载完再从包里读。
 */
async function fetchTrayManifest(source, fetchImpl = fetch) {
  if (source.kind === 'url') return null;

  if (source.kind === 'manifest') {
    const response = await fetchImpl(source.url, { headers: authHeaders(source.token) });
    if (!response.ok) throw new Error(`取更新清单失败：HTTP ${response.status}`);
    const data = await response.json();
    if (!data.url) throw new Error('更新清单里没有下载地址');
    return {
      version: String(data.version ?? ''),
      url: data.url,
      sha256: data.sha256,
      size: data.size,
      notes: data.notes,
    };
  }

  // GitHub Releases：找名字对得上的资产
  const response = await fetchImpl(source.url, { headers: authHeaders(source.token) });
  if (!response.ok) {
    if (response.status === 404) {
      throw new Error('GitHub 上还没有发布 Release（先发一个 Release 才能自动更新）');
    }
    throw new Error(`取 Release 信息失败：HTTP ${response.status}`);
  }
  const release = await response.json();
  const assets = release.assets ?? [];
  const zip = assets.find((asset) => ASSET_PATTERN.test(asset.name));
  if (!zip) {
    throw new Error('这个 Release 里没有 workhub-tray-*.zip 产物');
  }
  const checksum = assets.find((asset) => asset.name === `${zip.name}.sha256`);
  let sha256;
  if (checksum) {
    const checksumResponse = await fetchImpl(checksum.browser_download_url, {
      headers: authHeaders(source.token),
    });
    if (checksumResponse.ok) {
      // 校验文件常见两种写法：「<哈希>  <文件名>」或就一个哈希
      sha256 = (await checksumResponse.text()).trim().split(/\s+/)[0]?.toLowerCase();
    }
  }
  return {
    version: String(release.tag_name ?? '').replace(/^v/i, ''),
    url: zip.browser_download_url,
    sha256,
    size: zip.size,
    notes: release.body,
  };
}

/** 下载文件到本地 */
async function downloadFile(url, dest, options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(url, { headers: authHeaders(options.token) });
  if (!response.ok) throw new Error(`下载失败：HTTP ${response.status}`);
  const body = response.body;
  if (!body) throw new Error('下载失败：响应没有内容');
  mkdirSync(join(dest, '..'), { recursive: true });
  await pipeline(Readable.fromWeb(body), createWriteStream(dest));
}

/** 算文件的 sha256 */
async function sha256File(path) {
  const hash = createHash('sha256');
  hash.update(await readFile(path));
  return hash.digest('hex');
}

/** 校验下载的东西没被篡改 / 传错 */
async function verifyChecksum(path, expected) {
  if (!expected) return; // 没有校验值就放过：内网自建源常常不提供
  const actual = await sha256File(path);
  if (actual.toLowerCase() !== expected.toLowerCase()) {
    throw new Error(`校验失败：期望 ${expected}，实际 ${actual}`);
  }
}

/**
 * 解压 zip。
 *
 * Windows 用 PowerShell 自带的 Expand-Archive（系统一定有）；
 * 其他系统用 unzip。都没有就说清楚缺什么，别抛个看不懂的错。
 */
async function extractZip(zipPath, destDir) {
  mkdirSync(destDir, { recursive: true });
  if (process.platform === 'win32') {
    await run('powershell', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${destDir}' -Force`,
    ]);
    return;
  }
  await run('unzip', ['-q', '-o', zipPath, '-d', destDir]);
}

/** 跑一个外部命令，失败就抛错（带上 stderr） */
function run(command, args) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', (err) => rejectPromise(new Error(`${command} 启动失败：${err.message}`)));
    child.on('close', (code) => {
      if (code === 0) resolvePromise(stdout);
      else rejectPromise(new Error(`${command} 退出码 ${code}：${stderr.trim() || stdout.trim()}`));
    });
  });
}

/**
 * 在解出来的目录里找真正的程序根。
 *
 * 压缩包可能是两种形态：
 * - 解压出来直接就是 WorkHub.exe（我们打的就是这种，解压即用）
 * - 里面多套一层目录（有些压缩工具会这么打）
 *
 * 两种都得认，认错了会把文件铺到错的地方——铺错的后果是托盘起不来。
 */
function locateAppRoot(dir) {
  if (existsSync(join(dir, 'resources', 'app.asar')) || existsSync(join(dir, 'WorkHub.exe'))) {
    return dir;
  }
  let entries = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  } catch {
    return dir;
  }
  for (const entry of entries) {
    const candidate = join(dir, entry.name);
    if (existsSync(join(candidate, 'resources', 'app.asar'))) return candidate;
  }
  return dir;
}

/**
 * 读程序根里的版本号。
 *
 * 打包后 package.json 在 app.asar 里（Electron 会把 asar 当成目录读），
 * 开发态则直接在根上。两个都试，试不到就返回 null。
 */
function readAppVersion(appRoot) {
  const candidates = [
    join(appRoot, 'package.json'),
    join(appRoot, 'resources', 'app.asar', 'package.json'),
  ];
  for (const candidate of candidates) {
    try {
      const pkg = JSON.parse(readFileSync(candidate, 'utf8'));
      if (pkg.version) return String(pkg.version);
    } catch {
      // 不是 JSON 或者读不了（纯 Node 环境读 asar 就是读不了）——换下一个
    }
  }
  return null;
}

/** 清掉暂存目录 */
function cleanupStaging(dir) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // 删不掉就算了：那是 %TEMP% 里的东西，系统自己会清
  }
}

/**
 * 把新版本准备好：下载 → 校验 → 解包。
 *
 * 这一步全程不动正在运行的托盘——出问题也只是白下一次，托盘照常在跑。
 */
async function prepareTrayUpdate(options) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const manifest = options.manifest ?? (await fetchTrayManifest(options.source, fetchImpl));

  const stagingDir = join(tmpdir(), `workhub-tray-update-${Date.now()}`);
  const payloadDir = join(stagingDir, 'payload');
  mkdirSync(stagingDir, { recursive: true });

  const zipPath = join(stagingDir, 'artifact.zip');
  const url = manifest?.url ?? options.source.url;
  await downloadFile(url, zipPath, { token: options.source.token, fetchImpl });
  await verifyChecksum(zipPath, manifest?.sha256);
  await extractZip(zipPath, payloadDir);

  const appRoot = locateAppRoot(payloadDir);
  return { manifest, stagingDir, payloadDir: appRoot, version: manifest?.version ?? '' };
}

/**
 * 查托盘自己的新版本。
 *
 * 查不到不算失败——没网、GitHub 限流、压根没发 Release，这些都会发生。
 * 所以 error 是一个字段而不是异常：调用方（菜单）要能区分「没有新版本」
 * 和「查不到」，这两种在界面上该说的话不一样。
 */
async function checkTrayUpdate(options = {}) {
  const currentVersion = options.currentVersion ?? '0.0.0';
  const source = options.source ?? resolveUpdateSource(options.config ?? {});
  let latest = null;
  let error = null;
  try {
    const manifest = await fetchTrayManifest(source, options.fetchImpl);
    if (manifest) {
      latest = {
        version: manifest.version,
        notes: manifest.notes ?? '',
        size: manifest.size ?? null,
        updateAvailable: compareVersions(manifest.version, currentVersion) > 0,
      };
    }
  } catch (err) {
    error = err?.message ?? String(err);
  }
  return {
    currentVersion,
    source: { kind: source.kind, url: source.url },
    latest,
    updateAvailable: latest?.updateAvailable ?? false,
    error,
  };
}

/* --------------------------- 起更新器（替换文件） --------------------------- */

/**
 * 准备更新器要用的可执行文件。
 *
 * 更新器必须跑在**托盘目录之外**：
 * 它自己就站在被替换的目录里，一跑起来就把那个目录里的文件锁住了，
 * 覆盖自己就变成了不可能。
 *
 * 所以先把 payload 自带的 node.exe 复制一份到临时目录再用。
 * 不用托盘自己的 exe，是因为 Electron 的 exe 旁边还散着一堆运行时文件
 * （快照、ICU 数据、各类 dll），单独复制一个 exe 是跑不起来的；
 * 而纯 node.exe 复制过去就能跑，还顺带避免了「更新器锁住自己的 exe」。
 */
function prepareUpdaterRuntime(stagingDir, nodeExePath) {
  if (!nodeExePath || !existsSync(nodeExePath)) {
    throw new Error('这个安装包里没有自带 Node 运行时，自动更新用不了');
  }
  const updaterDir = join(stagingDir, 'updater');
  mkdirSync(updaterDir, { recursive: true });
  const dest = join(updaterDir, 'node.exe');
  copyFileSync(nodeExePath, dest);
  // 官方包里 node.exe 依赖 node.dll，缺了会起不来
  const dll = join(dirname(nodeExePath), 'node.dll');
  if (existsSync(dll)) copyFileSync(dll, join(updaterDir, 'node.dll'));
  return dest;
}

/**
 * 下载新版本、解包，然后起外部更新器接管剩下的活。
 *
 * 这一步返回后，**托盘必须退出**：更新器要等托盘真的退出才能动文件。
 * 托盘退出、更新器替换文件、更新器再把托盘拉起来——中间这段使用者会看到
 * 托盘图标消失几十秒，这是 Windows 上换程序目录的固有代价。
 */
async function applyTrayUpdate(options) {
  const {
    appDir,
    execPath,
    execArgs = [],
    scriptPath,
    nodeExePath,
    logPath,
    currentVersion = '0.0.0',
    config = {},
    source,
    fetchImpl,
  } = options;

  if (!appDir || !execPath || !scriptPath) {
    throw new Error('缺少更新所需的应用路径信息');
  }

  const prepared = await prepareTrayUpdate({
    source: source ?? resolveUpdateSource(config),
    manifest: options.manifest,
    fetchImpl,
  });

  // 包里的版本不比当前新 → 不折腾
  const newVersion = prepared.version || readAppVersion(prepared.payloadDir) || '';
  if (newVersion && compareVersions(newVersion, currentVersion) <= 0) {
    cleanupStaging(prepared.stagingDir);
    throw new Error(`已经是最新版本了（${currentVersion}）`);
  }

  const updaterExe = prepareUpdaterRuntime(prepared.stagingDir, nodeExePath);

  const updaterArgs = [
    scriptPath,
    '--root',
    appDir,
    '--staging',
    prepared.stagingDir,
    '--payload',
    prepared.payloadDir,
    '--version',
    newVersion || 'unknown',
    '--pid',
    String(process.pid),
    '--log',
    logPath,
    '--exec',
    execPath,
    ...execArgs.flatMap((arg) => ['--exec-arg', String(arg)]),
  ];

  // 环境变量要「删掉」而不是「置空」：置空的话下游看到的还是一个
  // 设过的空字符串，「有没有被托管」这类判断就说不清了。
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.WORKHUB_PARENT_PID;

  const child = spawn(updaterExe, updaterArgs, {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    // 工作目录放在临时目录：更新器要删改托盘目录里的文件，
    // 而 Windows 上「当前工作目录里的东西」是删不干净的（cwd 本身删不掉）。
    cwd: tmpdir(),
    env,
  });
  child.unref();

  return {
    ok: true,
    version: newVersion,
    stagingDir: prepared.stagingDir,
    updaterPid: child.pid,
  };
}

module.exports = {
  ASSET_PATTERN,
  DEFAULT_REPO,
  applyTrayUpdate,
  checkTrayUpdate,
  cleanupStaging,
  compareVersions,
  downloadFile,
  extractZip,
  fetchTrayManifest,
  locateAppRoot,
  prepareTrayUpdate,
  readAppVersion,
  resolveUpdateSource,
  sha256File,
  verifyChecksum,
};
