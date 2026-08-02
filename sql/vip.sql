-- 星漫屋 VIP 会员支付 — D1 迁移
-- 执行: npx wrangler d1 execute xingmanwu --remote --file=sql/vip.sql
-- (运行时 functions/api/vip/[[path]].js 也会自动建表, 此文件用于手动初始化)

CREATE TABLE IF NOT EXISTS vip_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_no TEXT UNIQUE NOT NULL,
  user_id INTEGER NOT NULL,
  plan TEXT NOT NULL,
  amount INTEGER NOT NULL,
  channel TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  qr_content TEXT,
  platform_order TEXT,
  vip_until TEXT,
  created_at TEXT,
  paid_at TEXT
);

CREATE TABLE IF NOT EXISTS vip_users (
  user_id INTEGER PRIMARY KEY,
  vip_until TEXT,
  updated_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_vip_orders_user ON vip_orders(user_id);
CREATE INDEX IF NOT EXISTS idx_vip_orders_status ON vip_orders(status);
