import { applyD1Migrations, env } from 'cloudflare:test'

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS)

// 默认去掉 PHAINON service binding，让 /auth/me 走被 mock 的全局 fetch。
delete (env as { PHAINON?: Fetcher }).PHAINON
