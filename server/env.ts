/**
 * 环境变量读取：统一前缀。
 *
 * 产品名早就从 MDHUB 改成了 WorkHub，环境变量的前缀也跟着统一成 `WORKHUB_`：
 * `MDHUB_SECRET`、`MDHUB_PORT` 这些名字跟产品对不上，是遗留。
 *
 * 只认新名。旧名不再兜底——保留兜底等于让两套配置长期并存，
 * 而「配了旧名却以为生效了」的排查成本，远高于一次性改名。
 *
 * 空串按「未配置」处理：`.env` 里留一行空的 `WORKHUB_PORT=` 是常见的
 * 手滑，留着不处理的话它会盖住后面的默认值。
 */

/** 前缀 */
const PREFIX = 'WORKHUB_';

/**
 * 从指定的环境变量集合里取值，按后缀取。
 *
 * 传对象而不是直接读 `process.env`，是为了让接受 env 参数的函数
 * （路径解析、宿主判断、更新源）仍然可测——测试注入假 env，
 * 不必真的改进程环境变量。
 *
 * @param env 环境变量集合
 * @param suffix 变量名后缀（不含前缀）
 */
export function envValueFrom(env: NodeJS.ProcessEnv, suffix: string): string {
  return (env[PREFIX + suffix] ?? '').trim();
}

/**
 * 读一个环境变量，按后缀取。
 *
 * `envValue('SECRET')` 读的就是 `WORKHUB_SECRET`，没配则返回空串。
 *
 * @param suffix 变量名后缀（不含前缀）
 */
export function envValue(suffix: string): string {
  return envValueFrom(process.env, suffix);
}

/**
 * 读一个开关型变量：值为 `1` 即为开。
 *
 * @param suffix 变量名后缀（不含前缀）
 */
export function envFlag(suffix: string): boolean {
  return envValue(suffix) === '1';
}

/**
 * 某个变量是否被显式配置过。
 *
 * 与 `envValue` 的区别：这个不关心值本身，只关心「配没配」。
 *
 * @param suffix 变量名后缀（不含前缀）
 */
export function envConfigured(suffix: string): boolean {
  return (process.env[PREFIX + suffix] ?? '').trim() !== '';
}
