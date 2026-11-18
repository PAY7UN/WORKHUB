/**
 * 串口驱动。
 *
 * serialport 是原生模块（底下是 C++），加载失败不该拖垮整个服务端——
 * 其余功能照样能用。所以这里是「用到才加载」，
 * 加载不了就把原因说清楚，界面据此把串口工具标成不可用。
 */
import { execFile } from 'node:child_process';
import type { SerialPortInfo } from '../../shared/tools.ts';
import type { ChannelDriver, DriverHandlers } from './driver.ts';

/** serialport 的类型：动态导入，类型照样要准 */
type SerialModule = typeof import('serialport');

let cached: SerialModule | null = null;
let loadError = '';

/** 加载 serialport；失败时抛出可读原因 */
async function loadSerialPort(): Promise<SerialModule> {
  if (cached) return cached;
  if (loadError) throw new Error(loadError);
  try {
    cached = await import('serialport');
    return cached;
  } catch (err) {
    loadError = `串口功能不可用：加载 serialport 失败（${err instanceof Error ? err.message : String(err)}）。请在服务端目录执行 npm install serialport`;
    throw new Error(loadError);
  }
}

/** serialport 是不是可用（界面据此决定串口工具能不能点） */
export async function serialAvailable(): Promise<{ available: boolean; reason: string }> {
  try {
    await loadSerialPort();
    return { available: true, reason: '' };
  } catch (err) {
    return { available: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Windows 系统登记在册的 COM 口。
 *
 * serialport 枚举的是「设备类里它认得的串口」，虚拟串口、蓝牙口这类
 * 有时会被漏掉；而 Windows 自己把本机所有注册过的 COM 口都记在
 * HARDWARE\DEVICEMAP\SERIALCOMM 里。这里把它读出来当补充——
 * 宁可多列一个打不开的口，也别让人以为本机没串口。
 *
 * 非 Windows 没有这个东西，直接返回空。
 */
async function listRegistryPorts(): Promise<string[]> {
  if (process.platform !== 'win32') return [];
  const out = await new Promise<string>((resolve) => {
    execFile(
      'reg',
      ['query', 'HKLM\\HARDWARE\\DEVICEMAP\\SERIALCOMM'],
      { encoding: 'utf8', timeout: 4000 },
      (err, stdout) => resolve(err ? '' : stdout),
    );
  });
  const ports: string[] = [];
  for (const line of out.split(/\r?\n/)) {
    const matched = line.match(/^\s*(COM\d+)\s+/i);
    if (matched) ports.push(matched[1].toUpperCase());
  }
  return ports;
}

/** 列出本机可用的串口 */
export async function listSerialPorts(): Promise<SerialPortInfo[]> {
  const found = new Map<string, SerialPortInfo>();

  // 真设备：serialport 直接枚举到的
  try {
    const mod = await loadSerialPort();
    const ports = await mod.SerialPort.list();
    for (const p of ports) {
      found.set(p.path.toUpperCase(), {
        path: p.path,
        manufacturer: p.manufacturer ?? undefined,
        serialNumber: p.serialNumber ?? undefined,
        productId: p.productId ?? undefined,
        vendorId: p.vendorId ?? undefined,
        source: 'device',
      });
    }
  } catch {
    // serialport 装不上时，下面的系统登记还能顶上
  }

  // 系统登记：在册但 serialport 没认出来的
  for (const path of await listRegistryPorts()) {
    if (!found.has(path)) found.set(path, { path, source: 'registry' });
  }

  // COM2 排在 COM10 前面
  return [...found.values()].sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }));
}

/** 串口参数（与界面表单一一对应） */
export interface SerialOptions {
  path: string;
  baudRate: number;
  dataBits: 5 | 6 | 7 | 8;
  stopBits: 1 | 1.5 | 2;
  parity: 'none' | 'even' | 'odd';
  flowControl: 'none' | 'rtscts';
}

/**
 * 打开一个串口并持续读。
 *
 * 串口没有对端概念：谁在另一头是设备的事，不是通道的事。
 */
export function createSerialDriver(options: SerialOptions, handlers: DriverHandlers): ChannelDriver {
  let port: InstanceType<SerialModule['SerialPort']> | null = null;

  return {
    async start(): Promise<void> {
      const mod = await loadSerialPort();
      const instance = new mod.SerialPort({
        path: options.path,
        baudRate: options.baudRate,
        dataBits: options.dataBits,
        stopBits: options.stopBits,
        parity: options.parity,
        rtscts: options.flowControl === 'rtscts',
        autoOpen: false,
      });

      await new Promise<void>((resolve, reject) => {
        instance.open((err) => {
          if (err) reject(new Error(`打开串口 ${options.path} 失败：${err.message}`));
          else resolve();
        });
      });

      instance.on('data', (chunk: Buffer) => handlers.onData(chunk));
      instance.on('error', (err: Error) => handlers.onStatus('error', err.message));
      instance.on('close', () => handlers.onStatus('stopped'));

      port = instance;
      handlers.onStatus('running');
    },

    async stop(): Promise<void> {
      const instance = port;
      port = null;
      if (!instance?.isOpen) return;
      await new Promise<void>((resolve) => {
        instance.close(() => resolve());
      });
    },

    async send(data: Buffer): Promise<number> {
      const instance = port;
      if (!instance?.isOpen) throw new Error('串口没打开');
      await new Promise<void>((resolve, reject) => {
        instance.write(data, (err) => {
          if (err) reject(new Error(`写串口失败：${err.message}`));
          else resolve();
        });
      });
      return data.length;
    },

    peers(): string[] {
      return [];
    },
  };
}
