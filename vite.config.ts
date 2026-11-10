import path from "path"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig, loadEnv } from "vite"
import { DEFAULT_API_PORT } from "./shared/constants.ts"

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  // 与服务端共用 .env 的 WORKHUB_PORT，避免代理端口写死后无法调整。
  // 进程环境变量优先于 .env 文件：这样可以在不改动 .env 的前提下，
  // 临时把前端指到另一个 API 实例（如并行跑一个测试库）。
  // 旧名 MDHUB_ 仍然加载：改名前写下的 .env 不该就此失效。
  const env = loadEnv(mode, process.cwd(), ["WORKHUB_", "MDHUB_"])
  const apiPort =
    process.env.WORKHUB_PORT || process.env.MDHUB_PORT || env.WORKHUB_PORT || env.MDHUB_PORT || String(DEFAULT_API_PORT)
  // 前端 dev server 端口与后端 API 端口是两回事：前者决定「别人在浏览器里输哪个地址」，
  // 后者只被本机代理访问。默认值取 8080 而不是 vite 默认的 5173，因为路由器的
  // 端口转发规则已按 8080 配置，写死在这里省掉每次改转发规则的麻烦。
  const webPort = Number(env.WORKHUB_WEB_PORT || env.MDHUB_WEB_PORT || 8080)

  return {
    base: './',
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "./src"),
      },
    },
    build: {
      // 单包 1.5MB 意味着业务代码一改，用户就得重下整个应用。
      // 拆成「很少变的依赖」和「常变的业务代码」两块，
      // 前者靠内容哈希长期命中缓存，后者小到改动后重传也无所谓。
      rollupOptions: {
        output: {
          manualChunks(id: string) {
            // Rollup 给 CJS 包生成的互操作助手（react / react-dom 都靠它取默认导出）。
            // 它必须和 react 待在同一块：一旦它落进 vendor，vendor 与 vendor-react
            // 就互相 import，构建时会出现循环依赖警告，运行时还可能撞上 TDZ。
            if (id.includes("commonjsHelpers")) return "vendor-react"
            if (!id.includes("node_modules")) return undefined
            // 代码编辑器：最重的一块，而且只在打开编辑器时才需要
            if (id.includes("@codemirror") || id.includes("@lezer")) return "vendor-codemirror"
            if (id.includes("@radix-ui")) return "vendor-radix"
            if (id.includes("lucide-react")) return "vendor-icons"
            // react 必须和 react-dom 待在一个 chunk：拆开会出现循环依赖警告
            if (/[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(id)) return "vendor-react"
            return "vendor"
          },
        },
      },
      chunkSizeWarningLimit: 800,
    },
    server: {
      // host: true 等价于监听 0.0.0.0。不设时 Vite 只绑 localhost，
      // 局域网内其他设备访问会直接连接被拒——这是「本地能开、别人打不开」最常见的原因
      host: true,
      port: webPort,
      // 端口被占用时直接报错，而不是静默换到 8081：静默换端口会让用户拿着
      // 旧地址敲半天打不开，而错误信息里已经写明了该关掉什么
      strictPort: true,
      // 局域网设备用 IP 访问，Host 头不是 localhost。Vite 默认放行 IP 形式的
      // Host，这里显式列出以免升级后收紧默认策略时突然拒绝内网访问
      allowedHosts: true,
      proxy: {
        // 前端统一走同源 /api，由 Vite 转发到 Node 服务端
        '/api': {
          target: `http://localhost:${apiPort}`,
          changeOrigin: true,
        },
      },
    },
  };
});
