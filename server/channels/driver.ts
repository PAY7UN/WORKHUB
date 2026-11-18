/**
 * 通道驱动的统一形状。
 *
 * 不同来源在「怎么拿到字节、怎么把字节送出去」上各不相同，
 * 但对上层来说只有三件事：打开、收、写。
 * 这一层把它们压成同一个接口，解析、记录、界面就完全不必关心底下是哪种来源。
 */
import type { ChannelStatus } from '../../shared/tools.ts';

/** 一个通道驱动 */
export interface ChannelDriver {
  /** 打开通道：开串口 / listen / connect */
  start(): Promise<void>;
  /** 关闭通道 */
  stop(): Promise<void>;
  /** 往通道里写数据，返回实际写出的字节数 */
  send(data: Buffer, peer?: string): Promise<number>;
  /** 当前连着的对端（串口没有，返回空数组） */
  peers(): string[];
}

/** 驱动向上报的回调 */
export interface DriverHandlers {
  /** 收到一段数据 */
  onData(data: Buffer, peer?: string): void;
  /** 运行态变了 */
  onStatus(status: ChannelStatus, error?: string): void;
  /** 对端列表变了 */
  onPeers(peers: string[]): void;
}
