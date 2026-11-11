// 打包用的三件小工具：把目录打成 zip、读 zip、给 zip 写校验值。
//
// 为什么单独放一个 lib：服务端升级包和托盘免安装包都要「打 zip + 写 sha256」，
// 两边各写一份的话，改一次压缩方式要记得改两处——这种「记得」迟早会忘。
//
// 产物名（workhub-server-<版本>.zip / workhub-tray-<版本>.zip）是自动升级的约定：
// 更新器按这个名字找包，名字对不上就等于没发，而且使用者那边看不出任何异常。
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import {
  createReadStream,
  createWriteStream,
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  writeFileSync,
} from 'node:fs';
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { basename, join } from 'node:path';
import { deflateRaw, inflateRawSync } from 'node:zlib';
import { promisify } from 'node:util';

/** zlib 的 deflateRaw 是回调式的，包一层就能 await */
const deflate = promisify(deflateRaw);

/** zip 的三个签名 */
const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;

/** 条目名里有非 ASCII 字符时，要置上「名字是 UTF-8」这一位 */
const FLAG_UTF8 = 0x0800;

/**
 * CRC32（zip 用来校验每个条目的内容）。
 *
 * 表是照着 zip 规范里那个多项式 0xEDB88320 算的。
 * 少了它的话，解出来的文件没法验完整性。
 */
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

/** 文件时间转成 zip 里的 DOS 时间（两秒一格） */
function dosStamp(date) {
  const time =
    ((date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1)) & 0xffff;
  const day =
    (((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()) & 0xffff;
  return { time, date: day };
}

/**
 * 列出要写进 zip 的东西。
 *
 * 名字一律用正斜杠——zip 规范就是这么要求的：
 * 写成反斜杠（workhub\server\index.js）的话，Linux 上的 unzip 会把整串
 * 当成文件名，解出来是一堆叫「workhub\server\index.js」的废文件，
 * 而这种包在 Windows 上看着完全正常，只在目标机器上才暴露。
 */
function collectEntries(root, prefix) {
  const entries = [];

  // 顶层目录本身也是一个条目：解出来先有个文件夹，跟 tar/zip 的习惯一样
  if (prefix) entries.push({ kind: 'dir', name: `${prefix}/` });

  const walk = (dir, rel) => {
    const items = readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    );
    for (const item of items) {
      const abs = join(dir, item.name);
      const name = rel ? `${rel}/${item.name}` : item.name;
      if (item.isDirectory()) {
        entries.push({ kind: 'dir', name: `${name}/` });
        walk(abs, name);
      } else if (item.isSymbolicLink()) {
        entries.push({ kind: 'link', name, abs });
      } else if (item.isFile()) {
        entries.push({ kind: 'file', name, abs });
      }
      // 其它类型（设备、管道）本来就不该出现在发布包里，忽略
    }
  };

  walk(root, prefix);
  return entries;
}

/**
 * 把目录打成 zip。
 *
 * 传了 baseName，zip 里就会有一层以它命名的顶层目录：
 * 解压出来是「一个文件夹」，而不是一堆文件摊在解压目录的根部。
 *
 * 为什么非要这一层：
 * 解压工具默认把包里的东西直接倒进当前目录。摊开的话，使用者面对的是
 * 十几个不知道是什么的目录（server、shared、dist、node_modules、runtime…），
 * 装到一半才发现认错了目录也说不清；升级时新旧两版混在一起更麻烦。
 * 收进一个文件夹之后，解压出来就是一个「WorkHub」，双击里面的东西就能用。
 *
 * baseName 必须等于目录自身的名字——条目名的顶层就是它，名字对不上就早点
 * 报错，别等打完包才发现结构不对。
 *
 * 为什么自己写 zip，不调系统的 tar / zip：
 * Windows 自带的 bsdtar 打包这个托盘目录时会崩（退出码 0xC0000005），
 * 崩完还留下一个被截断的 zip——那玩意儿看着是「打包成功」，实际解不开。
 * v0.3.0 发出去的就是这么个坏包：使用者拿到的是解不开的免安装版，
 * 而且因为失败被工作流里的一个写法吞掉了，流水线全程是绿的。
 * 这类「工具在别人机器上崩」的事故不该再来一次，所以压缩这件事自己来。
 */
export async function zipDirectory(stagingDir, zipPath, options = {}) {
  const baseName = options.baseName ?? '';
  if (baseName && basename(stagingDir) !== baseName) {
    throw new Error(
      `压缩包顶层目录名对不上：目录叫 ${basename(stagingDir)}，要的是 ${baseName}`,
    );
  }
  if (!existsSync(stagingDir)) {
    throw new Error(`要打包的目录不存在：${stagingDir}`);
  }

  const entries = collectEntries(stagingDir, baseName);
  const out = createWriteStream(zipPath);
  const write = async (chunk) => {
    if (!out.write(chunk)) await once(out, 'drain');
  };

  let offset = 0;
  const central = [];

  try {
    for (const entry of entries) {
      const nameBuf = Buffer.from(entry.name, 'utf8');
      const flags = /[^\x00-\x7f]/.test(entry.name) ? FLAG_UTF8 : 0;

      if (entry.kind === 'dir') {
        const local = Buffer.alloc(30);
        local.writeUInt32LE(LOCAL_SIG, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt16LE(flags, 6);
        local.writeUInt16LE(0, 8);
        local.writeUInt16LE(0, 10);
        local.writeUInt16LE(0x21, 12);
        const localOffset = offset;
        await write(local);
        await write(nameBuf);
        offset += local.length + nameBuf.length;
        central.push({
          nameBuf,
          flags,
          method: 0,
          crc: 0,
          csize: 0,
          usize: 0,
          localOffset,
          mode: 0o040755,
          time: 0,
          date: 0x21,
        });
        continue;
      }

      const stat = lstatSync(entry.abs);
      const raw =
        entry.kind === 'link'
          ? Buffer.from(readlinkSync(entry.abs), 'utf8')
          : readFileSync(entry.abs);
      const crc = crc32(raw);

      // 压不动就别压：压完反而更大（小文件、已压缩的二进制），
      // 还白费一遍 CPU。存原始内容（method 0）任何工具都认。
      let method = 8;
      let data = raw.length > 0 ? await deflate(raw) : Buffer.alloc(0);
      if (data.length >= raw.length) {
        method = 0;
        data = raw;
      }

      const { time, date } = dosStamp(stat.mtime);
      const local = Buffer.alloc(30);
      local.writeUInt32LE(LOCAL_SIG, 0);
      local.writeUInt16LE(20, 4);
      local.writeUInt16LE(flags, 6);
      local.writeUInt16LE(method, 8);
      local.writeUInt16LE(time, 10);
      local.writeUInt16LE(date, 12);
      local.writeUInt32LE(crc, 14);
      local.writeUInt32LE(data.length, 18);
      local.writeUInt32LE(raw.length, 22);
      local.writeUInt16LE(nameBuf.length, 26);
      local.writeUInt16LE(0, 28);

      const localOffset = offset;
      await write(local);
      await write(nameBuf);
      await write(data);
      offset += local.length + nameBuf.length + data.length;

      const unixMode = stat.mode & 0o170000 ? stat.mode & 0o170000 : 0o100000;
      central.push({
        nameBuf,
        flags,
        method,
        crc,
        csize: data.length,
        usize: raw.length,
        localOffset,
        mode: unixMode | (stat.mode & 0o777),
        time,
        date,
      });
    }

    // 中央目录：每个条目在这里再写一遍，外加它在文件里的位置
    const cdOffset = offset;
    let cdSize = 0;
    for (const item of central) {
      const header = Buffer.alloc(46);
      header.writeUInt32LE(CENTRAL_SIG, 0);
      header.writeUInt16LE(0x031e, 4); // 「UNIX / 3.0」——权限位靠它带
      header.writeUInt16LE(20, 6);
      header.writeUInt16LE(item.flags, 8);
      header.writeUInt16LE(item.method, 10);
      header.writeUInt16LE(item.time, 12);
      header.writeUInt16LE(item.date, 14);
      header.writeUInt32LE(item.crc, 16);
      header.writeUInt32LE(item.csize, 20);
      header.writeUInt32LE(item.usize, 24);
      header.writeUInt16LE(item.nameBuf.length, 28);
      header.writeUInt16LE(0, 30);
      header.writeUInt16LE(0, 32);
      header.writeUInt16LE(0, 34);
      header.writeUInt16LE(0, 36);
      header.writeUInt32LE((item.mode << 16) >>> 0, 38);
      header.writeUInt32LE(item.localOffset, 42);
      await write(header);
      await write(item.nameBuf);
      cdSize += header.length + item.nameBuf.length;
    }
    offset += cdSize;

    if (central.length > 0xffff) {
      throw new Error(`条目数 ${central.length} 超过 zip32 上限，得改用 zip64`);
    }
    if (offset > 0xffffffff) {
      throw new Error('包超过 4GB，得改用 zip64');
    }

    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(EOCD_SIG, 0);
    eocd.writeUInt16LE(0, 4);
    eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(central.length, 8);
    eocd.writeUInt16LE(central.length, 10);
    eocd.writeUInt32LE(cdSize, 12);
    eocd.writeUInt32LE(cdOffset, 16);
    eocd.writeUInt16LE(0, 20);
    await write(eocd);

    out.end();
    await once(out, 'finish');
  } catch (err) {
    out.destroy();
    throw err;
  }
}

/**
 * 解码条目名。
 *
 * zip 规范里，名字是 UTF-8 的话要置第 11 位标志位；
 * 没置的按老规矩走本地代码页。
 *
 * 这两种都遇到过：
 * - 我们自己打的包：UTF-8 + 标志位，处处都对；
 * - 早先用系统 tar 打的包：中文名按 Windows 的 ANSI 代码页（GBK）写，
 *   标志位没置。按 UTF-8 解会得到一串乱码（「ʹ��˵��.txt」），
 *   于是检查会说「少了 使用说明.txt」——其实文件在，只是名字解错了。
 */
function decodeEntryName(bytes, flags) {
  if (flags & FLAG_UTF8) return bytes.toString('utf8');
  if (!/[^\x00-\x7f]/.test(bytes.toString('latin1'))) return bytes.toString('latin1');
  try {
    // 老包里的中文名多半是 GBK（中文 Windows 的 ANSI 代码页）
    return new TextDecoder('gbk').decode(bytes);
  } catch {
    return bytes.toString('latin1');
  }
}

/**
 * 读 zip 的中央目录，列出里面的条目。
 *
 * 顺带就是一道「这个包是不是完整的」的检查：
 * 结尾记录、中央目录、每个条目的本地头都得在文件里对得上，
 * 少一块就是被截断了——这种包看着是压缩包，解开却是坏的。
 */
export function readZipEntries(zipPath) {
  const fd = openSync(zipPath, 'r');
  try {
    const size = fstatSync(fd).size;
    const tailLength = Math.min(size, 66_000);
    const tail = Buffer.alloc(tailLength);
    readSync(fd, tail, 0, tailLength, size - tailLength);

    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i -= 1) {
      if (tail.readUInt32LE(i) === EOCD_SIG) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) {
      throw new Error(`zip 结尾没有中央目录记录（文件被截断了？）：${zipPath}`);
    }

    const count = tail.readUInt16LE(eocd + 10);
    const cdSize = tail.readUInt32LE(eocd + 12);
    const cdOffset = tail.readUInt32LE(eocd + 16);
    if (cdOffset + cdSize > size) {
      throw new Error(`zip 的中央目录越界（文件被截断了？）：${zipPath}`);
    }

    const cd = Buffer.alloc(cdSize);
    readSync(fd, cd, 0, cdSize, cdOffset);

    const entries = [];
    let p = 0;
    for (let i = 0; i < count; i += 1) {
      if (p + 46 > cd.length || cd.readUInt32LE(p) !== CENTRAL_SIG) {
        throw new Error(`zip 中央目录第 ${i} 条记录坏了：${zipPath}`);
      }
      const nameLength = cd.readUInt16LE(p + 28);
      const extraLength = cd.readUInt16LE(p + 30);
      const commentLength = cd.readUInt16LE(p + 32);
      entries.push({
        name: decodeEntryName(cd.subarray(p + 46, p + 46 + nameLength), cd.readUInt16LE(p + 8)),
        flags: cd.readUInt16LE(p + 8),
        method: cd.readUInt16LE(p + 10),
        crc: cd.readUInt32LE(p + 16),
        compressedSize: cd.readUInt32LE(p + 20),
        size: cd.readUInt32LE(p + 24),
        localOffset: cd.readUInt32LE(p + 42),
      });
      p += 46 + nameLength + extraLength + commentLength;
    }
    return entries;
  } finally {
    closeSync(fd);
  }
}

/** 读 zip 里某个条目的内容（解压后） */
export function readZipEntryContent(zipPath, entry) {
  const fd = openSync(zipPath, 'r');
  try {
    const head = Buffer.alloc(30);
    readSync(fd, head, 0, 30, entry.localOffset);
    if (head.readUInt32LE(0) !== LOCAL_SIG) {
      throw new Error(`zip 条目 ${entry.name} 的本地头坏了`);
    }
    const nameLength = head.readUInt16LE(26);
    const extraLength = head.readUInt16LE(28);
    const start = entry.localOffset + 30 + nameLength + extraLength;
    const data = Buffer.alloc(entry.compressedSize);
    readSync(fd, data, 0, entry.compressedSize, start);
    if (entry.method === 0) return data;
    if (entry.method === 8) return inflateRawSync(data);
    throw new Error(`zip 条目 ${entry.name} 的压缩方式 ${entry.method} 不认识`);
  } finally {
    closeSync(fd);
  }
}

/**
 * 打完包立刻自己验一遍：这个 zip 是不是完整的。
 *
 * 为什么要有这一步：v0.3.0 的托盘包是坏的（打包工具崩了，留下一个被截断的 zip），
 * 而「打完就发」这条路上没有任何一环会发现它——
 * 文件在、体积不小、扩展名对，发布流程照跑不误。
 * 所以打完当场读回来：条目读不出来、名字带反斜杠、顶层散着文件，都算失败。
 *
 * @param {string} zipPath
 * @param {{prefix?: string}} options prefix 是顶层目录名（比如 workhub）
 */
export function verifyZipArchive(zipPath, options = {}) {
  const prefix = options.prefix ?? '';
  const entries = readZipEntries(zipPath);
  if (entries.length === 0) {
    throw new Error(`压缩包是空的：${zipPath}`);
  }
  for (const entry of entries) {
    if (entry.name.includes('\\')) {
      throw new Error(`压缩包里有条目名带反斜杠（别的机器上会解成一堆废文件）：${entry.name}`);
    }
    if (prefix && !entry.name.startsWith(`${prefix}/`)) {
      throw new Error(`压缩包顶层散着文件（应该全部收在 ${prefix}/ 里）：${entry.name}`);
    }
  }
  return entries;
}

/**
 * 给 zip 写一份 .sha256。
 *
 * 更新器下载完要核对：传坏了、传了一半的文件不能直接用。
 * 格式是「<哈希>  <文件名>」，跟 sha256sum 的输出一样。
 *
 * 哈希是流式算的：托盘包一百多兆，一次读进内存没必要。
 */
export async function writeSha256(zipPath, fileName) {
  const hash = createHash('sha256');
  const stream = createReadStream(zipPath);
  for await (const chunk of stream) hash.update(chunk);
  const sha256 = hash.digest('hex');
  writeFileSync(`${zipPath}.sha256`, `${sha256}  ${fileName}\n`, 'utf8');
  return sha256;
}
