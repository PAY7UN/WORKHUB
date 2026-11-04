/**
 * 自动升级：查新版本 → 下载 → 校验 → 停服 → 换代码 → 起回来。
 *
 * 为什么拆成这么多函数：
 * 升级是「错了就把服务搞挂」的那类操作，能纯逻辑的部分就纯逻辑——
 * 版本比较、更新源解析、清单解析、托管方式判断都是纯函数，可以直接测；
 * 真正碰磁盘和网络的只有下载、解包、起进程那几个。
 *
 * 为什么要有外部更新器（scripts/upgrade-apply.mjs）：
 * Windows 上运行中的代码换不掉——node.exe 被占着，better-sqlite3 的 .node
 * 更是被 mmap 锁着。要换代码就必须先让服务进程退出，而「让服务退出之后
 * 继续把活干完」这件事，只能由一个独立于服务进程的进程来做。
 *
 * 目录约定：
 * - <appDir>/.upgrade-in-progress   升级进行中的标记文件（宿主看门狗据此不抢着拉起）
 * - <appDir>/logs/upgrade.log      升级过程日志
 * - <appDir>/logs/.last-upgrade.json 上次升级的结果摘要（给前端显示）
 * - %TEMP%/workhub-upgrade-*        暂存：下载的包、解包出来的内容
 */
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { logger, displayPath } from './logger.ts';
import { APP_ROOT } from './paths.ts';
import { currentVersion, planRestartFallback } from './host.ts';

/** 代码目录：server/ 的上一级 */
export function appRoot(): string {
  return APP_ROOT;
}

/** 升级标记文件：宿主看门狗看到这个就明白「别急着拉我」 */
export function upgradeFlagPath(root = appRoot()): string {
  return join(root, '.upgrade-in-progress');
}

/**
 * 写升级标记。
 *
 * 必须在服务退出**之前**写好：Windows 服务宿主（以及托盘）看到子进程没了
 * 就会急着把它拉起来，那时候代码还没换完，它拉起来的还是旧代码——
 * 于是新代码刚放好，端口又被旧代码占住，升级就卡在这儿了。
 *
 * 标记里带上版本和开始时间，纯粹是为了排查时能看出「卡在哪个版本」。
 */
export function writeUpgradeFlag(
  info: { version: string; startedAt: number },
  root = appRoot(),
): void {
  try {
    writeFileSync(
      upgradeFlagPath(root),
      JSON.stringify({ version: info.version, startedAt: info.startedAt, pid: process.pid }, null, 2),
      'utf8',
    );
  } catch (err) {
    logger.warn(`写升级标记失败：${(err as Error).message}`);
  }
}

/** 升级标记还在不在 */
export function upgradeInProgress(root = appRoot()): boolean {
  return existsSync(upgradeFlagPath(root));
}

/** 上次升级的结果摘要 */
export function lastUpgradePath(root = appRoot()): string {
  return join(root, 'logs', '.last-upgrade.json');
}

/**
 * 当前版本：读 package.json。
 *
 * 实现搬到 host.ts 了——manage.ts 的状态接口也要读版本，两边各写一份的话，
 * 迟早会有一边漏掉「读不到就报 unknown」这条。这里转出去，
 * 已经引用 updater.ts 的地方不用改。
 */
export { currentVersion };

/**
 * 比较两个版本号。
 *
 * 只认 x.y.z 的数字部分（前面可能有 v），后面的预发布标记一律忽略——
 * 这是内部工具，「0.2.0-beta」和「0.2.0」在我们这儿没有区别，
 * 硬要按 semver 那一套来判，反而容易在边界上判错。
 *
 * 返回 -1 / 0 / 1。
 */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string): number[] =>
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

export type UpdateSourceKind = 'github' | 'manifest' | 'url';

export interface UpdateSource {
  kind: UpdateSourceKind;
  /** github: releases/latest 的 API；manifest / url: 清单或包的直链 */
  url: string;
  /** GitHub token：私有仓库或撞限流时要用 */
  token?: string;
}

/**
 * 决定更新源。
 *
 * 优先级：自定义清单 > 自定义包直链 > GitHub Releases。
 * 有自定义源就一定用它——内网部署拿不到 GitHub，硬走 GitHub 只会一直失败。
 */
export function resolveUpdateSource(env: NodeJS.ProcessEnv = process.env): UpdateSource {
  const token = (env.MDHUB_UPDATE_TOKEN ?? '').trim() || undefined;
  const manifest = (env.MDHUB_UPDATE_MANIFEST ?? '').trim();
  if (manifest) return { kind: 'manifest', url: manifest, token };
  const direct = (env.MDHUB_UPDATE_URL ?? '').trim();
  if (direct) return { kind: 'url', url: direct, token };
  const repo = (env.MDHUB_UPDATE_REPO ?? 'PAY7UN/WORKHUB').trim();
  return { kind: 'github', url: `https://api.github.com/repos/${repo}/releases/latest`, token };
}

export interface UpdateManifest {
  version: string;
  url: string;
  sha256?: string;
  size?: number;
  notes?: string;
  publishedAt?: string;
}

interface GithubAsset {
  name: string;
  browser_download_url: string;
  size?: number;
}

interface GithubRelease {
  tag_name?: string;
  body?: string;
  published_at?: string;
  assets?: GithubAsset[];
}

function authHeaders(token?: string): Record<string, string> {
  const headers: Record<string, string> = {
    'user-agent': 'workhub-updater',
    accept: 'application/vnd.github+json',
  };
  if (token) headers.authorization = `Bearer ${token}`;
  return headers;
}

/**
 * 拿更新清单。
 *
 * url 源没法在下载前知道版本（版本在包里），返回 null 让调用方
 * 下载完再从包里读。
 */
export async function fetchManifest(
  source: UpdateSource,
  fetchImpl: typeof fetch = fetch,
): Promise<UpdateManifest | null> {
  if (source.kind === 'url') return null;

  if (source.kind === 'manifest') {
    const response = await fetchImpl(source.url, { headers: authHeaders(source.token) });
    if (!response.ok) throw new Error(`取更新清单失败：HTTP ${response.status}`);
    const data = (await response.json()) as Partial<UpdateManifest>;
    if (!data.url) throw new Error('更新清单里没有下载地址');
    return {
      version: String(data.version ?? ''),
      url: data.url,
      sha256: data.sha256,
      size: data.size,
      notes: data.notes,
      publishedAt: data.publishedAt,
    };
  }

  // GitHub Releases：找名字对得上的资产
  const response = await fetchImpl(source.url, { headers: authHeaders(source.token) });
  if (!response.ok) {
    if (response.status === 404) {
      throw new Error('GitHub 上还没有发布 Release（先发一个 Release 才能自动升级）');
    }
    throw new Error(`取 Release 信息失败：HTTP ${response.status}`);
  }
  const release = (await response.json()) as GithubRelease;
  const assets = release.assets ?? [];
  const zip = assets.find((asset) => /^workhub-server-.*\.zip$/i.test(asset.name));
  if (!zip) {
    throw new Error('这个 Release 里没有 workhub-server-*.zip 产物');
  }
  const checksum = assets.find((asset) => asset.name === `${zip.name}.sha256`);
  let sha256: string | undefined;
  if (checksum) {
    const checksumResponse = await fetchImpl(checksum.browser_download_url, { headers: authHeaders(source.token) });
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
    publishedAt: release.published_at,
  };
}

/** 算文件的 sha256 */
export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  hash.update(await readFile(path));
  return hash.digest('hex');
}

/** 下载文件到本地 */
export async function downloadFile(
  url: string,
  dest: string,
  options: { token?: string; fetchImpl?: typeof fetch } = {},
): Promise<void> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(url, { headers: authHeaders(options.token) });
  if (!response.ok) throw new Error(`下载失败：HTTP ${response.status}`);
  const body = response.body;
  if (!body) throw new Error('下载失败：响应没有内容');
  await pipeline(Readable.fromWeb(body as Parameters<typeof Readable.fromWeb>[0]), createWriteStream(dest));
}

/**
 * 解压 zip。
 *
 * Windows 用 PowerShell 自带的 Expand-Archive（系统一定有）；
 * 其他系统用 unzip。都没有就说清楚缺什么，别抛个看不懂的错。
 */
export async function extractZip(zipPath: string, destDir: string): Promise<void> {
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
function run(command: string, args: string[]): Promise<string> {
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

/** 校验下载的东西没被篡改 / 传错 */
export async function verifyChecksum(path: string, expected?: string): Promise<void> {
  if (!expected) return; // 没有校验值就放过：内网自建源常常不提供
  const actual = await sha256File(path);
  if (actual.toLowerCase() !== expected.toLowerCase()) {
    throw new Error(`校验失败：期望 ${expected}，实际 ${actual}`);
  }
}

/**
 * 谁来把升级后的服务拉起来。
 *
 * 这件事是升级能不能落地的关键：换完代码，服务得有人重新启动。
 * 认错了就会起两个进程抢同一个端口，或者一个都不起。
 */
export type RestartMode = 'host' | 'tray' | 'supervisor' | 'command' | 'self';

export interface UpgradeRestartPlan {
  mode: RestartMode;
  detail: string;
}

/**
 * 决定升级后谁来拉起服务。
 *
 * 顺序有讲究：
 * 1. host —— Windows 服务宿主（它有看门狗，会自己拉）
 * 2. tray —— 托盘（托盘盯着服务进程，死了会拉）
 * 3. command —— 运维自己指定的重启命令
 * 4. systemd / pm2 / docker —— 守护进程会拉
 * 5. 都没有 —— 裸跑，自己拉
 *
 * host 与 tray 排在 command 前面：它们是「已经在管着这个进程」的角色，
 * 换成命令去重启就变成两套人同时管，抢端口。
 */
export function planUpgradeRestart(env: NodeJS.ProcessEnv = process.env): UpgradeRestartPlan {
  if (env.WORKHUB_SERVICE_HOST) return { mode: 'host', detail: 'Windows 服务宿主（看门狗会拉起）' };
  if (env.WORKHUB_PARENT_PID) return { mode: 'tray', detail: '托盘（会拉起）' };
  // 后三档（命令 / 守护进程 / 自拉起）与重启接口共用一份判断，
  // 两边答案必须一致——不一致就是两套人同时管，或者没人管
  const fallback = planRestartFallback(env);
  return { mode: fallback.strategy, detail: fallback.detail };
}

/** 升级过程中的状态，写给前端看 */
export interface UpgradeRecord {
  version: string;
  from: string;
  status: 'downloading' | 'applying' | 'success' | 'failed' | 'rolled-back';
  startedAt: number;
  finishedAt?: number;
  message?: string;
}

export function writeUpgradeRecord(record: UpgradeRecord, root = appRoot()): void {
  try {
    mkdirSync(join(root, 'logs'), { recursive: true });
    writeFileSync(lastUpgradePath(root), JSON.stringify(record, null, 2), 'utf8');
  } catch {
    // 记不下来也不能影响升级本身
  }
}

export function readUpgradeRecord(root = appRoot()): UpgradeRecord | null {
  try {
    const raw = readFileSync(lastUpgradePath(root), 'utf8');
    return JSON.parse(raw) as UpgradeRecord;
  } catch {
    return null;
  }
}

/** 清掉暂存目录 */
export function cleanupStaging(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // 删不掉就算了：那是 %TEMP% 里的东西，系统自己会清
  }
}

/**
 * 在解出来的目录里找真正的包根。
 *
 * zip 里可能多套一层目录（打包时带了个顶层文件夹），
 * 也可能没有——两种都得认。
 */
export function locatePayloadRoot(payloadDir: string): string {
  const packageJson = join(payloadDir, 'package.json');
  if (existsSync(packageJson)) return payloadDir;
  for (const entry of readdirSync(payloadDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const candidate = join(payloadDir, entry.name);
    if (existsSync(join(candidate, 'package.json'))) return candidate;
  }
  return payloadDir;
}

/** 读包里的版本号 */
export function readPackageVersion(payloadRoot: string): string | null {
  try {
    const pkg = JSON.parse(readFileSync(join(payloadRoot, 'package.json'), 'utf8')) as { version?: string };
    return pkg.version ? String(pkg.version) : null;
  } catch {
    return null;
  }
}

export interface PreparedUpgrade {
  manifest: UpdateManifest | null;
  stagingDir: string;
  payloadDir: string;
  version: string;
}

/**
 * 把新版本准备好：下载 → 校验 → 解包 → 确认版本号对得上。
 *
 * 这一步全程不动正在运行的代码——出问题也只是白下一次，
 * 服务还在原地好好跑着。
 */
export async function prepareUpgrade(options: {
  source: UpdateSource;
  root?: string;
  manifest?: UpdateManifest | null;
  fetchImpl?: typeof fetch;
}): Promise<PreparedUpgrade> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const manifest = options.manifest ?? (await fetchManifest(options.source, fetchImpl));

  const stagingDir = join(tmpdir(), `workhub-upgrade-${Date.now()}`);
  const payloadDir = join(stagingDir, 'payload');
  mkdirSync(stagingDir, { recursive: true });

  const zipPath = join(stagingDir, 'artifact.zip');
  const url = manifest?.url ?? options.source.url;
  await downloadFile(url, zipPath, { token: options.source.token, fetchImpl });
  await verifyChecksum(zipPath, manifest?.sha256);
  await extractZip(zipPath, payloadDir);

  // 解出来可能多一层目录（zip 里带顶层文件夹），找一下真正的根
  const payloadRoot = locatePayloadRoot(payloadDir);
  const version = readPackageVersion(payloadRoot) ?? manifest?.version ?? '';
  if (!version) {
    cleanupStaging(stagingDir);
    throw new Error('更新包里读不到版本号（package.json 找不着）');
  }

  return { manifest, stagingDir, payloadDir: payloadRoot, version };
}

/**
 * 查更新的结果。
 *
 * 查不到不算失败——没网、GitHub 限流、压根没发 Release，这些都会发生。
 * 所以 error 是一个字段而不是 HTTP 错误码：调用方（托盘、前端）要能
 * 区分「没有新版本」和「查不到」，这两种在界面上该说的话不一样。
 */
export interface UpdateCheckResult {
  currentVersion: string;
  source: { kind: UpdateSourceKind; url: string };
  latest: {
    version: string;
    notes: string;
    publishedAt: string | null;
    size: number | null;
    updateAvailable: boolean;
  } | null;
  updateAvailable: boolean;
  lastUpgrade: UpgradeRecord | null;
  error: string | null;
}

export async function checkForUpdate(
  options: { root?: string; source?: UpdateSource; fetchImpl?: typeof fetch } = {},
): Promise<UpdateCheckResult> {
  const root = options.root ?? appRoot();
  const version = currentVersion(root);
  const source = options.source ?? resolveUpdateSource();
  let latest: UpdateCheckResult['latest'] = null;
  let error: string | null = null;
  try {
    const manifest = await fetchManifest(source, options.fetchImpl);
    if (manifest) {
      latest = {
        version: manifest.version,
        notes: manifest.notes ?? '',
        publishedAt: manifest.publishedAt ?? null,
        size: manifest.size ?? null,
        updateAvailable: compareVersions(manifest.version, version) > 0,
      };
    }
  } catch (err) {
    error = (err as Error).message;
  }
  return {
    currentVersion: version,
    source: { kind: source.kind, url: source.url },
    latest,
    updateAvailable: latest?.updateAvailable ?? false,
    lastUpgrade: readUpgradeRecord(root),
    error,
  };
}

export interface UpgradeStartResult {
  ok: boolean;
  /** 失败时的建议状态码 */
  status?: number;
  error?: string;
  version?: string;
  from?: string;
  detail?: string;
  message?: string;
}

/**
 * 执行升级。
 *
 * 顺序：查版本 → 下载校验解包（不动正在跑的代码）→ 起更新器 → 写标记 → 退出。
 * 更新器是独立进程，它会等服务真的退出才动代码；服务这边必须退出，
 * 因为 Windows 上换不掉正在运行的代码。
 *
 * onReady 用来在「更新器已经就位」之后把服务停掉——由调用方决定怎么停
 * （服务端走优雅停机，测试里直接退进程）。
 */
export async function startUpgrade(
  options: {
    root?: string;
    source?: UpdateSource;
    fetchImpl?: typeof fetch;
    onReady?: () => void;
  } = {},
): Promise<UpgradeStartResult> {
  const root = options.root ?? appRoot();
  if (upgradeInProgress(root)) {
    return { ok: false, status: 409, error: '已经有一次升级在进行中了' };
  }

  const version = currentVersion(root);
  const source = options.source ?? resolveUpdateSource();

  let manifest: UpdateManifest | null = null;
  try {
    manifest = await fetchManifest(source, options.fetchImpl);
  } catch (err) {
    return { ok: false, status: 502, error: `查不到新版本：${(err as Error).message}` };
  }
  if (manifest && manifest.version && compareVersions(manifest.version, version) <= 0) {
    return { ok: false, status: 409, error: `已经是最新版本了（当前 ${version}）` };
  }

  let prepared: PreparedUpgrade;
  try {
    prepared = await prepareUpgrade({ source, root, manifest, fetchImpl: options.fetchImpl });
  } catch (err) {
    return { ok: false, status: 500, error: `升级包准备失败：${(err as Error).message}` };
  }

  // 包里的版本不比当前新就别升：升了反而可能是降级
  if (prepared.version && compareVersions(prepared.version, version) <= 0) {
    cleanupStaging(prepared.stagingDir);
    return {
      ok: false,
      status: 409,
      error: `包里是 ${prepared.version}，不比当前的 ${version} 新，不升`,
    };
  }

  const plan = planUpgradeRestart();
  writeUpgradeRecord(
    { version: prepared.version, from: version, status: 'downloading', startedAt: Date.now() },
    root,
  );
  try {
    launchUpdater({
      root,
      stagingDir: prepared.stagingDir,
      payloadDir: prepared.payloadDir,
      version: prepared.version,
      plan,
    });
  } catch (err) {
    cleanupStaging(prepared.stagingDir);
    return { ok: false, status: 500, error: `更新器启动失败：${(err as Error).message}` };
  }

  // 标记要在服务退出前写好：宿主看到进程没了就急着拉，会拉起旧代码
  writeUpgradeFlag({ version: prepared.version, startedAt: Date.now() }, root);

  logger.notice(`开始升级到 ${prepared.version}，服务即将重启（${plan.detail}）`);
  if (options.onReady) options.onReady();
  return {
    ok: true,
    version: prepared.version,
    from: version,
    detail: plan.detail,
    message: '升级已启动，服务马上会重启，稍后刷新页面即可',
  };
}

/**
 * 启动外部更新器，然后让当前进程退场。
 *
 * 为什么必须先起更新器再退出：
 * 更新器要等服务进程真的没了才能动代码，所以它必须比服务活得久。
 * 顺序反了的话，服务一退出，更新器还没起来，代码就永远换不掉了。
 */
export function launchUpdater(options: {
  root?: string;
  stagingDir: string;
  payloadDir: string;
  version: string;
  plan: UpgradeRestartPlan;
}): { pid: number | undefined } {
  const root = options.root ?? appRoot();
  const script = join(root, 'scripts', 'upgrade-apply.mjs');
  if (!existsSync(script)) {
    throw new Error(`找不到更新器脚本：${displayPath(script)}`);
  }
  mkdirSync(join(root, 'logs'), { recursive: true });
  const logPath = join(root, 'logs', 'upgrade.log');

  const args = [
    script,
    '--root',
    root,
    '--staging',
    options.stagingDir,
    '--payload',
    options.payloadDir,
    '--version',
    options.version,
    '--restart-mode',
    options.plan.mode,
    '--restart-detail',
    options.plan.detail,
    '--pid',
    String(process.pid),
    '--log',
    logPath,
  ];

  const child = spawn(process.execPath, args, {
    // 完全脱离当前进程：服务退出不能带走它
    detached: true,
    // 输出不接管道：服务一退出，管道读端就没了，更新器再往里写会 EPIPE，
    // 一次没兜住的 EPIPE 就够把更新器打死——代码换了一半、健康检查没做、
    // 回滚也没做，服务卡在半死不活的状态。更新器自己写日志文件。
    stdio: ['ignore', 'ignore', 'ignore'],
    windowsHide: true,
  });
  child.unref();
  logger.notice(`升级更新器已启动（pid=${child.pid}），版本 ${options.version}`);
  return { pid: child.pid };
}
