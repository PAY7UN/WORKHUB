/**
 * 登录失败限流：内存级递增退避。
 *
 * 为什么需要：登录接口只凭一个密码就能换到全站管理员令牌，而 scrypt 的单次派生
 * 成本（几十毫秒）远低于一次网络往返。也就是说攻击者可以持续高速试猜，成本几乎
 * 全由服务端承担——不设限时，弱口令管理员密码实际上等于对外开放字典爆破。
 *
 * 为什么是「递增退避」而不是「永久封禁」：本项目只有 admin 一个账号，一次误伤
 * 就可能把本人锁在门外，而且无处申诉。退避随失败次数指数增长、又会在冷却期后
 * 自动重新放开，两头都避开了。
 *
 * 已知局限（刻意取舍）：状态在进程内存中，重启即清空。落库会带来「重启也解不开」
 * 的新死锁，而本项目默认仅本机监听；为此引入跨进程共享状态的复杂度不划算。
 */

/** 连续失败达到该次数后开始锁定。前几次失败不锁定，避免误触即惩罚 */
const LOCK_THRESHOLD = 5;

/** 首次锁定的时长基数，此后按 2 的幂次增长 */
const BASE_DELAY_MS = 1000;

/** 单次锁定上限 5 分钟：足以让在线爆破无从下手，又不至于「忘了密码就永远进不去」 */
const MAX_DELAY_MS = 5 * 60 * 1000;

/** 记录保留时长：超过此时长没有新的失败就整条丢弃，防止 Map 被大量一次性 IP 撑大 */
const RECORD_TTL_MS = 30 * 60 * 1000;

export interface AttemptRecord {
  /** 连续失败次数（成功后清零） */
  failures: number;
  /** 最近一次失败时刻 */
  lastFailureAt: number;
  /** 锁定截止时刻，非锁定态为 0 */
  lockedUntil: number;
}

export type GateResult =
  | { allowed: true }
  | { allowed: false; retryAfterSeconds: number };

/**
 * 第 failures 次连续失败后应锁定多久。纯函数，退避曲线可单独穷举。
 */
export function lockDurationMs(failures: number): number {
  if (failures <= LOCK_THRESHOLD) return 0;
  // 先夹住指数：2^20 秒已远超 MAX_DELAY_MS，不夹会在极端输入下溢出成 Infinity
  const exponent = Math.min(failures - LOCK_THRESHOLD, 20);
  return Math.min(BASE_DELAY_MS * 2 ** exponent, MAX_DELAY_MS);
}

/** 判断某条记录在 now 时刻是否处于锁定期 */
export function evaluateGate(
  record: AttemptRecord | undefined,
  now: number,
): GateResult {
  if (!record || record.lockedUntil <= now) return { allowed: true };
  return {
    allowed: false,
    retryAfterSeconds: Math.max(1, Math.ceil((record.lockedUntil - now) / 1000)),
  };
}

/** 登记一次失败并返回新记录 */
export function nextRecord(
  record: AttemptRecord | undefined,
  now: number,
): AttemptRecord {
  // 只有 lockedUntil 落在 lastFailureAt 之后，才说明这条记录真的进入过锁定。
  // 不能只看 lockedUntil !== 0：未锁定时它被写成 now + 0（等于 lastFailureAt），
  // 拿它当「已冷却」判据会让计数在第 5 次失败处就归零，锁定永远形同虚设。
  const wasLocked = record !== undefined && record.lockedUntil > record.lastFailureAt;
  // 冷却期已结束则失败次数从 1 重新累加，避免「隔很久试错一次」直接吃满 5 分钟锁定
  const cooledDown = wasLocked && now >= record.lockedUntil;
  const failures = cooledDown ? 1 : (record?.failures ?? 0) + 1;
  return { failures, lastFailureAt: now, lockedUntil: now + lockDurationMs(failures) };
}

const records = new Map<string, AttemptRecord>();

/** 取出记录，顺带做惰性过期清理 */
function read(key: string, now: number): AttemptRecord | undefined {
  const record = records.get(key);
  if (!record) return undefined;
  if (now - record.lastFailureAt > RECORD_TTL_MS) {
    records.delete(key);
    return undefined;
  }
  return record;
}

/** 登录前调用：处于锁定期则拒绝放行 */
export function loginGate(key: string, now: number = Date.now()): GateResult {
  return evaluateGate(read(key, now), now);
}

/** 登录失败后调用 */
export function noteLoginFailure(key: string, now: number = Date.now()): void {
  records.set(key, nextRecord(read(key, now), now));
}

/** 登录成功后调用：清空该 key 的失败计数 */
export function clearLoginFailures(key: string): void {
  records.delete(key);
}

/** 清空全部计数，仅供测试使用 */
export function resetThrottleForTest(): void {
  records.clear();
}
