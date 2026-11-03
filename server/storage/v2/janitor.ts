/**
 * 清道夫（worker 侧）：专门负责把暂存区里的文件真正删掉。
 *
 * 为什么非得另起一个线程：在这台 Windows 上删一个文件要一百多毫秒——杀软要
 * 逐个扫一遍才肯放手。几十个文件就是好几秒。这几秒如果发生在主线程上，
 * 事件循环就轮不到定时器和 socket：刚删完文件夹的那一下请求直接
 * ECONNRESET，用户看着就像「删了没反应」。
 *
 * worker 有自己的事件循环和线程池，删多久都伤不到主线程——主线程只管把
 * 待删的路径丢过来。
 *
 * 这个文件只在 worker 线程里跑；主线程那边是 vault.ts 里的同名牌。
 */
import { parentPort, workerData } from 'node:worker_threads';
import { readdir, rmdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';

const ROOT = typeof workerData?.root === 'string' ? workerData.root : '';
const SUFFIX = typeof workerData?.suffix === 'string' ? workerData.suffix : '.trash-';

/**
 * 删一个文件。
 *
 * 删不掉不算错：这个文件已经不在索引和数据库里了，没人会再指向它。
 * 留着就是占点地方，等下一轮再试。
 */
async function removeQuiet(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch {
    // 删不掉就留给下一轮
  }
}

/** 扫一遍目录树，把暂存文件清掉 */
async function sweep(dir: string): Promise<number> {
  let cleared = 0;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      cleared += await sweep(full);
      continue;
    }
    if (!entry.name.includes(SUFFIX)) continue;
    await removeQuiet(full);
    cleared += 1;
  }
  return cleared;
}

/**
 * 一批接一批地干，别让两批活儿叠在一起。
 *
 * 删文件本身就慢，并行并不会更快，只会让线程池更挤。
 */
let chain: Promise<void> = Promise.resolve();

/**
 * 收拾空目录。
 *
 * 文件删完之后，被删文件夹占的目录就空了。空壳留着等于在盘上摆着同名文件夹，
 * 界面上看着已经删干净了，盘上却还在。
 *
 * rmdir 只删空目录：里面还有东西就报错，那就留着——不硬来。
 * 深的先删：子目录没了，父目录才可能变空。
 */
async function pruneDirs(dirs: string[]): Promise<void> {
  const sorted = [...dirs].sort((a, b) => b.length - a.length);
  for (const dir of sorted) {
    try {
      await rmdir(dir);
    } catch {
      // 不空或者压根没有这个目录：留着即可
    }
  }
}

parentPort?.on('message', (msg: { type?: string; paths?: string[]; dirs?: string[] }) => {
  chain = chain.then(async () => {
    if (msg?.type === 'sweep') {
      const cleared = await sweep(ROOT);
      parentPort?.postMessage({ type: 'swept', cleared });
      return;
    }
    let done = 0;
    for (const p of msg?.paths ?? []) {
      await removeQuiet(p);
      done += 1;
    }
    await pruneDirs(msg?.dirs ?? []);
    parentPort?.postMessage({ type: 'purged', done });
  });
});
