/**
 * 网口（TCP）驱动。
 *
 * 两种模式，区别只在于「谁先动」：
 *
 * - listen：本机开端口，等对端连进来。JT/T 808 平台就是这么干的——
 *   终端是客户端，平台是服务端，终端连上平台的端口（常用 7612）。
 * - connect：本机当客户端，主动连对端。
 *
 * 一个连接就是一个「对端」（peer）。JT/T 808 一个终端一条连接，
 * 所以「哪个终端」就是「哪条连接」——自动应答也知道该回给谁。
 */
import net from 'node:net';
import type { ChannelDriver, DriverHandlers } from './driver.ts';

/** 网口参数 */
export interface TcpOptions {
  mode: 'listen' | 'connect';
  host: string;
  port: number;
}

/** 把一条连接变成「对端」的标识 */
function peerOf(socket: net.Socket): string {
  const address = socket.remoteAddress ?? '未知';
  // IPv6 映射的 IPv4（::ffff:127.0.0.1）读着别扭，去掉前缀
  const clean = address.startsWith('::ffff:') ? address.slice(7) : address;
  return `${clean}:${socket.remotePort ?? 0}`;
}

/**
 * 开一个网口通道。
 *
 * 监听模式下一台设备断线，不影响端口继续开着——设备重连就是新的一条连接。
 */
export function createTcpDriver(options: TcpOptions, handlers: DriverHandlers): ChannelDriver {
  let server: net.Server | null = null;
  /** 已连上的对端：标识 → socket */
  const peers = new Map<string, net.Socket>();

  const announcePeers = (): void => handlers.onPeers([...peers.keys()]);

  /** 接管一条连接：收、发、断开 */
  const attach = (socket: net.Socket, peer: string, reportErrors: boolean): void => {
    socket.setNoDelay(true);
    peers.set(peer, socket);
    announcePeers();

    socket.on('data', (chunk: Buffer) => handlers.onData(chunk, peer));
    socket.on('error', (err: Error) => {
      // 一条连接出错（比如对端突然断电）不该把整个通道带走：
      // 监听模式端口还开着，设备重连就是新的一条连接。
      if (reportErrors) handlers.onStatus('error', `对端 ${peer} 出错：${err.message}`);
    });
    socket.on('close', () => {
      if (peers.get(peer) === socket) peers.delete(peer);
      announcePeers();
      if (reportErrors) handlers.onStatus('error', `对端 ${peer} 断开了`);
    });
  };

  return {
    async start(): Promise<void> {
      if (options.mode === 'connect') {
        // 主动连出去：本机是客户端
        await new Promise<void>((resolve, reject) => {
          const socket = net.createConnection({ host: options.host, port: options.port });
          const onError = (err: Error): void => {
            reject(new Error(`连 ${options.host}:${options.port} 失败：${err.message}`));
          };
          socket.once('error', onError);
          socket.once('connect', () => {
            socket.removeListener('error', onError);
            attach(socket, `${options.host}:${options.port}`, true);
            resolve();
          });
        });
        handlers.onStatus('running');
        return;
      }

      // 监听：本机是服务端，等设备连进来
      await new Promise<void>((resolve, reject) => {
        const instance = net.createServer((socket) => {
          attach(socket, peerOf(socket), false);
        });
        instance.once('error', (err: Error) => {
          reject(new Error(`监听 ${options.host}:${options.port} 失败：${err.message}`));
        });
        instance.listen(options.port, options.host, () => {
          server = instance;
          // 监听成功后监听器上的错误（比如端口被别的进程抢走）只报状态，不炸掉进程
          instance.on('error', (err: Error) => {
            handlers.onStatus('error', `监听出错：${err.message}`);
          });
          resolve();
        });
      });
      handlers.onStatus('running');
    },

    async stop(): Promise<void> {
      for (const socket of peers.values()) socket.destroy();
      peers.clear();
      announcePeers();
      const instance = server;
      server = null;
      if (!instance) return;
      await new Promise<void>((resolve) => {
        instance.close(() => resolve());
      });
    },

    async send(data: Buffer, peer?: string): Promise<number> {
      let targets: net.Socket[];
      if (peer) {
        const socket = peers.get(peer);
        if (!socket) throw new Error(`对端 ${peer} 不在了`);
        targets = [socket];
      } else {
        targets = [...peers.values()];
        if (!targets.length) throw new Error('还没有对端连上来');
      }

      let sent = 0;
      for (const socket of targets) {
        await new Promise<void>((resolve, reject) => {
          socket.write(data, (err) => {
            if (err) reject(new Error(`写数据失败：${err.message}`));
            else resolve();
          });
        });
        sent += data.length;
      }
      return sent;
    },

    peers(): string[] {
      return [...peers.keys()];
    },
  };
}
