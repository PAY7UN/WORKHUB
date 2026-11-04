/**
 * vault：文档正文的文件存储层。
 *
 * 为什么把正文从 SQLite 的 TEXT 列搬出来：
 *
 * 旧模型里一篇文档 = 数据库里一行，行里同时装着「名字、作者、时间」这类元数据
 * 和「正文」这类内容。带来三个具体麻烦：
 *   1. 改一个字要整篇重写 content 列，大文档每次保存都是全量 IO；
 *   2. 库里混着元数据与内容，备份、迁移、排查都得整库搬；
 *   3. 内容被锁死在数据库里——用户没法用任何外部工具打开它，
 *      也无法把它纳入自己的 git 仓库。
 *
 * 搬出来之后，「文件」成为位置的唯一真相，数据库退化成索引：
 * 查一篇文档 = 查索引拿路径 → 读文件。
 * 代价是多一次文件 IO，换来的是正文可被外部工具直接消费。
 *
 * 目录布局（没有回收站、没有历史，仓库就是唯一的存放单位）：
 *   vault/<repo-slug>/docs/<路径>.md      正文（明文）
 *   vault/<repo-slug>/docs/<路径>.md.enc  正文（加密，存的是密文字符串）
 *   vault/<repo-slug>/files/<路径>         原件（zip / 图片 / PDF / 代码…，保留原名）
 *   vault/<repo-slug>/assets/<路径>/<名>   附件
 */
import { createHash } from 'node:crypto';
import type { Dirent } from 'node:fs';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { logger } from '../../logger.ts';

const HERE = dirname(fileURLToPath(import.meta.url));

/** vault 根目录。与数据库同处 data/ 下，随 data/ 一起被 .gitignore 忽略 */
export const VAULT_ROOT = process.env.MDHUB_VAULT_DIR ?? resolve(HERE, '../../../data/vault');

/** 正文在文件里的扩展名 */
export const BODY_EXT = '.md';

export function ensureVaultDirs(): void {
  mkdirSync(VAULT_ROOT, { recursive: true });
}

/**
 * 把任意名字变成安全的目录名。
 *
 * 仓库目录名不能直接用仓库名：仓库名允许中文、空格、斜杠，
 * 而目录名要跨平台稳（Windows 不允许 \ / : * ? " < > |）。
 * 这里做的是「可读性优先」的归一化——保留中文与字母数字，
 * 非法字符换成短横线，再补一段 id 前缀防重名。
 */
export function slugify(name: string, id: string): string {
  const base =
    name
      .trim()
      .toLowerCase()
      .replace(/[\\/:*?"<>|]+/g, '-')
      .replace(/\s+/g, '-')
      .replace(/[^\p{L}\p{N}_-]+/gu, '')
      .replace(/-{2,}/g, '-')
      .replace(/^-+|-+$/g, '') || 'repo';
  return `${base}-${id.replace(/^r-/, '').slice(0, 8)}`;
}

/**
 * 把相对路径规整成「目录内相对路径」的形式。
 *
 * 返回 null 表示路径越界（含有 .. 或绝对路径）——这类路径一律拒绝，
 * 不能让调用方以为拼出来的路径是安全的。
 */
export function safeRelPath(raw: string): string | null {
  const norm = raw.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!norm) return null;
  const parts: string[] = [];
  for (const seg of norm.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') return null;
    // Windows 保留名与非法字符
    // eslint-disable-next-line no-control-regex
    if (/[<>:"/\\|?*\x00-\x1f]/.test(seg)) return null;
    parts.push(seg);
  }
  if (parts.length === 0) return null;
  // 单段文件名不允许以 . 结尾（Windows 会自动去掉，容易造成路径不一致）
  if (parts[parts.length - 1].endsWith('.')) return null;
  return parts.join('/');
}

/** 确认解析后的绝对路径确实落在 vault 根目录内 */
export function assertInsideVault(abs: string): string {
  const root = resolve(VAULT_ROOT);
  const target = resolve(abs);
  if (target !== root && !target.startsWith(root + sep)) {
    throw new Error(`路径越出 vault：${abs}`);
  }
  return target;
}

/**
 * 正文文件名。
 *
 * 节点名本身就可能带 .md（「常用设备命令.md」是从文件名原样带过来的），
 * 这时不能再补一个 .md，否则磁盘上会出现「常用设备命令.md.md」这种双后缀。
 */
export function bodyFileName(rel: string, encrypted: boolean): string {
  const base = /\.md$/i.test(rel) ? rel : `${rel}${BODY_EXT}`;
  return encrypted ? `${base}.enc` : base;
}

/** 仓库下的正文文件绝对路径 */
export function bodyPath(repoSlug: string, relPath: string, encrypted: boolean): string {
  const rel = safeRelPath(relPath);
  if (!rel) throw new Error(`非法路径：${relPath}`);
  return assertInsideVault(join(VAULT_ROOT, repoSlug, 'docs', bodyFileName(rel, encrypted)));
}

/** 附件的绝对路径 */
export function assetPath(repoSlug: string, relPath: string, fileName: string): string {
  const rel = safeRelPath(relPath);
  if (!rel) throw new Error(`非法路径：${relPath}`);
  const name = safeRelPath(fileName);
  if (!name) throw new Error(`非法文件名：${fileName}`);
  return assertInsideVault(join(VAULT_ROOT, repoSlug, 'assets', rel, name));
}

/**
 * 原件的绝对路径。
 *
 * 与正文分目录放：正文永远是 UTF-8 文本（`.md`），原件是任意字节。
 * 混在一个目录里的后果是「按后缀猜格式」这套假设会失效——
 * 一篇叫 `报告.md` 的原件和一篇 Markdown 笔记长得一模一样，
 * 却需要完全不同的读写方式（文本 vs 二进制、编码 vs 原样）。
 *
 * 路径里保留原文件名与扩展名：下载回来的东西就该叫它本来的名字，
 * 而不是被改成一串 id。
 */
export function filePath(repoSlug: string, relPath: string): string {
  const rel = safeRelPath(relPath);
  if (!rel) throw new Error(`非法路径：${relPath}`);
  return assertInsideVault(join(VAULT_ROOT, repoSlug, 'files', rel));
}

/**
 * 一个文件夹在盘上占的目录。
 *
 * 文件夹本身没有文件，只有它占着的目录：正文目录（docs）与原件目录（files）。
 * 删掉文件夹后这两个目录会空下来——留着它们等于在盘上留一堆空壳，
 * 界面上看着已经删干净了，盘上却还摆着同名文件夹。
 */
export function folderDirs(repoSlug: string, relPath: string): string[] {
  const rel = safeRelPath(relPath);
  if (!rel) return [];
  return [
    assertInsideVault(join(VAULT_ROOT, repoSlug, 'docs', rel)),
    assertInsideVault(join(VAULT_ROOT, repoSlug, 'files', rel)),
  ];
}

/**
 * 原子写文件。
 *
 * 先写临时文件再改名：改名在同一文件系统内是原子的，
 * 于是并发写同一个文件不会读到写了一半的内容。
 */
export function writeFileAtomic(abs: string, data: string | Buffer): void {
  const target = assertInsideVault(abs);
  mkdirSync(dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tmp, data);
    try {
      renameSync(tmp, target);
    } catch {
      rmSync(tmp, { force: true });
    }
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

/** 读文件；不存在返回 null */
export function readFileSafe(abs: string): string | null {
  try {
    return readFileSync(abs, 'utf8');
  } catch {
    return null;
  }
}

/** 内容哈希：用于变更检测与去重 */
export function contentHash(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/** 复制外部文件进 vault（迁移附件时用） */
export function copyIntoVault(from: string, to: string): void {
  const target = assertInsideVault(to);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(from, target);
}

/**
 * 删掉一个节点的正文文件。
 *
 * 没有回收站，删除就是删除：文件要么在，要么不在。
 * 文件不存在也算成功——幂等，重复删不会报错。
 */
export function removeBodyFile(repoSlug: string, relPath: string, encrypted: boolean): void {
  const target = bodyPath(repoSlug, relPath, encrypted);
  if (!existsSync(target)) return;
  try {
    unlinkSync(target);
  } catch {
    // 删不掉就交给上层报错：宁可让调用方知道，也不留半吊子状态
    throw new Error(`删除正文文件失败：${target}`);
  }
}

/** 暂存文件的标记后缀。改名进暂存区 = 文件已经离开正路，只等清掉 */
export const TRASH_SUFFIX = '.trash-';

/**
 * 把待删的文件挪进暂存区。
 *
 * 为什么先改名不直接删：Windows 上 unlink 一个文件要一百多毫秒——杀软要
 * 逐个扫一遍才肯放手；改个名只要零点几毫秒。先改名等于把文件从正路上
 * 摘掉：同名文档随后重建也不会被后台的删除误伤，剩下的清理由后台慢慢做。
 *
 * 挪不动就返回 null（多半是文件本来就不在），调用方自己决定要不要直接删。
 */
export function stashFile(abs: string): string | null {
  const target = assertInsideVault(abs);
  if (!existsSync(target)) return null;
  const stashed = `${target}${TRASH_SUFFIX}${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    renameSync(target, stashed);
    return stashed;
  } catch {
    return null;
  }
}

/**
 * 清道夫线程：真正把暂存文件删掉的地方。
 *
 * 懒启动：用到才建，省得服务一启动就多一个线程。
 */
let janitor: Worker | null = null;

function janitorWorker(): Worker | null {
  if (janitor) return janitor;
  try {
    const w = new Worker(new URL('./janitor.ts', import.meta.url), {
      workerData: { root: VAULT_ROOT, suffix: TRASH_SUFFIX },
    });
    w.on('error', (err) => {
      logger.warn('清道夫线程出错', err);
      janitor = null;
    });
    w.on('exit', () => {
      janitor = null;
    });
    // 清道夫不欠着进程：它没干完的活儿还在暂存区，下次启动会扫
    w.unref();
    janitor = w;
    return w;
  } catch (err) {
    logger.warn('清道夫线程起不来', err);
    return null;
  }
}

/**
 * 把待删的路径丢给清道夫。
 *
 * 不等它：删文件在 Windows 上要一百多毫秒一个（杀软逐个扫），几十个文件
 * 就是好几秒。等它等于让接口陪着一起打转。
 *
 * 也不能在主线程上直接删：那几个 unlink 排起队来会把事件循环饿死——定时器
 * 和 socket 都排不上队，接口看着就像死了。挪进 worker 就没这回事了。
 *
 * dirs 是删完文件后要顺带收拾的空目录（文件夹删掉后剩下的壳）。
 */
export function purgeStashed(stashed: string[], dirs: string[] = []): void {
  if (!stashed.length && !dirs.length) return;
  const w = janitorWorker();
  if (!w) return;
  try {
    w.postMessage({ type: 'paths', paths: stashed, dirs });
  } catch (err) {
    logger.warn('清道夫接活失败', err);
  }
}

/**
 * 让清道夫扫掉上次没清完的暂存文件。
 *
 * 后台删除是尽力而为的：进程被杀、机器断电都会留下 .trash 文件。它们已经
 * 不在索引和数据库里了，留着只是占地方——启动时顺手扫掉。
 *
 * 扫也在 worker 里做：这一步要是同步删几百个文件，服务要等好几秒才能起来
 * （杀软逐个扫），期间谁都连不上。
 */
export function sweepStashed(): void {
  const w = janitorWorker();
  if (!w) return;
  try {
    w.postMessage({ type: 'sweep' });
  } catch (err) {
    logger.warn('清道夫启动清扫失败', err);
  }
}

/**
 * 移动一个绝对路径上的文件。
 *
 * 源文件不存在就当无事发生：文件与索引行本来就可能不同步，
 * 移动失败不该阻断一次改名或搬家。
 */
export function moveFileAt(from: string, to: string): void {
  const src = assertInsideVault(from);
  const dest = assertInsideVault(to);
  if (src === dest) return;
  if (!existsSync(src)) return;
  mkdirSync(dirname(dest), { recursive: true });
  try {
    renameSync(src, dest);
  } catch {
    // 跨设备重命名会失败（EXDEV），退回「复制 + 删除」
    copyFileSync(src, dest);
    unlinkSync(src);
  }
  pruneEmptyDirs(dirname(src));
}

/**
 * 移动正文文件（改名、换父目录、跨仓库搬家时用）。
 *
 * 源与目标可以属于不同仓库：跨仓库搬家时文件要落到目标仓库的目录里。
 * 留在原仓库目录下就成了没人认领的孤儿文件——原仓库一删，文档就只剩空壳。
 *
 * 源文件不存在就当无事发生：文件与索引行本来就可能不同步，
 * 移动失败不该阻断一次改名。
 */
export function moveBodyFile(
  fromSlug: string,
  fromRel: string,
  toSlug: string,
  toRel: string,
  encrypted: boolean,
): void {
  const from = bodyPath(fromSlug, fromRel, encrypted);
  const to = bodyPath(toSlug, toRel, encrypted);
  if (from === to) return;
  if (!existsSync(from)) return;
  mkdirSync(dirname(to), { recursive: true });
  try {
    renameSync(from, to);
  } catch {
    // 跨设备重命名会失败（EXDEV），退回「复制 + 删除」
    copyFileSync(from, to);
    unlinkSync(from);
  }
  pruneEmptyDirs(dirname(from));
}

/**
 * 移动附件文件（宿主文档搬家时用）。
 *
 * 附件的位置里嵌着宿主的路径与仓库，所以宿主一搬家，
 * 附件的二进制也得跟着换地方。
 */
export function moveAssetFile(
  fromSlug: string,
  fromRel: string,
  toSlug: string,
  toRel: string,
  fileName: string,
): void {
  const from = assetPath(fromSlug, fromRel, fileName);
  const to = assetPath(toSlug, toRel, fileName);
  if (from === to || !existsSync(from)) return;
  mkdirSync(dirname(to), { recursive: true });
  try {
    renameSync(from, to);
  } catch {
    copyFileSync(from, to);
    unlinkSync(from);
  }
  pruneEmptyDirs(dirname(from));
}

/**
 * 删掉整个仓库目录。
 *
 * 仓库在磁盘上就是一个目录，删仓库就是删目录——比逐个文件删干净，
 * 也不会留下「文件删了但目录还在」的残骸。
 *
 * 删不干净就报错，不假装删掉了：上层靠这个返回值决定
 * 能不能把仓库行也删掉。目录还在就报失败，好过留下没人认领的孤儿文件。
 */
export function removeRepoDir(repoSlug: string): void {
  const dir = assertInsideVault(join(VAULT_ROOT, repoSlug));
  if (!existsSync(dir)) return;
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // 递归删有时会被占用或被系统拦下，退回逐个文件删
    removeTreeByHand(dir);
  }
  if (existsSync(dir)) {
    throw new Error(`仓库目录删不掉：${dir}`);
  }
}

/**
 * 递归删目录的兜底实现：先删文件，再从深往上删空目录。
 *
 * 递归删一次不成，不代表逐个删也不行——
 * 被占用的往往只是某一个文件，整块推倒反而更脆。
 */
function removeTreeByHand(dir: string): void {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // 目录已经不在了
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      removeTreeByHand(full);
      try {
        rmdirSync(full);
      } catch {
        // 留着就留着，末尾会检查目录还在不在
      }
    } else {
      try {
        unlinkSync(full);
      } catch {
        // 同上
      }
    }
  }
}

/**
 * 导入期间暂存旧仓库目录用的后缀。
 *
 * 带这个后缀的目录是「暂存区」：里面的内容当前没人认领，
 * 但也不能当垃圾随手扫掉——它可能是导入失败时唯一的一份原件。
 */
export const PARK_SUFFIX = '.import-old-';

/**
 * 把仓库目录挪到一边暂存起来，返回暂存目录名。
 *
 * 覆盖式导入要先把旧内容清掉，但「清掉」这一步本身会失败，
 * 而失败点如果落在「库已经清空、内容还没写进去」之间，
 * 整个资料库就没了：库里是空的，盘上也是空的，内容再也找不回来。
 *
 * 所以这里不删，只挪：改名是原子的，挪不动就说明有文件被占着，
 * 那就整个导入失败——宁可什么都不做，也不要落一个半拉子的状态。
 * 挪开的目录还在盘上，导入失败时能原样挪回来。
 *
 * 目录本来就不在时返回 null（那没什么可暂存的）。
 */
export function parkRepoDir(repoSlug: string): string | null {
  const dir = assertInsideVault(join(VAULT_ROOT, repoSlug));
  if (!existsSync(dir)) return null;
  const parked = `${repoSlug}${PARK_SUFFIX}${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    renameSync(dir, assertInsideVault(join(VAULT_ROOT, parked)));
  } catch (err) {
    throw new Error(`仓库目录挪不动：${dir}（${(err as Error).message}）`);
  }
  return parked;
}

/**
 * 把暂存的仓库目录挪回原位。
 *
 * 挪之前目标位置得是空的：那里可能已经躺着这次导入写了一半的新内容，
 * 留着它就等于让新内容盖住旧内容——那正是「库是新的、盘是旧的」的乱局。
 */
export function unparkRepoDir(parked: string, repoSlug: string): void {
  const src = assertInsideVault(join(VAULT_ROOT, parked));
  const dest = assertInsideVault(join(VAULT_ROOT, repoSlug));
  if (!existsSync(src)) return;
  try {
    renameSync(src, dest);
  } catch (err) {
    throw new Error(`仓库目录还原失败：${src}（${(err as Error).message}）`);
  }
}

/**
 * 清掉暂存的旧仓库目录（导入成功后的清场）。
 *
 * 只在导入确实成功之后才调：这时库里的内容已经是新的，
 * 暂存区里的那份是旧的，留着它只是占地方，还会让人误以为有两份资料。
 */
export function discardParkedRepoDir(parked: string): void {
  removeRepoDir(parked);
}

/**
 * 找出还留在盘上的暂存目录。
 *
 * 进程在导入中途被杀掉时，暂存区里的内容会留下来：那时库要么是旧的、
 * 要么是新的，只有对照库才知道哪一份才是该留的。
 * 所以这里只报不改——自动清掉有可能把仅剩的原件删了。
 */
export function parkedRepoDirs(): string[] {
  if (!existsSync(VAULT_ROOT)) return [];
  let entries: Dirent[];
  try {
    entries = readdirSync(VAULT_ROOT, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && e.name.includes(PARK_SUFFIX))
    .map((e) => e.name);
}

/**
 * 从最深往上删空目录。
 *
 * 文件搬走或删掉之后，原目录往往剩个空壳。留着它没坏处，
 * 但目录越堆越多时，「这个仓库有哪些内容」就说不清了。
 */
export function pruneEmptyDirs(dir: string): void {
  const root = resolve(VAULT_ROOT);
  let cur = resolve(dir);
  while (cur !== root && cur.startsWith(root + sep)) {
    try {
      rmdirSync(cur);
    } catch {
      return; // 非空，停下
    }
    cur = dirname(cur);
  }
}

/**
 * 清空 vault。
 *
 * vault 里的东西全是派生数据——每一份都能从数据库重建出来，
 * 所以「全量重建」时直接推倒重来，比小心翼翼地覆盖可靠得多
 * （覆盖式的迁移会留下上一轮的残骸，比如改了命名规则后的旧文件名）。
 *
 * 删除是逐层做的：先删文件，再从最深的目录往上删空目录。
 * 不用递归 rm —— 有些环境会把递归删除改写成「移到回收站」，
 * 一旦失败就是「删不掉旧 vault」，迁移直接卡死。
 */
export function cleanVault(): void {
  if (!existsSync(VAULT_ROOT)) {
    ensureVaultDirs();
    return;
  }
  const entries = readdirSync(VAULT_ROOT, { recursive: true, withFileTypes: true }) as Array<
    Dirent & { parentPath?: string; path?: string }
  >;
  for (const e of entries) {
    if (!e.isFile()) continue;
    try {
      unlinkSync(join(e.parentPath ?? e.path ?? '', e.name));
    } catch {
      // 删不掉就留着：下一轮迁移会再试一次
    }
  }
  const dirs = entries
    .filter((e) => e.isDirectory())
    .map((e) => join(e.parentPath ?? e.path ?? '', e.name))
    // 路径长的先删：从最深的目录往上，一层层空掉
    .sort((a, b) => b.length - a.length);
  for (const d of dirs) {
    try {
      rmdirSync(d);
    } catch {
      // 空目录删除失败就再试一次递归删；
      // 两者都失败就留着——它不占内容位，只是目录层级而已
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        // 保留
      }
    }
  }
  ensureVaultDirs();
}
