/**
 * 宿主环境的单一真源：什么版本、外面有没有人管着这个进程。
 *
 * 为什么值得单列：升级器和重启接口都要回答同一个问题——
 * 「进程退出之后，谁来把它拉起来」。两边答案不一致的后果只有两种，
 * 都很难查：起两个进程抢同一个端口（EADDRINUSE），或者一个都不起
 * （服务就这么没了）。这个判断散落两处时，两边迟早会走偏。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { envValueFrom } from './env.ts';
import { APP_ROOT } from './paths.ts';

/**
 * 当前版本：读 package.json。
 *
 * 读不到就报 unknown：版本号是给人看的（升级界面、状态接口），
 * 读不到不影响功能，不该因此抛错。
 */
export function currentVersion(root = APP_ROOT): string {
  try {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version?: string };
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * 认出谁在管着这个进程。
 *
 * 有守护进程时，退出即可，它会重新拉起；没人管时，退出等于服务彻底停了。
 * 返回 systemd / pm2 / docker，或者 null（没人管）。
 */
export function detectSupervisor(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.INVOCATION_ID) return 'systemd';
  if (env.PM2_HOME || env.pm_id) return 'pm2';
  if (existsSync('/.dockerenv')) return 'docker';
  return null;
}

/** 被托盘托管的服务不能自己重启：托盘才是它的父进程监管者 */
export function isSupervisedByTray(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.WORKHUB_PARENT_PID);
}

/** 重启的几种走法 */
export type RestartStrategy = 'command' | 'supervisor' | 'self';

export interface RestartPlan {
  strategy: RestartStrategy;
  detail: string;
}

/**
 * 「进程退出之后，谁来把它拉起来」的兜底判断。
 *
 * 升级和重启都要回答同一个问题，两处各写一份的话迟早走偏：
 * 走偏的后果只有两种，都很难查——起两个进程抢同一个端口，
 * 或者一个都不起（服务就这么没了）。
 *
 * 这里只管后三档。托盘与 Windows 服务宿主排在更前面：
 * 它们是「已经在管着这个进程」的角色，换成命令去重启就变成两套人同时管。
 */
export function planRestartFallback(env: NodeJS.ProcessEnv = process.env): RestartPlan {
  // 1. 运维明确指定了命令（比如 systemctl restart workhub），最省心
  const cmd = envValueFrom(env, 'RESTART_CMD');
  if (cmd) return { strategy: 'command', detail: cmd };
  // 2. 认得出守护进程 —— 退出即可，守护进程会接手
  const supervisor = detectSupervisor(env);
  if (supervisor) return { strategy: 'supervisor', detail: `由 ${supervisor} 拉起` };
  // 3. 都没 —— 像 `node server/index.ts` 这样裸跑的进程，
  //    退出后没人接盘，不自己起一个就等于把服务停了
  return { strategy: 'self', detail: '没有守护进程，自己再起一个' };
}
