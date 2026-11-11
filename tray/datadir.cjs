'use strict';
/**
 * 数据目录的搬迁与「记住新位置」。
 *
 * 单独拆一个模块出来，是为了能测。这几件事出错的代价都不小：
 *
 * 1. **搬数据**：数据库（SQLite）搬一半、密钥留在原地——库里的文档全解不开，
 *    而且不报错，服务照旧起来，看着一切正常。
 * 2. **记住新位置**：位置记丢了，下次启动又回到老目录，用户以为搬好了，
 *    实际数据还在原地（或者反过来，数据在新目录，程序却还在读老目录）。
 * 3. **写在哪儿**：配置跟着数据走的话，「数据搬到哪儿」这件事本身就无处记录——
 *    鸡生蛋问题。必须有一个**不跟着数据跑**的锚点。
 *
 * 所以这里的分工是：
 * - 数据的**位置**记在锚点（exe 旁边，或默认数据目录）；
 * - 数据的**内容**跟着工作目录走。
 */
const fs = require('node:fs');
const path = require('node:path');
const { isSameDir, isWindowsStyle } = require('./pathutil.cjs');

/**
 * 跟着工作目录走的东西。
 *
 * 少一样都不行：少了 .env，密钥跟库分家；少了 data，库跟正文分家；
 * 少了 logs，升级日志跟升级结果分家。
 */
const DATA_ITEMS = ['.env', '.env.bak', 'data', 'logs', 'tray.config.json'];

/** 配置文件名 */
const CONFIG_NAME = 'tray.config.json';

/**
 * 目录能不能写。
 *
 * 用来挑配置的锚点：装到 Program Files 的用户写不了 exe 旁边的文件，
 * 这时候得退到默认数据目录（%LOCALAPPDATA%\WorkHub）去。
 *
 * @param {string} dir
 * @returns {boolean}
 */
function canWrite(dir) {
  if (!dir) return false;
  // Windows 形态的路径只有在 Windows 上才有意义：
  // 在别的系统上它不是本机路径，硬写会莫名其妙建出一个带盘符的目录。
  if (isWindowsStyle(dir) && process.platform !== 'win32') return false;
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.write-probe-${process.pid}`);
    fs.writeFileSync(probe, '');
    fs.rmSync(probe, { force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * 目标目录里是不是已经有数据。
 *
 * 已经有一份数据时不能闷头覆盖：那个目录可能是用户正在用的另一套 WorkHub，
 * 也可能就是他手动挑的「放文档的地方」。冲掉它的库，
 * 等于把别人的资料删了——这类事不能靠一句「确认」来兜底。
 *
 * @param {string} dir
 * @returns {boolean}
 */
function hasExistingData(dir) {
  try {
    if (fs.existsSync(path.join(dir, '.env'))) return true;
    if (fs.existsSync(path.join(dir, 'data', 'workhub-v2.db'))) return true;
    return false;
  } catch {
    return false;
  }
}

/**
 * 把工作目录里的东西搬到另一个目录。
 *
 * 搬而不是「移动」：搬完旧目录还在，万一新位置有问题（比如盘没插好），
 * 还能回头找。删旧数据是使用者的决定，不是托盘替他做的。
 *
 * @param {string} from 旧工作目录
 * @param {string} to 新工作目录
 * @param {object} [options]
 * @param {boolean} [options.overwrite] 目标已有同名文件时是否覆盖（默认否：跳过并记下来）
 * @param {(message: string) => void} [options.log]
 * @returns {{ copied: string[], skipped: string[], errors: string[] }}
 */
function migrateData(from, to, { overwrite = false, log = () => {} } = {}) {
  const result = { copied: [], skipped: [], errors: [] };
  if (isSameDir(from, to)) return result;

  try {
    fs.mkdirSync(to, { recursive: true });
  } catch (err) {
    result.errors.push(`建不了目标目录：${err.message}`);
    return result;
  }

  for (const name of DATA_ITEMS) {
    const src = path.join(from, name);
    const dest = path.join(to, name);
    if (!fs.existsSync(src)) continue;
    try {
      if (fs.existsSync(dest)) {
        if (!overwrite) {
          result.skipped.push(name);
          log(`目标目录里已经有 ${name}，没覆盖（跳过）`);
          continue;
        }
        // 覆盖前把旧的挪开：删掉别人目录里的东西不可逆，
        // 留个「.replaced-<时间戳>」的备份，出了事还能捞回来。
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const backup = `${dest}.replaced-${stamp}`;
        fs.renameSync(dest, backup);
        log(`目标目录里原有的 ${name} 已备份为 ${path.basename(backup)}`);
      }
      fs.cpSync(src, dest, { recursive: true, force: true });
      result.copied.push(name);
      log(`已搬走 ${name}`);
    } catch (err) {
      result.errors.push(`${name}：${err.message}`);
      log(`搬 ${name} 失败：${err.message}`);
    }
  }
  return result;
}

/**
 * 挑一个写配置文件的锚点。
 *
 * 锚点必须**不跟着数据目录走**——数据目录就是被改的那一方，
 * 配置写在它里面，下次启动就找不到「数据搬到哪儿了」这条记录。
 *
 * 优先级：
 * 1. exe 旁边：免安装包本来就是「程序、配置、数据都在一个文件夹」的形态，
 *    配置放这儿最符合直觉，也是便携部署的写法。
 * 2. 默认数据目录（%LOCALAPPDATA%\WorkHub）：装到 Program Files 时 exe 旁边写不了，
 *    退到这儿。这个位置不随 appDir 变（appDir 是后来才生效的），
 *    所以每次启动都能找到它。
 *
 * @param {object} options
 * @param {string} options.exeDir exe 所在目录
 * @param {string} options.fallbackDir 退路目录（默认数据目录）
 * @returns {string} 配置文件的完整路径
 */
function pickConfigTarget({ exeDir, fallbackDir }) {
  if (exeDir && canWrite(exeDir)) return path.join(exeDir, CONFIG_NAME);
  return path.join(fallbackDir, CONFIG_NAME);
}

/**
 * 写配置文件（保留文件里已有的其他字段）。
 *
 * 用「读出来再改一个字段再写回去」，而不是整个覆盖：
 * 配置文件里还有远端地址、令牌、快捷键这些东西，
 * 覆盖式的写法会把它们全冲掉——那等于把人的配置抹了。
 *
 * @param {string} file 配置文件路径
 * @param {object} patch 要改的字段
 * @returns {{ ok: boolean, error?: string, config?: object }}
 */
function writeConfigPatch(file, patch) {
  let current = {};
  try {
    const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    current = JSON.parse(raw);
    if (!current || typeof current !== 'object' || Array.isArray(current)) current = {};
  } catch (err) {
    // 文件不存在是常事（第一次用），读坏了就当没有：反正只改一个字段，
    // 读坏的文件留着也是坏的。记一笔，让日志里有线索。
    if (err.code !== 'ENOENT') {
      // 读坏了但仍然往下写会把别的字段丢掉——宁可不写。
      return { ok: false, error: `配置文件读不了（${err.message}），没动它` };
    }
  }
  const next = { ...current, ...patch };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    return { ok: true, config: next };
  } catch (err) {
    return { ok: false, error: `配置文件写不了（${err.message}）` };
  }
}

module.exports = {
  DATA_ITEMS,
  CONFIG_NAME,
  isSameDir,
  canWrite,
  hasExistingData,
  migrateData,
  pickConfigTarget,
  writeConfigPatch,
};
