/**
 * 通道会话管理：工具区的运行时。
 *
 * 一次「监听串口」就是一个会话：
 * 它开着一条通道、挂一个解析器、攒一批记录。
 * 会话活在服务端，浏览器只是它的窗口——
 * 关掉页面不等于关掉监听，刷新一下还能把记录补回来。
 *
 * 记录用「会话内递增的序号」做游标：
 * 界面拿 lastId 来要增量，不会因为刷新而重复或漏掉。
 */
import { randomUUID } from 'node:crypto';
import type {
  ChannelRecord,
  ChannelSession,
  ChannelStatus,
  ProtocolTemplate,
  ToolKind,
} from '../../shared/tools.ts';
import { RAW_TEMPLATE } from '../../shared/tools.ts';
import { normalizeConfig } from './config.ts';
import { findPlugin, findTemplateById, type PluginEntry } from './plugins/registry.ts';
import type { ChannelDriver, DriverHandlers } from './driver.ts';
import { decodeFrame, FrameParser, parseHex, type EncodeRequest, type FrameSource } from './parser.ts';

/**
 * 驱动工厂：给「开一个通道」这件事换个底。
 *
 * 真实运行走串口；测试塞一个内存驱动，
 * 就能在没有硬件的机器上把切帧与记录整条路测一遍。
 */
export type DriverFactory = (
  tool: ToolKind,
  config: Record<string, string>,
  handlers: DriverHandlers,
) => ChannelDriver;
import { createSerialDriver } from './serial.ts';
import { createTcpDriver } from './tcp.ts';

/** 通道给界面推的事件 */
export type ChannelEvent =
  | { type: 'record'; record: ChannelRecord }
  | { type: 'status'; session: ChannelSession }
  | { type: 'peers'; peers: string[] };

/** 每个会话保留的记录条数上限 */
const MAX_RECORDS = 2000;

/** 同时保留的会话上限（含已停止的） */
const MAX_SESSIONS = 20;

/** 内部的会话 */
interface Session {
  id: string;
  tool: ToolKind;
  name: string;
  status: ChannelStatus;
  error?: string;
  startedAt: number;
  stoppedAt?: number;
  config: Record<string, string>;
  template: ProtocolTemplate;
  driver: ChannelDriver;
  parser: FrameSource;
  /** 解析插件：有它就走插件自己的切帧与读字段规则 */
  plugin?: PluginEntry;
  records: ChannelRecord[];
  nextRecordId: number;
  bytesIn: number;
  bytesOut: number;
  peers: string[];
  /** 是否把收到的数据记成记录 */
  recordIn: boolean;
  /** 是否把发出的数据记成记录 */
  recordOut: boolean;
  subscribers: Set<(event: ChannelEvent) => void>;
  /** 不定界时的空闲切帧定时器 */
  idleTimer?: NodeJS.Timeout;
  /** 定期把状态推给订阅者（记录关掉时字节数还在涨，得让界面看得到） */
  statusTimer?: NodeJS.Timeout;
}

/** 开启会话的请求 */
export interface StartSessionInput {
  tool: ToolKind;
  config: Record<string, unknown>;
  /**
   * 这一次用哪套协议（可选）。
   *
   * 空串 = 调试模式：只把收到的字节原样记下来，不做协议解析。
   * 现场还说不清设备是哪一套协议时，先这么看着。
   */
  protocolId?: string;
  /**
   * 这一次用哪个解析插件（可选）。
   *
   * 不给 = 跟着协议走（协议自带默认插件就是它）。
   * 给了 = 用这个插件的切帧与读字段规则——同一套协议有第二种读法时用它。
   */
  pluginId?: string;
  /**
   * 直接指定协议模板（可选）。
   *
   * 给了模板就用它，不再按 id 去内置清单里查——
   * 引擎认的是「一套切帧与解码规则」，不是模板的名字。
   * 界面上只走 protocolId（模板来自内置清单），这条留给程序化调用与测试。
   */
  template?: ProtocolTemplate;
  /** 会话在界面上显示的名字 */
  name?: string;
}

/**
 * 通道管理器。
 *
 * 只做一件事：把「一个字节流」变成「一条条记录」。
 * 至于字节从哪个口来，那是驱动的事。
 */
export class ChannelManager {
  private readonly sessions = new Map<string, Session>();
  /**
   * 建驱动的方式。
   *
   * 默认走真串口；测试时塞一个内存驱动进来，
   * 就能在没有硬件的机器上把「切帧 → 记录」这条路整个跑一遍。
   */
  private readonly driverFactory?: DriverFactory;

  constructor(driverFactory?: DriverFactory) {
    this.driverFactory = driverFactory;
  }

  /** 开启一个通道 */
  async start(input: StartSessionInput): Promise<ChannelSession> {
    const normalized = normalizeConfig(input.tool, input.config ?? {});
    // 协议是这一次选的：选了就按它来，没选就是调试模式（只记原始字节）
    const template = input.template ?? (await findTemplateById(input.protocolId ?? '')) ?? RAW_TEMPLATE;
    // 解析插件：人指定了就用它，没指定就跟协议走（协议自带的默认插件）
    const plugin =
      (await findPlugin(input.pluginId ?? '')) ?? (await findPlugin(template.decoder ?? ''));

    // 驱动的回调要指回会话，可会话又要先有驱动才建得出来：
    // 用一个可变的引用把两头接上，别让谁等谁。
    const ref: { current: Session | null } = { current: null };
    const driver = this.createDriver(input.tool, normalized.config, {
      onData: (data, peer) => {
        if (ref.current) this.onData(ref.current, data, peer);
      },
      onStatus: (status, error) => {
        if (ref.current) this.onStatus(ref.current, status, error);
      },
      onPeers: (peers) => {
        if (!ref.current) return;
        ref.current.peers = peers;
        this.emit(ref.current, { type: 'peers', peers });
      },
    });

    const session: Session = {
      id: randomUUID(),
      tool: input.tool,
      name: input.name ?? normalized.name,
      status: 'running',
      startedAt: Date.now(),
      config: normalized.config,
      template,
      driver,
      parser: plugin ? plugin.createParser() : new FrameParser(template.framing),
      plugin,
      records: [],
      nextRecordId: 1,
      bytesIn: 0,
      bytesOut: 0,
      peers: [],
      recordIn: true,
      recordOut: true,
      subscribers: new Set(),
    };
    ref.current = session;

    try {
      await driver.start();
    } catch (err) {
      // 开不起来就不留会话：留一个「起不来的会话」在界面上只会让人以为还能点
      throw err instanceof Error ? err : new Error(String(err));
    }

    this.sessions.set(session.id, session);
    // 每秒推一次状态：记录关掉的时候没有记录事件推过来，
    // 字节数却还在涨——不推的话界面上的流量数字会停在那儿不动。
    session.statusTimer = setInterval(() => {
      if (session.status !== 'running') return;
      this.emit(session, { type: 'status', session: this.view(session) });
    }, 1000);
    this.evictOldSessions();
    return this.view(session);
  }

  /** 停掉一个通道 */
  async stop(id: string): Promise<boolean> {
    const session = this.sessions.get(id);
    if (!session) return false;
    if (session.status === 'stopped') return true;

    session.status = 'stopped';
    session.stoppedAt = Date.now();
    this.clearIdleTimer(session);
    if (session.statusTimer) {
      clearInterval(session.statusTimer);
      session.statusTimer = undefined;
    }
    try {
      await session.driver.stop();
    } catch {
      // 关不掉也得把会话标成已停止：界面上的状态不能停在「运行中」
    }
    // 残余的半帧也吐出来：定界规则没凑齐的那些字节，是现场排查时最想要的东西
    this.emitFrames(session, session.parser.flush());
    this.emit(session, { type: 'status', session: this.view(session) });
    return true;
  }

  /** 所有会话 */
  list(): ChannelSession[] {
    return [...this.sessions.values()].map((s) => this.view(s));
  }

  /** 取一个会话 */
  get(id: string): ChannelSession | undefined {
    const session = this.sessions.get(id);
    return session ? this.view(session) : undefined;
  }

  /** 取记录（after 是游标：只要序号比它大的） */
  records(id: string, after = 0, limit = 500): ChannelRecord[] {
    const session = this.sessions.get(id);
    if (!session) return [];
    const picked = session.records.filter((r) => r.id > after);
    return picked.slice(-limit);
  }

  /** 订阅通道事件，返回退订函数 */
  subscribe(id: string, listener: (event: ChannelEvent) => void): (() => void) | undefined {
    const session = this.sessions.get(id);
    if (!session) return undefined;
    session.subscribers.add(listener);
    return () => {
      session.subscribers.delete(listener);
    };
  }

  /**
   * 改记录开关：要不要把收到 / 发出的数据记成一条条记录。
   *
   * 只管以后：已经记下的那些还在记录表里，不给抹掉。
   */
  setRecording(
    id: string,
    options: { recordIn?: boolean; recordOut?: boolean },
  ): ChannelSession | undefined {
    const session = this.sessions.get(id);
    if (!session) return undefined;
    if (typeof options.recordIn === 'boolean') session.recordIn = options.recordIn;
    if (typeof options.recordOut === 'boolean') session.recordOut = options.recordOut;
    // 状态变了得告诉界面，不然两边的开关会各说各话
    this.emit(session, { type: 'status', session: this.view(session) });
    return this.view(session);
  }

  /** 往通道里写数据 */
  async send(id: string, data: Buffer, peer?: string): Promise<number> {
    const session = this.sessions.get(id);
    if (!session) throw new Error('通道不存在');
    if (session.status !== 'running') throw new Error('通道没在运行');

    const sent = await session.driver.send(data, peer);
    session.bytesOut += sent;
    // 发出去的字节也记一条：仿真交互时，「我发了什么」和「对方回了什么」得并排看
    this.pushRecord(session, {
      direction: 'out',
      bytes: data.length,
      peer,
      frame: data,
    });
    return sent;
  }

  /**
   * 组一条命令并发出去。
   *
   * 「解析」是收到字节读成人话，「组包」反过来：
   * 人给几个参数，组装成字节发出去。能组什么、参数怎么填，
   * 由这套协议的解码器说了算（见 NamedDecoder.builds）。
   */
  async buildFrame(
    id: string,
    request: EncodeRequest,
    peer?: string,
  ): Promise<{ frame: Buffer; sent: number }> {
    const session = this.sessions.get(id);
    if (!session) throw new Error('通道不存在');
    const plugin = session.plugin;
    if (!plugin?.encode) throw new Error('当前协议不支持组包');
    const frame = plugin.encode(request);
    if (!frame || !frame.length) throw new Error('组包失败：这条命令没组出字节');
    const sent = await this.send(id, frame, peer);
    return { frame, sent };
  }

  /** 把一段字节解成待发送的载荷 */
  static encodePayload(data: string, format: 'text' | 'hex'): Buffer {
    if (format === 'hex') {
      try {
        const bytes = parseHex(data);
        if (!bytes.length) throw new Error('内容为空');
        return bytes;
      } catch (err) {
        throw new Error(`十六进制内容不合法：${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return Buffer.from(data, 'utf8');
  }

  /* ------------------------------ 内部 ------------------------------ */

  /** 建驱动：不同通道用不同的底层，其余部分都一样 */
  private createDriver(tool: ToolKind, config: Record<string, string>, handlers: DriverHandlers): ChannelDriver {
    if (this.driverFactory) return this.driverFactory(tool, config, handlers);
    switch (tool) {
      case 'serial':
        return createSerialDriver(
          {
            path: config.port,
            baudRate: Number(config.baudRate),
            dataBits: Number(config.dataBits) as 5 | 6 | 7 | 8,
            stopBits: Number(config.stopBits) as 1 | 1.5 | 2,
            parity: config.parity as 'none' | 'even' | 'odd',
            flowControl: config.flowControl as 'none' | 'rtscts',
          },
          handlers,
        );
      case 'tcp':
        return createTcpDriver(
          {
            mode: config.mode === 'connect' ? 'connect' : 'listen',
            host: config.host,
            port: Number(config.port),
          },
          handlers,
        );
    }
  }

  /** 收到数据：切帧、记记录、推事件 */
  private onData(session: Session, data: Buffer, peer?: string): void {
    session.bytesIn += data.length;
    this.emitFrames(session, session.parser.push(data), peer);
    this.armIdleTimer(session);
  }

  /** 把切好的帧变成记录 */
  private emitFrames(session: Session, frames: Buffer[], peer?: string): void {
    for (const frame of frames) {
      this.pushRecord(session, { direction: 'in', bytes: frame.length, peer, frame });
    }
  }

  /** 记一条并推给订阅者 */
  private pushRecord(
    session: Session,
    input: { direction: 'in' | 'out'; bytes: number; peer?: string; frame: Buffer },
  ): void {
    const decoded = session.plugin
      ? session.plugin.decode(input.frame)
      : decodeFrame(input.frame, session.template);

    // 该回什么由解码器说了算：终端注册要回注册应答，心跳要回心跳应答。
    // 不回，终端会一直重发——所以这步不是「锦上添花」，是协议的一部分。
    // 放在记录开关之前：把记录关了，终端注册也得照样回话。
    if (input.direction === 'in' && decoded.reply) {
      void this.dispatchReply(session, input.peer, decoded.reply);
    }

    // 记录开关：这个方向不记就不记。
    // 字节计数照旧——「收到多少」和「记下多少」是两回事。
    if (input.direction === 'in' && !session.recordIn) return;
    if (input.direction === 'out' && !session.recordOut) return;
    const record: ChannelRecord = {
      id: session.nextRecordId++,
      ts: Date.now(),
      direction: input.direction,
      peer: input.peer,
      bytes: input.bytes,
      text: decoded.text,
      hex: decoded.hex,
      parsed: decoded.parsed,
      fields: decoded.fields,
      summary: decoded.summary,
    };
    session.records.push(record);
    if (session.records.length > MAX_RECORDS) {
      session.records.splice(0, session.records.length - MAX_RECORDS);
    }
    this.emit(session, { type: 'record', record });
  }

  /** 把解码器要求的回包发回给来帧的那个对端 */
  private async dispatchReply(
    session: Session,
    peer: string | undefined,
    reply: { data: Buffer; note?: string },
  ): Promise<void> {
    try {
      await this.send(session.id, reply.data, peer);
    } catch (err) {
      // 回包发不出去（比如对端已经断了）不该把通道搞挂：
      // 记一笔状态，让界面知道「刚才那条没回成」。
      session.error = `自动应答（${reply.note ?? '应答'}）没发出去：${
        err instanceof Error ? err.message : String(err)
      }`;
      this.emit(session, { type: 'status', session: this.view(session) });
    }
  }

  /** 运行态变了 */
  private onStatus(session: Session, status: ChannelStatus, error?: string): void {
    session.status = status;
    session.error = error;
    if (status !== 'running') {
      session.stoppedAt = Date.now();
      this.clearIdleTimer(session);
    }
    this.emit(session, { type: 'status', session: this.view(session) });
  }

  /**
   * 不定界时的空闲切帧。
   *
   * 没有分隔符、也没有长度字段的协议，只能靠「安静下来」判断一条结束了。
   * 定时器每次收到数据都重置：只要还在说话，就说明这一条还没完。
   *
   * 具名解码器自带切帧规则（帧头帧尾之类），用不着这个定时器。
   */
  private armIdleTimer(session: Session): void {
    if (session.plugin) return;
    if (session.template.framing.kind !== 'timeout') return;
    this.clearIdleTimer(session);
    const idleMs = session.template.framing.idleMs ?? 200;
    session.idleTimer = setTimeout(() => {
      session.idleTimer = undefined;
      this.emitFrames(session, session.parser.flush());
    }, idleMs);
  }

  private clearIdleTimer(session: Session): void {
    if (!session.idleTimer) return;
    clearTimeout(session.idleTimer);
    session.idleTimer = undefined;
  }

  /** 推事件给所有订阅者 */
  private emit(session: Session, event: ChannelEvent): void {
    for (const listener of session.subscribers) {
      try {
        listener(event);
      } catch {
        // 一个订阅者出错不该影响其他订阅者，更不该影响通道本身
      }
    }
  }

  /** 会话的对外视图 */
  private view(session: Session): ChannelSession {
    return {
      id: session.id,
      tool: session.tool,
      name: session.name,
      status: session.status,
      error: session.error,
      startedAt: session.startedAt,
      stoppedAt: session.stoppedAt,
      config: session.config,
      templateId: session.template.id,
      pluginId: session.plugin?.id,
      // 这条通道能组哪些命令：界面照着渲染组包表单
      builds: session.plugin?.builds,
      recordCount: session.records.length,
      bytesIn: session.bytesIn,
      bytesOut: session.bytesOut,
      peers: [...session.peers],
      recordIn: session.recordIn,
      recordOut: session.recordOut,
    };
  }

  /** 会话开太多时，把最早停掉的那些清掉 */
  private evictOldSessions(): void {
    if (this.sessions.size <= MAX_SESSIONS) return;
    const stopped = [...this.sessions.values()]
      .filter((s) => s.status === 'stopped')
      .sort((a, b) => a.startedAt - b.startedAt);
    for (const session of stopped) {
      if (this.sessions.size <= MAX_SESSIONS) break;
      this.sessions.delete(session.id);
    }
  }
}

/** 全局唯一的管理器：通道是长驻资源，不该每个请求各建一份 */
export const channelManager = new ChannelManager();
