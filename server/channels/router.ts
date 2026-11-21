/**
 * 工具区（接入与仿真）的 HTTP 接口。
 *
 * 一条流水线，一个入口：
 * 数据源（串口）
 *   → 协议解析（协议类型 + 解析插件）
 *   → 记录（增量拉取 + SSE 实时推）
 *
 * 协议类型随安装包发布；解析插件除了内置的，
 * 还包括项目开发者发布到 plugins/ 目录里的那些——
 * 所以这里没有「新建工具」的接口，但插件是能自己长出来的。
 *
 * 运行时由人决定的只有三件事：开哪个口、选哪套协议类型、用哪个解析插件。
 */
import { Router, type Request, type Response } from 'express';
import { requireAdmin } from '../auth.ts';
import { convertDocumentToMarkdown } from '../docToMarkdown.ts';
import {
  CATEGORY_DEFS,
  TOOL_DEFS,
  TOOL_GROUP_LABELS,
  RAW_TEMPLATE,
  type ChannelRecord,
  type ToolKind,
} from '../../shared/tools.ts';
import type { PluginSummary } from '../../shared/plugins.ts';
import { ConfigError } from './config.ts';
import { reservedAppPorts } from './appPorts.ts';
import { ChannelManager, channelManager, type ChannelEvent } from './manager.ts';
import { decodeFrame, parseHex } from './parser.ts';
import { findPlugin, findTemplateById, listPlugins, listTemplates, pluginWarnings, refreshPluginRegistry } from './plugins/registry.ts';
import {
  builtinDocNodeIdFor,
  builtinDocState,
  resetBuiltinDoc,
  writeBuiltinDoc,
} from '../builtinDocs.ts';
import { getDoc } from '../db.ts';
import { isValidProtocolId } from './protocolDocs.ts';
import { listSerialPorts, serialAvailable } from './serial.ts';

/** 心跳间隔：SSE 长时间没数据时，代理与浏览器都靠它判断连接还活着 */
const HEARTBEAT_MS = 25_000;

/** 合法工具种类 */
const TOOL_KINDS: ToolKind[] = ['serial', 'tcp'];

/** 把异常翻译成人话 */
function fail(res: Response, err: unknown, fallback = '操作失败'): void {
  const message = err instanceof Error ? err.message : String(err);
  const status = err instanceof ConfigError ? 400 : 500;
  res.status(status).json({ error: message || fallback });
}

/**
 * 解析插件清单：只带界面用得上的字段。
 *
 * 协议详情（帧结构、命令码）不给：它是文档，住在记录区，
 * 界面拿到它也只会再摊开一遍——那正是要删掉的做法。
 */
function pluginBriefs(plugins: PluginSummary[]): PluginSummary[] {
  return plugins.map((plugin) => ({
    id: plugin.id,
    name: plugin.name,
    publisher: plugin.publisher,
    version: plugin.version,
    summary: plugin.summary,
    protocolId: plugin.protocolId,
    transports: plugin.transports,
    builtin: plugin.builtin,
    source: plugin.source,
  }));
}

/** 建工具区路由 */
export function createToolsRouter(): Router {
  const router = Router();

  /**
   * 工具目录。
   *
   * 界面按这个渲染：有哪些接入大类、有哪些接入方式、有哪些协议类型可选、
   * 有哪些解析插件（连发布者与版本一起给）。
   * 串口能不能用也一并告诉界面——serialport 装不上时，
   * 让界面直接标成不可用，比让人点了才报错强。
   *
   * 协议详情（帧结构、命令码）不在这个接口里：它是文档，住在记录区。
   */
  router.get('/', async (_req, res) => {
    try {
      const serial = await serialAvailable();
      const [protocols, plugins, warnings] = await Promise.all([
        listTemplates(),
        listPlugins(),
        pluginWarnings(),
      ]);
      res.json({
        categories: CATEGORY_DEFS,
        tools: TOOL_DEFS,
        groups: TOOL_GROUP_LABELS,
        protocols,
        plugins: pluginBriefs(plugins),
        pluginWarnings: warnings,
        serial,
        // 应用自己占着的端口：界面据此提醒人别把监听开到这些端口上
        reservedPorts: reservedAppPorts(),
      });
    } catch (err) {
      fail(res, err, '读取工具目录失败');
    }
  });

  /** 解析插件清单（目录接口里已带一份，这里按需单独取） */
  router.get('/plugins', async (_req, res) => {
    try {
      res.json({ plugins: pluginBriefs(await listPlugins()), warnings: await pluginWarnings() });
    } catch (err) {
      fail(res, err, '读取插件清单失败');
    }
  });


  /** 本机可用串口 */
  router.get('/serial-ports', async (_req, res) => {
    try {
      res.json({ ports: await listSerialPorts() });
    } catch (err) {
      fail(res, err, '读取串口列表失败');
    }
  });

  /** 所有通道会话 */
  router.get('/sessions', (_req, res) => {
    res.json({ sessions: channelManager.list() });
  });

  /**
   * 读一套协议的说明书。
   *
   * 说明书住在记录区的内置目录里，这个接口给的是它的引用加正文——
   * 「看文档」在界面上只有一处（记录区），这里是给程序用的。
   */
  router.get('/protocols/:protocolId/doc', async (req, res) => {
    const protocolId = String(req.params.protocolId ?? '');
    try {
      const nodeId = builtinDocNodeIdFor(protocolId);
      const node = nodeId ? getDoc(nodeId) : undefined;
      if (!node) {
        res.status(404).json({ error: '这套协议还没有文档' });
        return;
      }
      const state = builtinDocState(protocolId);
      res.json({
        doc: {
          nodeId: node.id,
          title: node.name,
          markdown: node.content ?? '',
          origin: state.localModified ? 'local' : 'builtin',
          hasUpdate: state.hasUpdate,
        },
      });
    } catch (err) {
      fail(res, err, '读取协议文档失败');
    }
  });

  /**
   * 导入协议文档。
   *
   * 两种给法：
   * - 上传文件：原始字节（content-type: application/octet-stream），文件名放在 query 里；
   * - 给网址：JSON body `{ url, title }`。
   *
   * 两种都转成 Markdown，写进记录区里那篇内置文档——
   * 写完它就是「现场版」了：代码以后更新说明书也不会覆盖它。
   *
   * 写文档是管理员的活：它改的是这台机器上所有人看到的协议说明。
   */
  router.post('/protocols/:protocolId/doc', requireAdmin, async (req, res) => {
    const protocolId = String(req.params.protocolId ?? '');
    try {
      if (!isValidProtocolId(protocolId)) {
        res.status(400).json({ error: '协议 id 不合法' });
        return;
      }

      const body = req.body as { url?: string; title?: string } | Buffer | undefined;
      const title = typeof body === 'object' && !Buffer.isBuffer(body) ? body.title : undefined;

      let converted;
      if (Buffer.isBuffer(body)) {
        const filename = String(req.query.filename ?? 'document.txt');
        converted = await convertDocumentToMarkdown({ bytes: body, filename, title });
      } else if (body && typeof body.url === 'string' && body.url.trim()) {
        converted = await convertDocumentToMarkdown({ url: body.url, title });
      } else {
        res.status(400).json({ error: '要么上传文档文件，要么给一个网址' });
        return;
      }

      // 落在「串口」还是「网口」目录里，看这套协议适用于哪种接入方式
      const template = await findTemplateById(protocolId);
      writeBuiltinDoc(protocolId, converted.markdown, template?.transports);
      // 协议清单是进程内缓存，不重建的话界面还显示旧文档
      await refreshPluginRegistry();
      const nodeId = builtinDocNodeIdFor(protocolId);
      const state = builtinDocState(protocolId);
      res.json({
        doc: {
          nodeId: nodeId ?? '',
          // 标题取节点上的真名：请求里那个只是转换时的临时标题，
          // 写进记录区之后它就该是那篇文档自己的名字
          title: (nodeId ? getDoc(nodeId)?.name : undefined) ?? title ?? '',
          origin: state.localModified ? 'local' : 'builtin',
          hasUpdate: state.hasUpdate,
        },
        warnings: converted.warnings,
        kind: converted.kind,
      });
    } catch (err) {
      fail(res, err, '导入协议文档失败');
    }
  });

  /**
   * 恢复成内置版本。
   *
   * 不是把现场版删掉——那等于让它消失，是用户自己的稿子。
   * 而是把仓库里那份抄回去：抄回去之后它又归代码管了。
   */
  router.delete('/protocols/:protocolId/doc', requireAdmin, async (req, res) => {
    const protocolId = String(req.params.protocolId ?? '');
    try {
      if (!isValidProtocolId(protocolId)) {
        res.status(400).json({ error: '协议 id 不合法' });
        return;
      }
      const reset = resetBuiltinDoc(protocolId);
      await refreshPluginRegistry();
      const nodeId = builtinDocNodeIdFor(protocolId);
      const state = builtinDocState(protocolId);
      res.json({
        reset,
        doc: nodeId
          ? {
              nodeId,
              title: getDoc(nodeId)?.name ?? '',
              origin: state.localModified ? 'local' : 'builtin',
              hasUpdate: state.hasUpdate,
            }
          : undefined,
      });
    } catch (err) {
      fail(res, err, '恢复协议文档失败');
    }
  });

  /**
   * 开启一个通道。
   *
   * 协议与解析插件都是**这一次由人选**的，不是某张表里写死的：
   * - 给了 protocolId：按那套协议切帧；
   * - 给了 pluginId：用那个插件切的帧、读的字段（同一套协议的第二种读法）；
   * - 都不给（或给空串）：调试模式，只把收到的字节原样记下来，
   *   现场还说不清是哪套协议时，先这么看着。
   */
  router.post('/sessions', async (req, res) => {
    const body = req.body ?? {};
    try {
      const tool = String(body.tool ?? '') as ToolKind;
      if (!TOOL_KINDS.includes(tool)) {
        res.status(400).json({ error: '未知的工具类型' });
        return;
      }

      const protocolId = body.protocolId ? String(body.protocolId) : '';
      if (protocolId && !(await findTemplateById(protocolId))) {
        res.status(400).json({ error: '未知的协议' });
        return;
      }

      const pluginId = body.pluginId ? String(body.pluginId) : '';
      if (pluginId && !(await findPlugin(pluginId))) {
        res.status(400).json({ error: '未知的解析插件' });
        return;
      }
      // 解析插件跟接入方式对不对得上，由通道管理器统一把关
      // （串口的车载屏协议拿到网口上只会解出乱码）。

      const session = await channelManager.start({
        tool,
        config: (body.config ?? {}) as Record<string, unknown>,
        protocolId,
        pluginId,
        name: body.name ? String(body.name) : undefined,
      });
      res.json({ session });
    } catch (err) {
      fail(res, err, '开启通道失败');
    }
  });

  /** 单个通道 */
  router.get('/sessions/:id', (req, res) => {
    const session = channelManager.get(String(req.params.id));
    if (!session) {
      res.status(404).json({ error: '通道不存在' });
      return;
    }
    res.json({ session });
  });

  /**
   * 通道记录。
   *
   * after 是游标：只要序号比它大的记录。
   * 界面刷新后拿最后一条的序号来要增量，既不重也不漏。
   */
  router.get('/sessions/:id/records', (req, res) => {
    const id = String(req.params.id);
    const session = channelManager.get(id);
    if (!session) {
      res.status(404).json({ error: '通道不存在' });
      return;
    }
    const after = Number(req.query.after ?? 0) || 0;
    const limit = Math.min(Math.max(Number(req.query.limit ?? 500) || 500, 1), 2000);
    res.json({ session, records: channelManager.records(id, after, limit) });
  });

  /**
   * 实时事件流。
   *
   * 连接建立时先补一份快照（已有的记录 + 当前状态），
   * 之后才是增量事件——省得界面自己去拼「先拉历史、再接流」的那点时间差。
   */
  router.get('/sessions/:id/stream', (req: Request, res: Response) => {
    const id = String(req.params.id);
    const session = channelManager.get(id);
    if (!session) {
      res.status(404).json({ error: '通道不存在' });
      return;
    }

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    const send = (event: string, data: unknown): void => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    const snapshot: ChannelRecord[] = channelManager.records(id, 0, 2000);
    send('snapshot', { session, records: snapshot });

    const unsubscribe = channelManager.subscribe(id, (event: ChannelEvent) => {
      if (event.type === 'record') send('record', event.record);
      else if (event.type === 'status') send('status', event.session);
      else if (event.type === 'peers') send('peers', { peers: event.peers });
    });

    // 心跳用注释行（: ping）：SSE 客户端会忽略它，却能让连接不被判定为空闲
    const heartbeat = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch {
        /* 连接已断，等 close 事件来清理 */
      }
    }, HEARTBEAT_MS);

    // 订阅者断开只影响它自己的连接，绝不能影响正在跑的通道
    req.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe?.();
    });
  });

  /**
   * 往通道里发数据。
   *
   * 串口写出去走这里：
   * data 是要发出去的内容，format 决定它是文本还是十六进制，
   * peer 指定发给哪个对端（不指定就是发给当前唯一的对端）。
   */
  router.post('/sessions/:id/send', async (req, res) => {
    const id = String(req.params.id);
    const body = req.body ?? {};
    const data = typeof body.data === 'string' ? body.data : '';
    const format = body.format === 'hex' ? 'hex' : 'text';
    const peer = typeof body.peer === 'string' && body.peer ? body.peer : undefined;
    if (!data.trim()) {
      res.status(400).json({ error: '发送内容不能为空' });
      return;
    }
    try {
      const payload = ChannelManager.encodePayload(data, format);
      const sent = await channelManager.send(id, payload, peer);
      res.json({ sent });
    } catch (err) {
      fail(res, err, '发送失败');
    }
  });

  /**
   * 组一条命令并发出去。
   *
   * 「解析」是把收到的字节读成人话，「组包」反过来：
   * 人填几个参数，服务按这套协议的规则组装成字节帧发出去。
   *
   * 能组什么、参数怎么填，由这条通道用的解析插件说了算——
   * 界面照着 session.builds 渲染表单，这里只负责照着组、照着发。
   *
   * peer 指定发给哪个对端：JT/T 808 一个终端一条连接，
   * 不指定就发给当前所有连着的对端。
   *
   * dryRun 为真时只组不发：发之前先看一眼这帧长什么样，
   * 组错了当场就能发现。
   */
  router.post('/sessions/:id/build', async (req, res) => {
    const id = String(req.params.id);
    const body = req.body ?? {};
    const kind = String(body.kind ?? '').trim();
    if (!kind) {
      res.status(400).json({ error: '要组哪条命令没说清楚' });
      return;
    }
    const peer = typeof body.peer === 'string' && body.peer ? body.peer : undefined;
    const dryRun = body.dryRun === true;
    const args: Record<string, string> = {};
    const rawArgs = (body.args ?? {}) as Record<string, unknown>;
    for (const [key, value] of Object.entries(rawArgs)) {
      args[key] = typeof value === 'string' ? value : value == null ? '' : String(value);
    }
    try {
      const result = await channelManager.buildFrame(id, { kind, args }, peer, dryRun);
      res.json({
        sent: result.sent,
        frame: result.frame.toString('hex').toUpperCase(),
        bytes: result.frame.length,
        dryRun,
        // 按协议结构切开的几段：界面照着逐段核对
        segments: result.segments,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // 组不出来是「命令或参数不对」，不是服务器炸了：这类错该是 400
      res.status(400).json({ error: message || '组包失败' });
    }
  });

  /**
   * 改记录开关。
   *
   * 收到 / 发出的数据要不要记成一条条记录，由人当场定：
   * 只看不收的场合关掉「记录收到的数据」，流量照样在跑，只是不占记录表。
   */
  router.patch('/sessions/:id/recording', (req, res) => {
    const id = String(req.params.id);
    const body = req.body ?? {};
    const session = channelManager.setRecording(id, {
      recordIn: typeof body.recordIn === 'boolean' ? body.recordIn : undefined,
      recordOut: typeof body.recordOut === 'boolean' ? body.recordOut : undefined,
    });
    if (!session) {
      res.status(404).json({ error: '通道不存在' });
      return;
    }
    res.json({ session });
  });

  /** 停掉一个通道 */
  router.delete('/sessions/:id', async (req, res) => {
    const id = String(req.params.id);
    try {
      const stopped = await channelManager.stop(id);
      if (!stopped) {
        res.status(404).json({ error: '通道不存在' });
        return;
      }
      res.json({ session: channelManager.get(id) });
    } catch (err) {
      fail(res, err, '停止通道失败');
    }
  });

  /**
   * 解一段十六进制。
   *
   * 调试台上「自定义解析数据」那块就是这么用的：
   * 粘贴一段抓到的字节，点一下就看清它被解成了什么——
   * 不用先接上设备，也不用先开一条通道。
   *
   * 用哪个插件解，由界面传 pluginId 决定（不传就按默认插件）。
   */
  router.post('/decode', async (req, res) => {
    const body = req.body ?? {};
    const hex = String(body.hex ?? '');
    if (!hex.trim()) {
      res.status(400).json({ error: '要解的十六进制不能为空' });
      return;
    }
    try {
      const frame = parseHex(hex);
      if (frame.length === 0) {
        res.status(400).json({ error: '要解的十六进制不能为空' });
        return;
      }
      const plugin = await findPlugin(String(body.pluginId ?? ''));
      const template = plugin
        ? await findTemplateById(plugin.protocolId)
        : await findTemplateById('');
      const decoded = plugin
        ? plugin.decode(frame)
        : decodeFrame(frame, template ?? RAW_TEMPLATE);
      res.json({ decoded });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: message || '解码失败' });
    }
  });

  return router;
}
