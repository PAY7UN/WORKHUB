import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_API_PORT, DEFAULT_WEB_PORT } from '../../shared/constants.ts';
import { appPortOwner, reservedAppPorts } from './appPorts.ts';
import { ConfigError } from './config.ts';
import { ChannelManager } from './manager.ts';

/**
 * 应用实际在用的端口。
 *
 * 不能直接拿 DEFAULT_API_PORT 当准数：服务端配置一加载就会把 .env 读进
 * process.env，WORKHUB_PORT 会顶掉默认值（这个仓库的 .env 写的是 8789）。
 */
function apiPort(): number {
  return Number(process.env.WORKHUB_PORT || DEFAULT_API_PORT);
}

function webPort(): number {
  return Number(process.env.WORKHUB_WEB_PORT || DEFAULT_WEB_PORT);
}

test('应用自己的端口一律列出来，别让人把监听开到那儿去', () => {
  const ports = reservedAppPorts();
  assert.ok(
    ports.some((p) => p.port === apiPort()),
    'API 端口必须在保留列表里',
  );
  // 开发态还有前端开发服务器；打包态它不存在，不必拦
  if (process.env.NODE_ENV !== 'production') {
    assert.ok(
      ports.some((p) => p.port === webPort()),
      '开发态的前端端口必须在保留列表里',
    );
  }
});

test('查端口是谁占的：没人占就说没人占', () => {
  assert.equal(appPortOwner(apiPort())?.port, apiPort());
  assert.equal(appPortOwner(1), null);
});

test('网口监听占用了应用自己的端口就得拦住：否则网页会被自己的监听堵死', async () => {
  const manager = new ChannelManager();
  await assert.rejects(
    manager.start({
      tool: 'tcp',
      config: { mode: 'listen', host: '127.0.0.1', port: String(apiPort()) },
    }),
    (err: unknown) => {
      assert.ok(err instanceof ConfigError, '该报配置错误，而不是别的');
      assert.match(err.message, /本应用自己用的/);
      return true;
    },
  );
});

test('主动连出去不受这条限制：连的是对方的端口，不是占自己的', async () => {
  const manager = new ChannelManager();
  const session = await manager
    .start({
      tool: 'tcp',
      config: { mode: 'connect', host: '127.0.0.1', port: String(apiPort()) },
    })
    .catch((err: unknown) => {
      // 连不上是正常的（那个端口上不是协议对端），但不能是被「端口保留规则」拦下的
      assert.ok(!(err instanceof ConfigError), '不该被端口保留规则拦下');
      return null;
    });
  if (session) await manager.stop(session.id);
});
