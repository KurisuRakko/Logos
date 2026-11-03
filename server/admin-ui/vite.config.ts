import { fileURLToPath } from 'node:url'

import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

import { mockApi } from './mock/mock-api.ts'
import { themeBootScript } from './vendor/rakko-design/react/src/theme/theme.ts'

/**
 * Logos 管理页：Worker 用 Workers Assets 托管 dist/，页面挂在 /admin/。
 * 产物输出到 dist/admin/，Worker 的 assets.directory = ./admin-ui/dist（见 server/SPEC.md）。
 *
 * vendor/ 里的外来件一律用绝对路径做 alias，避免相对 root 解析。
 * vendor/rakko-design/ 只能由 scripts/sync-design.sh 生成，不许手改（见 README.md）。
 */
const vendor = (rel: string) =>
  fileURLToPath(new URL(`./vendor/rakko-design/${rel}`, import.meta.url))

export default defineConfig(({ mode }) => ({
  base: '/admin/',
  // --mode mock：dev / preview 服务器里挂上 /admin/api/* 与 /auth/* 的模拟实现（只用于本地自测与截图）
  plugins: [
    react(),
    {
      // 首帧前定好 <html data-theme>，避免深色模式下先闪一帧浅色
      name: 'logos-admin:theme-boot',
      transformIndexHtml: () => [
        { tag: 'script', children: themeBootScript, injectTo: 'head' },
      ],
    },
    ...(mode === 'mock' ? [mockApi()] : []),
  ],
  resolve: {
    // 数组形式按顺序匹配：带 /styles.css 的键必须排在裸包名之前。
    alias: [
      {
        find: '@rakko/react/styles.css',
        replacement: vendor('react/src/styles.css'),
      },
      {
        find: '@rakko/react',
        replacement: vendor('react/src/index.ts'),
      },
      {
        find: '@rakko/design-system/tokens.css',
        replacement: vendor('tokens.generated.css'),
      },
      {
        // 指向无扩展名的 ripple：Vite 会解析到 ripple.js，tsc 则按同名声明找到 ripple.d.ts
        // （写成 ripple.js 会让 TS 跳过 .d.ts，报 TS7016）。tsconfig 的 paths 保持同一写法。
        find: '@rakko/design-system/ripple',
        replacement: vendor('design-system/src/ripple'),
      },
      {
        // 同上：LiftMenu 依赖的长按 / 右键手势
        find: '@rakko/design-system/context-action',
        replacement: vendor('design-system/src/context-action'),
      },
    ],
    dedupe: ['react', 'react-dom'],
  },
  build: {
    outDir: 'dist/admin',
    emptyOutDir: true,
  },
  server: {
    host: '127.0.0.1',
    port: 5310,
    strictPort: true,
  },
  preview: {
    host: '127.0.0.1',
    port: 5311,
    strictPort: true,
  },
}))
