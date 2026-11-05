import type { GlobalQuota } from './quota/global-quota'
import type { MtQuota } from './quota/mt-quota'
import type { UserQuota } from './quota/user-quota'

export interface Env {
  DB: D1Database
  USER_QUOTA: DurableObjectNamespace<UserQuota>
  GLOBAL_QUOTA: DurableObjectNamespace<GlobalQuota>
  MT_QUOTA: DurableObjectNamespace<MtQuota>
  AI: Ai
  ASSETS: Fetcher
  DEEPSEEK_API_KEY: string
  PHAINON?: Fetcher
  PHAINON_BASE?: string
  GLOBAL_MONTHLY_LIMIT_CNY?: string
  DEFAULT_MONTHLY_LIMIT_CNY?: string
  BAIDU_APPID?: string
  BAIDU_KEY?: string
  BAIDU_MONTHLY_CHARS?: string
  FALLBACK_DAILY_CHARS?: string
}

export interface Identity {
  sub: string
  name?: string
  preferred_username?: string
  email?: string
  role?: 'user' | 'admin'
}

export type AppEnv = { Bindings: Env; Variables: { identity: Identity } }
