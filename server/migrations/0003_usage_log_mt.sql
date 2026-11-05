-- /v1/mt 机器翻译记录：provider 为 baidu / fallback（DeepSeek 翻译为 NULL），chars 为计费字符数（DeepSeek 翻译为 NULL）。
ALTER TABLE usage_log ADD COLUMN provider TEXT;
ALTER TABLE usage_log ADD COLUMN chars INTEGER;
