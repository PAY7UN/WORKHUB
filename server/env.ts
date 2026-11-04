/**
 * 环境变量读取：统一前缀与兼容策略。
 *
 * 产品名早就从 MDHUB 改成了 WorkHub，环境变量的前缀却还留着旧名——
 * `MDHUB_SECRET`、`MDHUB_PORT` 这些名字跟产品对不上，是遗留。
 * 现在统一成 `WORKHUB_` 前缀。
 *
 * 但**不能只换名字**：这些变量不是「随便配的开关」，而是运行时契约。
 * 换名的代价按后果从重到轻排：
 *
 * - `SECRET`：改了，已加密的文档永久无法解密（主密钥由它派生）。
 * - `DB_V2` / `VAULT_DIR`：改了，既有部署找不到库、找不到文档正文。
 * - `PORT`：改了，托盘与服务端会指向不同的端口，表现是「菜单说停了，
 *   服务明明在跑」。
 *
 * 所以这里读两个名字：**新名优先，旧名兜底**。
 * 旧名什么时候都能用，新的 .env 一律写新名；等所有部署都换过一遍，
 * 旧名就可以摘掉了。
 *
 * 空串按「未配置」处理：`.env` 里留一行空的 `WORKHUB_PORT=` 是常见的
 * 手滑，留着不处理的话它会盖住后面的默认值。
 */

/** 前缀：新名在前。旧名是过渡期的兜底，不是推荐的写法。 */
const PREFIXES = ['WORKHUB_', 'MDHUB_'] as const;

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
  for (const prefix of PREFIXES) {
    const value = (env[prefix + suffix] ?? '').trim();
    if (value) return value;
  }
  return '';
}

/**
 * 读一个环境变量，按后缀取。
 *
 * `envValue('SECRET')` 依次看 `WORKHUB_SECRET`、`MDHUB_SECRET`，
 * 取第一个有值的；都没有就返回空串。
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
 * 某个变量是否被显式配置过（新名或旧名任一）。
 *
 * 与 `envValue` 的区别：这个不关心值本身，只关心「配没配」。
 *
 * @param suffix 变量名后缀（不含前缀）
 */
export function envConfigured(suffix: string): boolean {
  return PREFIXES.some((prefix) => (process.env[prefix + suffix] ?? '').trim() !== '');
}
