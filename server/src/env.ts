import type { GlobalQuota } from './quota/global-quota'
import type { UserQuota } from './quota/user-quota'

export interface Env {
  DB: D1Database
  USER_QUOTA: DurableObjectNamespace<UserQuota>
  GLOBAL_QUOTA: DurableObjectNamespace<GlobalQuota>
  ASSETS: Fetcher
  DEEPSEEK_API_KEY: string
  PHAINON?: Fetcher
  PHAINON_BASE?: string
  GLOBAL_MONTHLY_LIMIT_CNY?: string
  DEFAULT_MONTHLY_LIMIT_CNY?: string
}

export interface Identity {
  sub: string
  name?: string
  preferred_username?: string
  email?: string
  role?: 'user' | 'admin'
}

export type AppEnv = { Bindings: Env; Variables: { identity: Identity } }
