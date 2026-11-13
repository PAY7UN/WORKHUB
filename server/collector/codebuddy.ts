/**
 * CodeBuddy（本机 IDE）会话采集器：读它落在磁盘上的会话痕迹。
 *
 * 数据源只有两个目录（都在 CodeBuddy 的 globalStorage 里）：
 *   - file-changes/<会话id>/<文件>_<哈希>.json：每个文件的变更记录
 *     （路径、增删行数、diff），会话还在进行时就实时更新；
 *   - edit-sessions/<会话id>.json：会话级元数据（createdAt / updatedAt）。
 *
 * 为什么不读对话原文：CodeBuddy 的会话消息不在本地（在云端），
 * state.vscdb 里只有输入草稿。但「改了哪些文件、每处改动的 diff」
 * 比聊天记录更可靠地说明「这个会话干了什么」，汇总就以它为原料。
 *
 * 本模块保持纯函数（输入目录路径，输出数据），不碰数据库、不发请求——
 * 调度与落文档在 scheduler.ts / journal.ts，AI 汇总在 summarize.ts。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { redact } from '../../shared/redact.ts';

/** 一次会话的痕迹 */
export interface SessionTrace {
  conversationId: string;
  createdAt: number;
  /** 会话最后活动时间：空闲判定与「处理到哪了」的游标都用它 */
  updatedAt: number;
  /** 变更过的文件（已排序、已脱敏、已截断） */
  files: SessionFileChange[];
}

export interface SessionFileChange {
  filePath: string;
  changeType: string;
  addedLines: number;
  removedLines: number;
  /** 截断后的 diff 文本 */
  diff: string;
  /** 变更记录文件的修改时间（用于会话内排序） */
  recordedAt: number;
}

export interface CodeBuddyDirs {
  /** file-changes/ 与 edit-sessions/ 的父目录 */
  root: string;
}

/**
 * CodeBuddy 存储目录的默认位置。
 *
 * 只认 Windows 的安装布局（%APPDATA%\CodeBuddy CN\...）；
 * 别的平台或自定义安装位置用 WORKHUB_COLLECTOR_CODEBUDDY_DIR 覆盖。
 * 找不到就返回 undefined——采集是可选能力，不装 CodeBuddy 不算错误。
 */
export function defaultCodeBuddyRoot(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (process.platform !== 'win32') return undefined;
  const appData = env.APPDATA;
  if (!appData) return undefined;
  return join(appData, 'CodeBuddy CN', 'User', 'globalStorage', 'tencent-cloud.coding-copilot');
}

/** 会话清单：file-changes 下的目录是全集（有些会话没有 edit-sessions 记录） */
export function listSessions(dirs: CodeBuddyDirs): Array<{ conversationId: string; updatedAt: number }> {
  const root = join(dirs.root, 'file-changes');
  let names: string[];
  try {
    names = readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
  const sessions = names.map((conversationId) => ({
    conversationId,
    // 优先用 edit-sessions 的 updatedAt；缺了就退回「变更记录的最新文件时间」
    updatedAt: readSessionUpdatedAt(dirs, conversationId),
  }));
  return sessions;
}

function readSessionUpdatedAt(dirs: CodeBuddyDirs, conversationId: string): number {
  const metaPath = join(dirs.root, 'edit-sessions', `${conversationId}.json`);
  try {
    const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as { updatedAt?: number };
    if (typeof meta.updatedAt === 'number') return meta.updatedAt;
  } catch {
    // edit-sessions 没有/读不了很正常，退回文件时间
  }
  // 变更目录里最新的文件时间
  const dir = join(dirs.root, 'file-changes', conversationId);
  try {
    return readdirSync(dir).reduce((latest, name) => {
      const m = statSync(join(dir, name)).mtimeMs;
      return Math.max(latest, m);
    }, 0);
  } catch {
    return 0;
  }
}

/**
 * 挑出这一轮该处理的会话：有空闲且游标没追上。
 *
 * 空闲（updatedAt 距今 ≥ idleMs）才收：正在打的会话中途收一次、
 * 结束后又收一次，同一件事会写两遍。
 * 返回按 updatedAt 升序排列（老会话先写进日志）。
 */
export function selectDueSessions(
  sessions: Array<{ conversationId: string; updatedAt: number }>,
  opts: { now: number; idleMs: number; cursorOf: (conversationId: string) => number | undefined },
): Array<{ conversationId: string; updatedAt: number }> {
  const { now, idleMs, cursorOf } = opts;
  return sessions
    .filter((s) => {
      if (!s.updatedAt) return false;
      if (now - s.updatedAt < idleMs) return false;
      return cursorOf(s.conversationId) !== s.updatedAt;
    })
    .sort((a, b) => a.updatedAt - b.updatedAt);
}

/**
 * 组装一次会话的汇总原料。
 *
 * 三个卫生措施缺一不可：
 *   1. 跳过凭据类文件（.env 等）：diff 里的密钥不值得赌正则；
 *   2. 全文过一遍 redact：diff 里可能带着请求头、令牌；
 *   3. 单文件 diff 与整份原料都截断：一个会话改 30 个大文件，
 *      不截断能把模型的上下文一次吃满。
 */
export function buildSessionTrace(
  dirs: CodeBuddyDirs,
  conversationId: string,
  limits: { maxDiffChars: number; maxTotalChars: number } = { maxDiffChars: 1600, maxTotalChars: 24000 },
): SessionTrace {
  const meta = readSessionMeta(dirs, conversationId);
  const files = readSessionFiles(dirs, conversationId, limits.maxDiffChars);
  const trace: SessionTrace = {
    conversationId,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    files: [],
  };
  let total = 0;
  for (const file of files) {
    if (isCredentialPath(file.filePath)) continue;
    const diff = redact(file.diff);
    const remaining = limits.maxTotalChars - total;
    if (remaining <= 200) break;
    const clipped = diff.length > remaining ? `${diff.slice(0, remaining)}\n…（超长截断）` : diff;
    total += clipped.length;
    trace.files.push({ ...file, diff: clipped });
  }
  return trace;
}

function readSessionMeta(
  dirs: CodeBuddyDirs,
  conversationId: string,
): { createdAt: number; updatedAt: number } {
  try {
    const meta = JSON.parse(
      readFileSync(join(dirs.root, 'edit-sessions', `${conversationId}.json`), 'utf8'),
    ) as { createdAt?: number; updatedAt?: number };
    return {
      createdAt: typeof meta.createdAt === 'number' ? meta.createdAt : 0,
      updatedAt: typeof meta.updatedAt === 'number' ? meta.updatedAt : 0,
    };
  } catch {
    return { createdAt: 0, updatedAt: readSessionUpdatedAt(dirs, conversationId) };
  }
}

function readSessionFiles(
  dirs: CodeBuddyDirs,
  conversationId: string,
  maxDiffChars: number,
): SessionFileChange[] {
  const dir = join(dirs.root, 'file-changes', conversationId);
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith('.json'));
  } catch {
    return [];
  }
  const files: SessionFileChange[] = [];
  for (const name of names) {
    try {
      const raw = JSON.parse(readFileSync(join(dir, name), 'utf8')) as {
        filePath?: string;
        changeType?: string;
        addedLines?: number;
        removedLines?: number;
        diff?: string;
      };
      if (!raw.filePath) continue;
      files.push({
        filePath: raw.filePath,
        changeType: raw.changeType ?? 'modify',
        addedLines: raw.addedLines ?? 0,
        removedLines: raw.removedLines ?? 0,
        diff: (raw.diff ?? '').slice(0, maxDiffChars),
        recordedAt: statSync(join(dir, name)).mtimeMs,
      });
    } catch {
      // 单个变更记录坏了不影响别的：跳过
    }
  }
  // 旧改动在前：汇总叙事跟着时间线走
  return files.sort((a, b) => a.recordedAt - b.recordedAt);
}

/** 凭据类文件：diff 再好看也不能让它进模型、进文档 */
function isCredentialPath(filePath: string): boolean {
  const name = basename(filePath).toLowerCase();
  return name === '.env' || name.startsWith('.env.') || name.endsWith('.pem') || name.endsWith('.key');
}

/** 把痕迹压成给模型看的纯文本 */
export function traceToPrompt(trace: SessionTrace): string {
  const lines: string[] = [];
  const time = new Date(trace.updatedAt).toLocaleString('zh-CN', { hour12: false });
  lines.push(`会话 ${trace.conversationId.slice(0, 8)}（最后活动 ${time}），改动 ${trace.files.length} 个文件：`);
  for (const file of trace.files) {
    lines.push(
      '',
      `### ${file.filePath}（${file.changeType}，+${file.addedLines}/-${file.removedLines}）`,
      '```',
      file.diff || '（无 diff 内容）',
      '```',
    );
  }
  return lines.join('\n');
}
