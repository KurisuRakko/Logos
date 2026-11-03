# logos-api 规格（实现依据，改接口先改这里）

Cloudflare Worker，生产域名 `https://logos-api.rakko.cn`，代码在本仓库 `server/`。
职责：替 Logos 用户转发翻译请求到 DeepSeek，按人计额度。DeepSeek key 只存在 Worker secret。

## 身份

- 登录走 Phainon 原生流（app_id = `logos`，强制 S256 PKCE）：
  `GET https://api.rakko.cn/auth/login?app_id=logos&return_to=<url>&state=<s>&code_challenge=<c>&code_challenge_method=S256`
  → 回跳 `<return_to>#login_code=…&state=…` → `POST https://api.rakko.cn/auth/exchange {login_code, code_verifier}`
  → `{access_token, refresh_token, ...}`（access 15 分钟，refresh 30 天、轮换）。
  续期 `POST https://api.rakko.cn/auth/refresh {refresh_token}`。
- 回跳地址：桌面端 `http://127.0.0.1:25885/`（固定端口），管理页 `https://logos-api.rakko.cn/admin/`。
- 谁能用：Priestess 应用访问规则（默认拒绝，放行「Logos」用户组，管理员恒放行）。Phainon 在发登录码与 refresh 时执行规则，规则变更会撤销会话。
- Worker 校验：`Authorization: Bearer <access_token>` → `GET https://api.rakko.cn/auth/me`（转发同一 Bearer），
  返回 `{app_id, user: {sub, name?, preferred_username?, email?, role?: 'user'|'admin'}}`。
  必须 `app_id === 'logos'`，否则 401。结果按 sha256(token) 缓存 60 秒（Cache API 或 isolate 内存均可）。
  Phainon 基址用 var `PHAINON_BASE`（默认 `https://api.rakko.cn`）。
  优先经 service binding `PHAINON`（service `phainon`）发出该请求，避免同 zone Worker 访问 custom domain 被拒（error 1042）；未配置 binding 时回退全局 fetch。

## 计价与额度

- 模型 `deepseek-flash`，请求体带 `thinking: {type: "disabled"}`，`stream: true`，`stream_options: {include_usage: true}`，`max_tokens` 4096。
- 价格（元/百万 token，源：api-docs.deepseek.com/zh-cn/quick_start/pricing，2026-11-03）：
  缓存命中输入 0.04 / 0.02，未命中输入 2 / 1，输出 8 / 4（高峰 / 空闲）。
  高峰 = 北京时间周一至周五 9:00–12:00、14:00–18:00；法定节假日不维护，按高峰计。价格表写成一个常量模块。
- 记账单位：微元（整数，1 元 = 1,000,000）。默认每人每月 10 元；单人可覆盖。月份按北京时间自然月，1 日 0 点清零。
- 全局保险丝：全站每月合计上限 var `GLOBAL_MONTHLY_LIMIT_CNY`（默认 200），到顶后所有人拒绝。
- 每用户一个 Durable Object（`UserQuota`，id = idFromName(sub)），负责：
  1. 限频：每分钟 30 次（滑动或固定窗口均可）。
  2. 预扣：按 `ceil(输入字符数 × 2) 输入 token（按未命中高峰价）+ 4096 输出 token（高峰价）` 预扣；余额不足拒绝。
  3. 结算：按 DeepSeek 返回的 usage（prompt_cache_hit_tokens / prompt_cache_miss_tokens / completion_tokens）与请求开始时刻的峰谷价计实际花费，退回差额。上游请求失败（网络错误或非 2xx）或未输出任何内容即中断时全额退回。
  全局保险丝用一个单例 DO（`GlobalQuota`）同样预扣/结算。
- 单次原文上限 5000 字符，超出 400。
- 已知且有上界的计费偏差：
  1. 预扣只按原文估算输入，不含 system prompt，结算按实际 usage，因此单人或全站的月度结算额可略超上限（超出不超过一次请求的 system prompt 费用）。
  2. 上游已输出内容后中途断流、拿不到 usage 时，按预扣额结算（不低于实际花费）。
  3. 客户端断开后 Worker 在 `waitUntil` 宽限内继续读上游并结算；输出超过宽限而未结算的预扣，由 15 分钟后的 alarm 按预扣额结算。
  4. 用户 DO 与全局 DO 的结算任一方失败时不退回，失败一方的预扣同样由 alarm 按预扣额结算。

## 接口

所有 JSON 错误统一 `{error: {code, message}}`，message 用正式书面中文。

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/v1/translate` | 鉴权。body `{text, from, to}`（from 可为 `auto`；语言用 Logos 的语言 key，如 `zh_cn`、`en`、`ja`）。返回 `text/event-stream`：若干 `data: {"delta":"…"}`，最后 `data: {"done":true,"cost_micro":n,"remaining_ratio":0..1}`。错误在开流前用 JSON + HTTP 状态返回。 |
| GET | `/v1/quota` | 鉴权。`{limit_micro, used_micro, remaining_ratio, resets_at}`（resets_at 为 ISO 时间）。 |
| GET | `/admin/` | 管理页静态资源（Workers Assets）。 |
| GET | `/admin/api/users` | 鉴权且 `role === 'admin'`。本月每个有记录或有设置的用户：`[{sub, display_name, limit_micro, used_micro, disabled, last_used_at}]`，外加 `{global: {limit_micro, used_micro}}`。 |
| PATCH | `/admin/api/users/:sub` | admin。body `{limit_micro?: number|null, disabled?: boolean, display_name?: string}`（null 表示恢复默认额度）。 |
| GET | `/admin/api/usage?sub=&limit=` | admin。最近明细。 |

错误码：`unauthorized`(401)、`forbidden`(403)、`user_disabled`(403)、`quota_exhausted`(402)、`global_quota_exhausted`(503)、`rate_limited`(429)、`text_too_long`(400)、`upstream_error`(502)。

## D1（binding `DB`）

```sql
CREATE TABLE user_settings (sub TEXT PRIMARY KEY, display_name TEXT, limit_micro INTEGER, disabled INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL);
CREATE TABLE usage_log (id INTEGER PRIMARY KEY AUTOINCREMENT, sub TEXT NOT NULL, month TEXT NOT NULL, created_at INTEGER NOT NULL,
  cache_hit_tokens INTEGER NOT NULL, cache_miss_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL, cost_micro INTEGER NOT NULL, ok INTEGER NOT NULL);
CREATE INDEX usage_log_sub_month ON usage_log(sub, month);
```
DO 是额度的权威；usage_log 只供展示。DO 读取单人额度覆盖/停用状态时从 D1 取并短时缓存（≤60 秒），管理页 PATCH 后应让对应 DO 失效缓存。

## Secrets / vars

- secret `DEEPSEEK_API_KEY`
- var `PHAINON_BASE`、`GLOBAL_MONTHLY_LIMIT_CNY`、`DEFAULT_MONTHLY_LIMIT_CNY`（默认 10）

## 翻译提示词

system：将用户提供的文本从 {from} 翻译为 {to}（from 为 auto 时自动识别），只输出译文，不解释、不加引号，保留原有换行与格式。语言 key 映射成中文语言名。

## CORS 与目录约定

- `/v1/*` 允许来源：`tauri://localhost`、`https://tauri.localhost`、`http://localhost:1420`、`http://127.0.0.1:5297`、`http://100.114.125.104:5297`（demo），允许头 `Authorization, Content-Type`。`/admin/*` 同源，不开 CORS。
- 目录：`server/src`、`server/test`、`server/migrations`（Worker，块 A）；`server/admin-ui`（管理页 Vite 工程，块 B，`base: '/admin/'`，产物输出到 `server/admin-ui/dist/admin/`，Worker 的 assets.directory = `./admin-ui/dist`）；
  `server/phainon/0101_logos_app.sql`（Phainon 迁移草稿，块 A 写，不放进 Phainon 仓库）；Logos 客户端改动在 `src/`、`src-tauri/`（块 C）。
- Phainon 侧 logos 应用：allowed_return_urls `["http://127.0.0.1:25885/","https://logos-api.rakko.cn/admin/"]`，allowed_origins `["http://127.0.0.1:25885","https://logos-api.rakko.cn"]`，require_pkce 1，everyone-deny + 放行用户组「Logos」（组需先在管理台建或迁移里建，照 0082/0083/0097 的写法）。

## 返回形态补充（2026-11-03 定）

- 对外返回的时间字段（last_used_at、created_at、resets_at）一律 ISO 8601 字符串；D1 内部存 Unix 秒。
- `GET /admin/api/users` → `{users: [{sub, display_name, limit_micro, limit_is_default, used_micro, disabled, last_used_at}], global: {limit_micro, used_micro}}`；`limit_micro` 为实际生效额度，`limit_is_default` 表示未覆盖；`disabled` 为 boolean，`last_used_at` 可为 null。
- `GET /admin/api/usage?sub=&limit=` → `{items: [{id, sub, created_at, cache_hit_tokens, cache_miss_tokens, output_tokens, cost_micro, ok}]}`，`ok` 为 boolean，按 created_at 倒序，limit 默认 50、上限 500。
- `/auth/exchange` 由 Phainon 返回，客户端以其 `expires_in` 为准，缺省按 900 秒。
