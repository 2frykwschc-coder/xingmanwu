// 星漫屋 VIP 会员 — 固定收款码 + 点击自动开通(信任模式)
// 路由: /api/vip/*
//
// 流程:
//   用户: 选套餐 → 选微信/支付宝 → 看到对应收款码图片 + 应付金额 → 扫码转账
//         → 填交易单号(选填) 点「我已付款」→ **立即自动开通**(无人工核对)
//   站长: VIP 页底部「管理台」可事后抽查订单与实际到账是否相符
//
// 管理员识别: users 表 is_admin=1。系统无管理员时，第一个注册的用户自动成为管理员
// (通常就是你本人)。也可在下方 ADMIN_USERS 里写死用户名。
//
// 需要的静态资源: public/pay/wechat.jpg、public/pay/alipay.jpg (你自己的收款码截图)

const PLANS = {
  weekly:    { name: '周VIP', amount: 800,   days: 7,   desc: '星漫屋·周VIP会员' },
  monthly:   { name: '月VIP', amount: 2800,  days: 30,  desc: '星漫屋·月VIP会员' },
  quarterly: { name: '季VIP', amount: 8800,  days: 90,  desc: '星漫屋·季VIP会员' },
  yearly:    { name: '年VIP', amount: 18800, days: 365, desc: '星漫屋·年VIP会员' },
};

// 可选: 指定管理员用户名 (留空则用「第一个注册的用户」规则)
const ADMIN_USERS = new Set([]);

const QR_IMAGES = { wechat: '/pay/wechat.jpg', alipay: '/pay/alipay.jpg' };

function genOrderNo() {
  return 'XMW' + Date.now() + Math.floor(1000 + Math.random() * 9000);
}

// ── 数据库: 自动建表 ──
async function initTables(db) {
  await db.prepare(`CREATE TABLE IF NOT EXISTS vip_orders (
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
  )`).run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS vip_users (
    user_id INTEGER PRIMARY KEY,
    vip_until TEXT,
    updated_at TEXT
  )`).run();
  try { await db.prepare('ALTER TABLE users ADD COLUMN is_admin INTEGER DEFAULT 0').run(); } catch (e) { /* 已存在则忽略 */ }
}

// ── 鉴权: Bearer token → 用户(含 is_admin) ──
async function getUser(db, request) {
  const auth = request.headers.get('Authorization') || '';
  const token = auth.replace('Bearer ', '').trim();
  if (!token) return null;
  const s = await db.prepare('SELECT user_id FROM sessions WHERE token=?').bind(token).first();
  if (!s) return null;
  return db.prepare('SELECT id, username, is_admin FROM users WHERE id=?').bind(s.user_id).first() || null;
}

// ── 无管理员时, 第一个注册用户自动成为管理员 ──
async function ensureAdmin(db) {
  const c = await db.prepare('SELECT COUNT(*) AS n FROM users WHERE is_admin=1').first();
  if ((c && c.n) || 0) return;
  const first = await db.prepare('SELECT id FROM users ORDER BY id ASC LIMIT 1').first();
  if (first) await db.prepare('UPDATE users SET is_admin=1 WHERE id=?').bind(first.id).run();
}

async function isAdmin(db, user) {
  if (!user) return false;
  if (user.is_admin === 1) return true;
  if (ADMIN_USERS.has(user.username)) {
    await db.prepare('UPDATE users SET is_admin=1 WHERE id=?').bind(user.id).run();
    return true;
  }
  return false;
}

// ── 开通/续费 VIP (顺延) ──
async function grantVip(db, userId, planId, when) {
  const p = PLANS[planId];
  if (!p) return null;
  const now = new Date(when);
  const cur = await db.prepare('SELECT vip_until FROM vip_users WHERE user_id=?').bind(userId).first();
  let base = cur && cur.vip_until ? new Date(cur.vip_until) : now;
  if (base < now) base = now; // 已过期则从当前时间重新计算
  base.setUTCDate(base.getUTCDate() + p.days);
  const until = base.toISOString();
  if (cur) {
    await db.prepare('UPDATE vip_users SET vip_until=?, updated_at=? WHERE user_id=?')
      .bind(until, new Date().toISOString(), userId).run();
  } else {
    await db.prepare('INSERT INTO vip_users(user_id, vip_until, updated_at) VALUES(?,?,?)')
      .bind(userId, until, new Date().toISOString()).run();
  }
  return until;
}

// ── 确认到账统一处理 (幂等) ──
async function handlePaid(db, orderNo, platformOrder) {
  const order = await db.prepare('SELECT * FROM vip_orders WHERE order_no=?').bind(orderNo).first();
  if (!order) return { ok: false, reason: '订单不存在' };
  if (order.status === 'paid') return { ok: true, already: true, vip_until: order.vip_until };
  const when = new Date().toISOString();
  const until = await grantVip(db, order.user_id, order.plan, when);
  await db.prepare("UPDATE vip_orders SET status='paid', platform_order=?, paid_at=?, vip_until=? WHERE order_no=?")
    .bind(platformOrder || order.platform_order || '', when, until, orderNo).run();
  return { ok: true, vip_until: until };
}

// ════════════════════════════════════════════
// 入口
// ════════════════════════════════════════════
export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/api\/vip\/?/, '');
  const m = request.method;
  const db = env.DB;

  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
  };
  if (m === 'OPTIONS') return new Response(null, { headers: cors });
  const j = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

  try {
    await initTables(db);

    // -- GET /api/vip/plans (公开) --
    if (m === 'GET' && path === 'plans') {
      return j({
        plans: Object.entries(PLANS).map(([id, p]) => ({
          id, name: p.name, amount: p.amount, price: (p.amount / 100).toFixed(2), days: p.days, desc: p.desc,
        })),
        channels: { wechat: true, alipay: true },
        qr: QR_IMAGES,
        mode: 'manual', // 固定收款码, 人工核对后开通
      });
    }

    // -- GET /api/vip/me (登录后查 VIP 状态 + 是否管理员) --
    if (m === 'GET' && path === 'me') {
      const user = await getUser(db, request);
      if (!user) return j({ user: null, vip: null });
      await ensureAdmin(db);
      const admin = await isAdmin(db, user);
      const v = await db.prepare('SELECT vip_until FROM vip_users WHERE user_id=?').bind(user.id).first();
      let vip = null;
      if (v && v.vip_until) {
        const until = new Date(v.vip_until);
        if (until > new Date()) {
          vip = { active: true, until: v.vip_until, daysLeft: Math.max(0, Math.ceil((until - Date.now()) / 86400000)) };
        } else {
          vip = { active: false, until: v.vip_until, daysLeft: 0 };
        }
      }
      return j({ user: { id: user.id, username: user.username }, isAdmin: !!admin, vip });
    }

    // -- POST /api/vip/order {plan, channel} (登录) --
    if (m === 'POST' && path === 'order') {
      const user = await getUser(db, request);
      if (!user) return j({ error: '请先登录' }, 401);
      const body = await request.json();
      const plan = PLANS[body.plan];
      if (!plan) return j({ error: '无效的套餐' }, 400);
      if (body.channel !== 'wechat' && body.channel !== 'alipay') return j({ error: '无效的支付方式' }, 400);

      const orderNo = genOrderNo();
      await db.prepare(
        'INSERT INTO vip_orders(order_no,user_id,plan,amount,channel,status,created_at) VALUES(?,?,?,?,?,?,?)'
      ).bind(orderNo, user.id, body.plan, plan.amount, body.channel, 'pending', new Date().toISOString()).run();

      return j({ ok: true, order_no: orderNo, amount: plan.amount, plan: body.plan, channel: body.channel });
    }

    // -- POST /api/vip/order/:no/paid {pay_no?} (本人: 我已付款) --
    if (m === 'POST' && /^order\/.+\/paid$/.test(path)) {
      const user = await getUser(db, request);
      if (!user) return j({ error: '请先登录' }, 401);
      const orderNo = path.slice(6, -5);
      const order = await db.prepare('SELECT * FROM vip_orders WHERE order_no=?').bind(orderNo).first();
      if (!order) return j({ error: '订单不存在' }, 404);
      if (order.user_id !== user.id) return j({ error: '无权操作' }, 403);
      if (order.status === 'closed') return j({ error: '订单已关闭' }, 400);
      if (order.status === 'paid') return j({ ok: true, already: true, vip_until: order.vip_until });
      const body = await request.json().catch(() => ({}));
      const payNo = (body.pay_no || '').toString().slice(0, 80);
      // 自动开通(信任模式): 点「我已付款」立即开通, 站长事后在管理台抽查收款记录
      const r = await handlePaid(db, orderNo, payNo);
      if (!r.ok) return j({ error: r.reason }, 400);
      return j({ ok: true, already: false, vip_until: r.vip_until, message: '已自动开通' });
    }

    // -- GET /api/vip/order/:no (本人或管理员, 轮询用) --
    if (m === 'GET' && /^order\/.+/.test(path)) {
      const orderNo = path.slice(6);
      const user = await getUser(db, request);
      if (!user) return j({ error: '请先登录' }, 401);
      await ensureAdmin(db);
      const admin = await isAdmin(db, user);
      const order = await db.prepare('SELECT * FROM vip_orders WHERE order_no=?').bind(orderNo).first();
      if (!order) return j({ error: '订单不存在' }, 404);
      if (order.user_id !== user.id && !admin) return j({ error: '无权查看' }, 403);
      return j({
        order_no: order.order_no, plan: order.plan, amount: order.amount, channel: order.channel,
        status: order.status, platform_order: order.platform_order || '',
        vip_until: order.vip_until, paid_at: order.paid_at, created_at: order.created_at,
      });
    }

    // -- GET /api/vip/orders/mine (登录用户: 我的最近订单) --
    if (m === 'GET' && path === 'orders/mine') {
      const user = await getUser(db, request);
      if (!user) return j({ error: '请先登录' }, 401);
      const { results } = await db.prepare(
        'SELECT order_no, plan, amount, channel, status, platform_order, vip_until, created_at, paid_at FROM vip_orders WHERE user_id=? ORDER BY id DESC LIMIT 10'
      ).bind(user.id).all();
      return j(results);
    }

    // -- GET /api/vip/admin/orders (管理员: 订单列表) --
    if (m === 'GET' && path === 'admin/orders') {
      const user = await getUser(db, request);
      if (!user) return j({ error: '请先登录' }, 401);
      await ensureAdmin(db);
      if (!(await isAdmin(db, user))) return j({ error: '无权访问' }, 403);
      const { results } = await db.prepare(
        `SELECT o.order_no, o.user_id, o.plan, o.amount, o.channel, o.status, o.platform_order,
                o.vip_until, o.created_at, o.paid_at, u.username
         FROM vip_orders o LEFT JOIN users u ON u.id = o.user_id
         ORDER BY (o.status='pending') DESC, o.id DESC LIMIT 50`
      ).all();
      return j(results);
    }

    // -- POST /api/vip/admin/verify {order_no} (管理员: 已到账, 开通) --
    if (m === 'POST' && path === 'admin/verify') {
      const user = await getUser(db, request);
      if (!user) return j({ error: '请先登录' }, 401);
      await ensureAdmin(db);
      if (!(await isAdmin(db, user))) return j({ error: '无权访问' }, 403);
      const body = await request.json();
      if (!body.order_no) return j({ error: '缺少 order_no' }, 400);
      const r = await handlePaid(db, body.order_no);
      if (!r.ok) return j({ error: r.reason }, 400);
      return j({ ok: true, already: !!r.already, vip_until: r.vip_until });
    }

    // -- POST /api/vip/admin/close {order_no} (管理员: 关闭订单, 未到账/退款) --
    if (m === 'POST' && path === 'admin/close') {
      const user = await getUser(db, request);
      if (!user) return j({ error: '请先登录' }, 401);
      await ensureAdmin(db);
      if (!(await isAdmin(db, user))) return j({ error: '无权访问' }, 403);
      const body = await request.json();
      if (!body.order_no) return j({ error: '缺少 order_no' }, 400);
      await db.prepare("UPDATE vip_orders SET status='closed' WHERE order_no=? AND status='pending'").bind(body.order_no).run();
      return j({ ok: true });
    }

    return j({ error: 'not found' }, 404);
  } catch (e) {
    return j({ error: e.message }, 500);
  }
}
