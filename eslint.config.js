import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    rules: {
      // eslint-plugin-react-hooks@7 引入了 React Compiler 风格的检查。
      // 本项目未启用 React Compiler，这两条对常见写法误报，单独降级：
      // - refs：命令式工具栏在渲染期创建读取 ref 的回调（如 editorRef.current?.undo），
      //   行为正确，只是编译器无法证明它只在事件里执行
      // - set-state-in-effect：setMounted(true) 是 React 官方推荐的 SSR 水合写法
      'react-hooks/refs': 'warn',
      'react-hooks/set-state-in-effect': 'off',
      // shadcn/ui 官方生成的文件会同时导出组件和它的 cva 变体常量，
      // 这是 Fast Refresh 的已知例外，放行常量导出
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      // 以 _ 开头的参数视为「有意留空」：Express 的错误处理中间件必须写成四参
      // （少了 next 就不会被识别为错误处理器），TS 侧 noUnusedParameters 同样忽略这类参数
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
])
