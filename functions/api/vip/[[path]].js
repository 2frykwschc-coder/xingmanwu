// 星漫屋 VIP 会员 — 固定收款码 + 人工核对开通(防白嫖)
// 路由: /api/vip/*
//
// 流程:
//   用户: 选套餐 → 选微信/支付宝 → 看到对应收款码图片 + 应付金额 → 扫码转账
//         → 填交易单号 点「我已付款」→ 状态=待核对
//   站长: VIP 页底部「管理台」→ 看到待核对订单(用户/套餐/金额/单号) → 对照自己收款记录
//         → 点「已到账，开通」→ 系统按套餐天数顺延 VIP(幂等)。未到账点「关闭」。
//
// ⚠ 原理: 个人固定收款码无法自动验单(微信/支付宝不回调网站)。
//   要“自动验单+零白嫖”只能换商户版 API(需个体户执照): 微信 Native/支付宝当面付,
//   到账后服务器收到异步通知才开通。拿到执照/商户号后可无缝切换。
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

// ═══ 码支付 / 易支付 聚合支付配置 ══════════════════════════════════════════
// enabled=true 后: 下单即向平台提交订单 → 返回「动态二维码」给用户扫;
// 用户付款成功后平台 POST 异步通知本域名 /api/vip/pay/notify, 验签+金额校验通过才自动开通 VIP。
// 参数在平台后台「商户信息/对接文档」里: pid=商户ID, key=商户密钥, gateway=下单接口地址。
const MPAY = {
  enabled: false,          // ← 配置好下面参数后改成 true 即启用; false = 维持固定码人工核对
  gateway: '',             // 下单网关, 例: 'https://你的平台域名/submit.php'
  pid: '',                 // 商户ID
  key: '',                 // 商户密钥
  typeMap: { wechat: 'wxpay', alipay: 'alipay' }, // 渠道代码, 以平台文档为准
};

// ── MD5 纯 JS 实现 (Workers 无内置 MD5, 公开领域算法) ──
function md5Hex(msg){
  const K=[],s=[],si=[7,12,17,22,5,9,14,20,4,11,16,23,6,10,15,21];
  for(let i=0;i<64;i++){K[i]=Math.floor(Math.abs(Math.sin(i+1))*4294967296)>>>0;s[i]=si[((i/16)|0)*4+(i%4)]}
  const F=(x,y,z)=>(x&y)|(~x&z), G=(x,y,z)=>(x&z)|(y&~z), H=(x,y,z)=>x^y^z, I=(x,y,z)=>y^(x|~z);
  const rol=(x,c)=>((x<<c)|(x>>>(32-c)))>>>0;
  const data=new TextEncoder().encode(msg);
  const bitLen=data.length*8;
  const w=[...data,0x80];
  while(w.length%64!==56)w.push(0);
  const low=bitLen>>>0, high=Math.floor(bitLen/4294967296);
  for(let i=0;i<4;i++)w.push((low>>>(8*i))&0xff);
  for(let i=0;i<4;i++)w.push((high>>>(8*i))&0xff);
  let a0=0x67452301,b0=0xefcdab89,c0=0x98badcfe,d0=0x10325476;
  for(let off=0;off<w.length;off+=64){
    const M=[];
    for(let i=0;i<16;i++){M[i]=((w[off+i*4])|(w[off+i*4+1]<<8)|(w[off+i*4+2]<<16)|(w[off+i*4+3]<<24))>>>0}
    let A=a0,B=b0,C=c0,D=d0;
    for(let i=0;i<64;i++){
      let f,g;
      if(i<16){f=F(B,C,D);g=i}
      else if(i<32){f=G(B,C,D);g=(5*i+1)%16}
      else if(i<48){f=H(B,C,D);g=(3*i+5)%16}
      else {f=I(B,C,D);g=(7*i)%16}
      f=(f+A+K[i]+M[g])>>>0;
      A=D;D=C;C=B;
      B=(B+rol(f,s[i]))>>>0;
    }
    a0=(a0+A)>>>0;b0=(b0+B)>>>0;c0=(c0+C)>>>0;d0=(d0+D)>>>0;
  }
  const hex=n=>{let h='';for(let i=0;i<4;i++)h+=((n>>>(i*8))&0xff).toString(16).padStart(2,'0');return h};
  return hex(a0)+hex(b0)+hex(c0)+hex(d0);
}

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

  // ═══ 码支付签名/下单/验签 ═══
  // 签名规则(易支付/码支付通用): 除 sign/sign_type 外全部参数按参数名 ASCII 升序,
  // 以 k=v&k2=v2 拼接, 末尾追加 &key=商户密钥, 再取 MD5(小写)。以你平台文档为准, 不对就调这里。
  function mpaySign(params) {
    const ks = Object.keys(params).filter(k => k !== 'sign' && k !== 'sign_type' && params[k] !== '' && params[k] != null).sort();
    return md5Hex(ks.map(k => k + '=' + params[k]).join('&') + '&key=' + MPAY.key).toLowerCase();
  }
  function mpayVerify(params) {
    if (!params || !params.sign) return false;
    return mpaySign(params) === String(params.sign).toLowerCase();
  }
  async function mpaySubmit(orderNo, amountFen, name, channel) {
    try {
      const origin = url.origin;
      const params = {
        pid: MPAY.pid,
        type: MPAY.typeMap[channel] || 'alipay',
        out_trade_no: orderNo,
        notify_url: origin + '/api/vip/pay/notify',
        return_url: origin + '/',
        name: name + ' ' + orderNo,
        money: (amountFen / 100).toFixed(2),
        sign_type: 'MD5',
      };
      params.sign = mpaySign(params);
      const body = Object.keys(params).map(k => k + '=' + encodeURIComponent(params[k])).join('&');
      const r = await fetch(MPAY.gateway, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      });
      const txt = await r.text();
      try {
        const d = JSON.parse(txt);
        if (d && String(d.code) === '1' && (d.pay_url || d.qrcode || d.url)) {
          return { ok: true, pay_url: d.pay_url || d.qrcode || d.url, trade_no: d.trade_no || '' };
        }
        return { ok: false, reason: '平台返回: ' + String(d.msg || txt).slice(0, 200) };
      } catch (e) {
        return { ok: false, reason: '网关非JSON(可能需按文档调参): ' + txt.slice(0, 200) };
      }
    } catch (e) {
      return { ok: false, reason: e.message };
    }
  }


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
        mode: MPAY.enabled ? 'auto' : 'manual', // auto=码支付自动验单; manual=固定码站长核对
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

      // 码支付模式: 同步向平台下单, 返回动态二维码内容
      if (MPAY.enabled) {
        const mp = await mpaySubmit(orderNo, plan.amount, plan.desc, body.channel);
        if (!mp.ok) return j({ ok: false, error: '支付平台下单失败: ' + mp.reason }, 502);
        return j({
          ok: true, order_no: orderNo, amount: plan.amount, plan: body.plan, channel: body.channel,
          mpay: true, pay_url: mp.pay_url, trade_no: mp.trade_no,
        });
      }

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
      // 防白嫖: 仅记录“已提交付款”, 等站长在管理台核对真实到账后点「已到账，开通」才发 VIP
      await db.prepare('UPDATE vip_orders SET platform_order=? WHERE order_no=?').bind(payNo, orderNo).run();
      return j({ ok: true, message: '已提交，等待站长核对到账后自动开通' });
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

    // -- POST /api/vip/pay/notify (码支付异步到账通知: 验签→金额校验→自动开通, 防白嫖) --
    if (m === 'POST' && path === 'pay/notify') {
      if (!MPAY.enabled) return j({ error: 'not enabled' }, 404);
      const raw = await request.text().catch(() => '');
      const params = {};
      try { new URLSearchParams(raw).forEach((v, k) => { params[k] = v; }); } catch (e) {}
      if (!Object.keys(params).length && raw) { try { Object.assign(params, JSON.parse(raw)); } catch (e) {} }
      const okSign = mpayVerify(params);
      const status = params.trade_status || 'TRADE_SUCCESS';
      if (!okSign || String(status) !== 'TRADE_SUCCESS') return new Response('fail');
      const orderNo = String(params.out_trade_no || '');
      const money = String(params.money || '');
      const order = await db.prepare('SELECT * FROM vip_orders WHERE order_no=?').bind(orderNo).first();
      if (!order) return new Response('success'); // 未知单号不再重试
      if (order.status === 'paid') return new Response('success'); // 幂等
      if (order.status === 'closed') return new Response('success');
      if (Math.abs(parseFloat(money) - order.amount / 100) > 0.001) return new Response('fail'); // 金额不符: 拒收并让平台重试
      await handlePaid(db, orderNo, String(params.trade_no || ''));
      return new Response('success'); // 平台约定: 返回 success 停止重试
    }

    return j({ error: 'not found' }, 404);
  } catch (e) {
    return j({ error: e.message }, 500);
  }
}
