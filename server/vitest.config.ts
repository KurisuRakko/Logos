import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin'
import { defineConfig } from 'vitest/config'

export default defineConfig(async () => {
  const migrations = await readD1Migrations('./migrations')
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: './wrangler.jsonc' },
        // 不连远端：AI binding 只能远端访问，测试里在 env 上换成 mock（见 test/mt.test.ts）。
        remoteBindings: false,
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            DEEPSEEK_API_KEY: 'test-deepseek-key',
            PHAINON_BASE: 'https://phainon.test'
          },
          // wrangler.jsonc 里的 PHAINON 指向线上 Worker，测试里换成占位；用例在 env 上把它去掉走全局 fetch 回退。
          serviceBindings: {
            PHAINON: () => new Response('PHAINON binding is not available in tests', { status: 500 })
          }
        }
      })
    ],
    test: {
      setupFiles: ['./test/setup.ts']
    }
  }
})
