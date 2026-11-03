-- 失败原因：upstream_<HTTP 状态>、upstream_timeout、upstream_network、stream_interrupted 等；成功为 NULL。
ALTER TABLE usage_log ADD COLUMN error TEXT;

-- 客户端上传的运行日志，保留 30 天（cron 每日清理）。created_at 为服务端接收时刻（Unix 秒）。
CREATE TABLE client_logs (
  id INTEGER PRIMARY KEY,
  sub TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  level TEXT NOT NULL,
  event TEXT NOT NULL,
  message TEXT NOT NULL,
  context TEXT,
  app_version TEXT,
  os TEXT,
  client_time TEXT
);

CREATE INDEX client_logs_sub_created ON client_logs(sub, created_at);
CREATE INDEX client_logs_created ON client_logs(created_at);
