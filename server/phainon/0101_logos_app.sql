-- Logos（桌面翻译，服务端 logos-api.rakko.cn 在 Cloudflare Workers）接入 Priestess 原生流。
-- 桌面端走固定回环端口 http://127.0.0.1:25885/ 收 #login_code；管理页在 https://logos-api.rakko.cn/admin/。
-- 两端都走 /auth/login → #login_code → /exchange，强制 state + S256 PKCE（0090）。
-- 后端用 access token 调 /me 校验 app_id = logos，管理接口再看 role = admin。
-- 默认关闭：落 everyone-deny（管理员恒被放行），再放行用户组「Logos」；组不存在则在这里建好（成员去管理台加）。

INSERT INTO apps (
  app_id,
  name,
  allowed_origins,
  allowed_return_urls,
  enabled,
  require_pkce,
  created_at,
  updated_at
)
VALUES (
  'logos',
  'Logos',
  '["http://127.0.0.1:25885","https://logos-api.rakko.cn"]',
  '["http://127.0.0.1:25885/","https://logos-api.rakko.cn/admin/"]',
  1,
  1,
  CAST(strftime('%s', 'now') AS INTEGER),
  CAST(strftime('%s', 'now') AS INTEGER)
)
ON CONFLICT(app_id) DO UPDATE SET
  name = excluded.name,
  allowed_origins = excluded.allowed_origins,
  allowed_return_urls = excluded.allowed_return_urls,
  enabled = 1,
  require_pkce = 1,
  updated_at = excluded.updated_at;

DELETE FROM app_origins
WHERE app_id = 'logos';

INSERT OR IGNORE INTO app_origins (app_id, origin)
VALUES
  ('logos', 'http://127.0.0.1:25885'),
  ('logos', 'https://logos-api.rakko.cn');

-- 分组名唯一（0082）：管理台已建过「Logos」就沿用那一组，不重复建。
INSERT INTO auth_local_user_groups (group_id, name, description, created_at, updated_at)
VALUES (
  'plg_logos',
  'Logos',
  'Logos 翻译服务的使用者',
  CAST(strftime('%s', 'now') AS INTEGER),
  CAST(strftime('%s', 'now') AS INTEGER)
)
ON CONFLICT(name) DO NOTHING;

INSERT INTO auth_local_app_access_rules (
  rule_id,
  app_id,
  subject_type,
  subject_id,
  effect,
  created_at,
  created_by
)
VALUES ('logos:everyone:deny', 'logos', 'everyone', '*', 'deny', CAST(strftime('%s', 'now') AS INTEGER), NULL)
ON CONFLICT(app_id, subject_type, subject_id) DO NOTHING;

INSERT INTO auth_local_app_access_rules (
  rule_id,
  app_id,
  subject_type,
  subject_id,
  effect,
  created_at,
  created_by
)
SELECT 'logos:group:logos:allow', 'logos', 'group', group_id, 'allow', CAST(strftime('%s', 'now') AS INTEGER), NULL
FROM auth_local_user_groups
WHERE name = 'Logos'
ON CONFLICT(app_id, subject_type, subject_id) DO NOTHING;
