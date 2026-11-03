/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Phainon 基址；未设置时用生产 https://api.rakko.cn。--mode mock 下为空串（同源 /auth/*）。 */
  readonly VITE_PHAINON_BASE?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
