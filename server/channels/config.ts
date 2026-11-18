/**
 * 工具参数的校验与规范化。
 *
 * 界面上的表单只保证「填了」，不保证「填对了」：
 * 端口写成 70000、波特率写成 9600.5，这些都得在服务端拦下来，
 * 不然错误会一路传到 socket.listen 上，变成一句看不懂的 "port out of range"。
 *
 * 规范化后的参数一律存成字符串（ChannelSession.config 就是 Record<string,string>），
 * 界面上原样显示回去，不用另外维护一份「显示用」的结构。
 */
import type { ToolKind } from '../../shared/tools.ts';

/** 参数不对时抛这个：路由层翻译成 400 与一句人话 */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/** 取一个整数：必须是整数且落在区间内 */
function intOf(raw: Record<string, unknown>, key: string, label: string, min: number, max: number, fallback?: number): number {
  const value = raw[key];
  if (value === undefined || value === null || value === '') {
    if (fallback !== undefined) return fallback;
    throw new ConfigError(`${label}不能为空`);
  }
  const num = Number(value);
  if (!Number.isFinite(num) || !Number.isInteger(num)) throw new ConfigError(`${label}必须是整数`);
  if (num < min || num > max) throw new ConfigError(`${label}必须在 ${min} 到 ${max} 之间`);
  return num;
}

/** 取一个字符串：去掉首尾空白 */
function strOf(raw: Record<string, unknown>, key: string, label: string, fallback?: string): string {
  const value = raw[key];
  if (value === undefined || value === null || value === '') {
    if (fallback !== undefined) return fallback;
    throw new ConfigError(`${label}不能为空`);
  }
  const text = String(value).trim();
  if (!text) {
    if (fallback !== undefined) return fallback;
    throw new ConfigError(`${label}不能为空`);
  }
  return text;
}

/** 取一个枚举值 */
function enumOf<T extends string>(raw: Record<string, unknown>, key: string, label: string, allowed: readonly T[], fallback: T): T {
  const value = raw[key];
  if (value === undefined || value === null || value === '') return fallback;
  const text = String(value).trim() as T;
  if (!allowed.includes(text)) throw new ConfigError(`${label}只能是 ${allowed.join(' / ')}`);
  return text;
}

/** 规范化后的结果 */
export interface NormalizedConfig {
  /** 存进会话里的参数（字符串） */
  config: Record<string, string>;
  /** 人看的名字 */
  name: string;
}

const PARITIES = ['none', 'even', 'odd'] as const;
const FLOW_CONTROLS = ['none', 'rtscts'] as const;

/**
 * 按工具种类规范化参数。
 *
 * 串口的参数讲究：端口要真存在、波特率得是整数、数据位与停止位要配得上。
 * 与其用一张万能表硬凑，不如各写各的——校验规则一眼能看完。
 */
export function normalizeConfig(tool: ToolKind, raw: Record<string, unknown>): NormalizedConfig {
  switch (tool) {
    case 'serial': {
      const port = strOf(raw, 'port', '串口');
      const baudRate = intOf(raw, 'baudRate', '波特率', 50, 4000000, 115200);
      const dataBits = intOf(raw, 'dataBits', '数据位', 5, 8, 8);
      const stopBitsRaw = strOf(raw, 'stopBits', '停止位', '1');
      const stopBits = stopBitsRaw === '1.5' ? 1.5 : intOf(raw, 'stopBits', '停止位', 1, 2, 1);
      const parity = enumOf(raw, 'parity', '校验', PARITIES, 'none');
      const flowControl = enumOf(raw, 'flowControl', '流控', FLOW_CONTROLS, 'none');
      return {
        config: {
          port,
          baudRate: String(baudRate),
          dataBits: String(dataBits),
          stopBits: String(stopBits),
          parity,
          flowControl,
        },
        name: `${port} · ${baudRate}`,
      };
    }
  }
}
