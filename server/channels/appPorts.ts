/**
 * 本应用自己占着的端口。
 *
 * 网口监听要占一个端口去接设备。占的端口如果正好是应用自己的，
 * 后果不是「监听失败」，而是「网页自己打不开了」——
 * 浏览器发来的请求全被自己那个原始 TCP 监听接走（它说的是 JT/T 808，不是 HTTP），
 * 页面永远转圈，连那个监听都关不掉：关它也得先连得上服务端。
 *
 * 这个坑踩过一次：有人把网口监听开到 8080，而 8080 正是前端开发服务器的端口。
 * 所以开监听之前先对一遍——应用自己的端口，一律不给占。
 */
import { DEFAULT_API_PORT, DEFAULT_WEB_PORT } from '../../shared/constants.ts';
import { envValue } from '../env.ts';

/** 应用占着的端口，以及它是干什么的 */
export interface ReservedPort {
  /** 端口号 */
  port: number;
  /** 这个端口在本应用里是干什么的 */
  what: string;
}

/**
 * 本进程占着的端口。
 *
 * 开发态：前端跑在 Vite 上（默认 8080），API 是另一个进程（默认 8787）——两个都得让开。
 * 打包态：前端由 API 服务端自己发（dist 静态资源），两个是同一个端口。
 */
export function reservedAppPorts(): ReservedPort[] {
  const ports: ReservedPort[] = [];

  const api = Number(envValue('PORT') || DEFAULT_API_PORT);
  if (Number.isFinite(api) && api > 0) {
    ports.push({ port: api, what: '网页与 API 服务' });
  }

  // 开发态才有前端开发服务器；打包态它不存在，那个端口空着，不必拦
  if (process.env.NODE_ENV !== 'production') {
    const web = Number(envValue('WEB_PORT') || DEFAULT_WEB_PORT);
    if (Number.isFinite(web) && web > 0 && web !== api) {
      ports.push({ port: web, what: '前端开发服务器' });
    }
  }

  return ports;
}

/**
 * 这个端口是不是应用自己的。
 *
 * @param port 端口号
 * @returns 占着这个端口的是谁；没人占返回 null
 */
export function appPortOwner(port: number): ReservedPort | null {
  return reservedAppPorts().find((p) => p.port === port) ?? null;
}
