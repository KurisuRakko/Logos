-- 单人设置：额度覆盖（NULL = 默认额度）、停用、管理页显示名。
CREATE TABLE user_settings (
  sub TEXT PRIMARY KEY,
  display_name TEXT,
  limit_micro INTEGER,
  disabled INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

-- 调用明细，只供管理页展示；额度以 Durable Object 为准。
CREATE TABLE usage_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sub TEXT NOT NULL,
  month TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  cache_hit_tokens INTEGER NOT NULL,
  cache_miss_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cost_micro INTEGER NOT NULL,
  ok INTEGER NOT NULL
);

CREATE INDEX usage_log_sub_month ON usage_log(sub, month);
