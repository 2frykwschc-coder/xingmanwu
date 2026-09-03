// 星漫屋 VIP 会员支付模块 — Cloudflare Pages Functions
// 路由: /api/vip/*
// 支持: 微信支付 Native(APIv3) + 支付宝当面付(RSA2)，动态二维码，回调验签自动开通 VIP
//
// 需要的环境变量(在 Cloudflare Pages 项目 Settings → Variables and Secrets 里配置):
//   WECHAT_APPID            微信开放平台 AppID(公众号/小程序/网站应用)
//   WECHAT_MCHID            微信支付商户号
//   WECHAT_SERIAL_NO        商户 API 证书序列号(微信支付平台 → API安全)
//   WECHAT_APIV3_KEY        APIv3 密钥(32位, 微信支付平台设置)
//   WECHAT_PRIVATE_KEY      商户 API 私钥(PEM PKCS8, 微信支付平台下载的 apiclient_key.pem)
//   WECHAT_PLATFORM_PUBKEY  微信支付平台证书公钥(PEM SPKI, 从平台证书提取, 用于回调验签)
//   ALIPAY_APP_ID           支付宝开放平台应用 AppID
//   ALIPAY_PRIVATE_KEY      应用私钥(PEM PKCS8, 支付宝开放平台生成)
//   ALIPAY_PUBLIC_KEY       支付宝公钥(PEM SPKI 或纯 base64, 开放平台获取)
//   PAY_BASE_URL            网站根地址, 如 https://xinmanwu.top (用于拼接回调地址)
//   VIP_ADMIN_KEY           管理密钥, 用于查询订单列表(可选)

// ── VIP 套餐 ──
const PLANS = {
  weekly:    { name: '周VIP', amount: 800,   days: 7,   desc: '星漫屋·周VIP会员' },
  monthly:   { name: '月VIP', amount: 2800,  days: 30,  desc: '星漫屋·月VIP会员' },
  quarterly: { name: '季VIP', amount: 8800,  days: 90,  desc: '星漫屋·季VIP会员' },
  yearly:    { name: '年VIP', amount: 18800, days: 365, desc: '星漫屋·年VIP会员' },
};

const WX_API = 'https://api.mch.weixin.qq.com';
const ALI_API = 'https://openapi.alipay.com/gateway.do';

// ── 基础工具 ──
function b64ToBuf(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
function bufToB64(buf) {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}
function pemToDer(pem) {
  const b64 = pem.replace(/-----BEGIN [^-]+-----/g, '').replace(/-----END [^-]+-----/g, '').replace(/\s+/g, '');
  return b64ToBuf(b64);
}
function randomStr(len) {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let s = '';
  for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}
function genOrderNo() {
  return 'XMW' + Date.now() + Math.floor(1000 + Math.random() * 9000);
}
function aliTimestamp() {
  // 支付宝需要北京时间 yyyy-MM-dd HH:mm:ss
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 19);
}

// ── RSA 签名/验签 (WebCrypto) ──
async function rsaSign(pem, message) {
  const key = await crypto.subtle.importKey('pkcs8', pemToDer(pem), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(message));
  return bufToB64(sig);
}
async function rsaVerify(pubKey, message, signatureB64) {
  // 支持 PEM(SPKI) 或支付宝的纯 base64 公钥
  const der = pubKey.includes('BEGIN') ? pemToDer(pubKey) : b64ToBuf(pubKey);
  const key = await crypto.subtle.importKey('spki', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  return crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64ToBuf(signatureB64), new TextEncoder().encode(message));
}

// ── AES-256-GCM 解密 (微信回调 resource) ──
async function aesGcmDecrypt(keyStr, nonce, aad, ciphertextB64) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(keyStr), { name: 'AES-GCM' }, false, ['decrypt']);
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: new TextEncoder().encode(nonce), additionalData: new TextEncoder().encode(aad || '') },
    key, b64ToBuf(ciphertextB64)
  );
  return new TextDecoder().decode(pt);
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
}

// ── 鉴权: Bearer token → user_id ──
async function getUserId(db, request) {
  const auth = request.headers.get('Authorization') || '';
  const token = auth.replace('Bearer ', '').trim();
  if (!token) return null;
  const s = await db.prepare('SELECT user_id FROM sessions WHERE token=?').bind(token).first();
  return s ? s.user_id : null;
}

// ── 开通/续费 VIP ──
async function grantVip(db, userId, planId, when) {
  const p = PLANS[planId];
  if (!p) return null;
  const now = new Date(when);
  const cur = await db.prepare('SELECT vip_until FROM vip_users WHERE user_id=?').bind(userId).first();
  let base = cur?.vip_until ? new Date(cur.vip_until) : now;
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

// ── 支付成功统一处理 ──
async function handlePaid(db, { orderNo, platformOrder, amount, paidAt }) {
  const order = await db.prepare('SELECT * FROM vip_orders WHERE order_no=?').bind(orderNo).first();
  if (!order) return { ok: false, reason: '订单不存在' };
  if (order.status === 'paid') return { ok: true, already: true }; // 幂等
  if (amount !== undefined && amount !== order.amount) return { ok: false, reason: '金额不匹配' };
  const when = paidAt || new Date().toISOString();
  const until = await grantVip(db, order.user_id, order.plan, when);
  await db.prepare("UPDATE vip_orders SET status='paid', platform_order=?, paid_at=?, vip_until=? WHERE order_no=?")
    .bind(platformOrder || '', when, until, orderNo).run();
  return { ok: true, vip_until: until };
}

// ════════════════════════════════════════════
// 微信支付 APIv3 — Native 下单
// ════════════════════════════════════════════
async function wxCreateOrder(env, order) {
  const body = JSON.stringify({
    appid: env.WECHAT_APPID,
    mchid: env.WECHAT_MCHID,
    description: order.desc,
    out_trade_no: order.order_no,
    notify_url: `${env.PAY_BASE_URL}/api/vip/notify/wechat`,
    amount: { total: order.amount, currency: 'CNY' },
  });
  const path = '/v3/pay/transactions/native';
  const ts = Math.floor(Date.now() / 1000).toString();
  const nonce = randomStr(32);
  const message = `POST\n${path}\n${ts}\n${nonce}\n${body}\n`;
  const signature = await rsaSign(env.WECHAT_PRIVATE_KEY, message);
  const auth = `WECHATPAY2-SHA256-RSA2048 mchid="${env.WECHAT_MCHID}",nonce_str="${nonce}",timestamp="${ts}",serial_no="${env.WECHAT_SERIAL_NO}",signature="${signature}"`;

  const r = await fetch(WX_API + path, {
    method: 'POST',
    headers: { 'Authorization': auth, 'Content-Type': 'application/json', 'Accept': 'application/json', 'User-Agent': 'xingmanwu/1.0' },
    body,
    signal: AbortSignal.timeout(10000),
  });
  const d = await r.json();
  if (!r.ok || !d.code_url) throw new Error('微信下单失败: ' + JSON.stringify(d));
  return d.code_url;
}

// 微信支付回调处理
async function wxHandleNotify(env, body, headers) {
  const ts = headers.get('Wechatpay-Timestamp');
  const nonce = headers.get('Wechatpay-Nonce');
  const sig = headers.get('Wechatpay-Signature');
  const serial = headers.get('Wechatpay-Serial');
  if (!ts || !nonce || !sig) throw new Error('缺少微信回调签名头');

  // 1. 验签(平台证书公钥)
  if (!env.WECHAT_PLATFORM_PUBKEY) throw new Error('未配置 WECHAT_PLATFORM_PUBKEY，拒绝回调');
  // 时间戳防重放(±5分钟)
  if (Math.abs(Date.now() / 1000 - parseInt(ts)) > 300) throw new Error('回调时间戳过期');
  const message = `${ts}\n${nonce}\n${body}\n`;
  const ok = await rsaVerify(env.WECHAT_PLATFORM_PUBKEY, message, sig);
  if (!ok) throw new Error('微信回调验签失败');
  if (serial !== env.WECHAT_SERIAL_NO && env.WECHAT_PLATFORM_SERIAL) {
    if (serial !== env.WECHAT_PLATFORM_SERIAL) throw new Error('平台证书序列号不匹配');
  }

  // 2. 解密 resource (AES-256-GCM)
  const noti = JSON.parse(body);
  const res = noti.resource || {};
  const decrypted = await aesGcmDecrypt(env.WECHAT_APIV3_KEY, res.nonce, res.associated_data, res.ciphertext);
  const pay = JSON.parse(decrypted);

  // 3. 校验 + 入账
  if (pay.trade_state !== 'SUCCESS') return { ok: true, ignored: true, reason: 'trade_state=' + pay.trade_state };
  if (pay.appid && pay.appid !== env.WECHAT_APPID) throw new Error('appid 不匹配');
  if (pay.mchid && pay.mchid !== env.WECHAT_MCHID) throw new Error('mchid 不匹配');
  return handlePaid(env.DB, {
    orderNo: pay.out_trade_no,
    platformOrder: pay.transaction_id,
    amount: pay.amount?.total,
    paidAt: new Date(pay.success_time || Date.now()).toISOString(),
  });
}

// ════════════════════════════════════════════
// 支付宝 — 当面付 precreate
// ════════════════════════════════════════════
async function aliSignParams(privateKey, params) {
  const keys = Object.keys(params).sort();
  const str = keys.map(k => `${k}=${params[k]}`).join('&');
  return rsaSign(privateKey, str);
}
async function aliCreateOrder(env, order) {
  const params = {
    app_id: env.ALIPAY_APP_ID,
    method: 'alipay.trade.precreate',
    format: 'JSON',
    charset: 'utf-8',
    sign_type: 'RSA2',
    timestamp: aliTimestamp(),
    version: '1.0',
    notify_url: `${env.PAY_BASE_URL}/api/vip/notify/alipay`,
    biz_content: JSON.stringify({
      out_trade_no: order.order_no,
      total_amount: (order.amount / 100).toFixed(2),
      subject: order.desc,
    }),
  };
  const sign = await aliSignParams(env.ALIPAY_PRIVATE_KEY, params);
  const form = new URLSearchParams({ ...params, sign });
  const r = await fetch(ALI_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
    signal: AbortSignal.timeout(10000),
  });
  const d = await r.json();
  const res = d.alipay_trade_precreate_response;
  if (!res || res.code !== '10000' || !res.qr_code) throw new Error('支付宝下单失败: ' + JSON.stringify(d));
  return res.qr_code;
}

// 支付宝回调处理 (form-urlencoded)
async function aliHandleNotify(env, body) {
  if (!env.ALIPAY_PUBLIC_KEY) throw new Error('未配置 ALIPAY_PUBLIC_KEY，拒绝回调');
  const params = {};
  for (const [k, v] of new URLSearchParams(body)) params[k] = v;

  // 1. 验签
  const sign = params.sign;
  if (!sign) throw new Error('缺少支付宝签名');
  const toVerify = Object.keys(params)
    .filter(k => k !== 'sign' && k !== 'sign_type')
    .sort()
    .map(k => `${k}=${params[k]}`)
    .join('&');
  const ok = await rsaVerify(env.ALIPAY_PUBLIC_KEY, toVerify, sign);
  if (!ok) throw new Error('支付宝回调验签失败');

  // 2. 校验 + 入账
  if (params.app_id && params.app_id !== env.ALIPAY_APP_ID) throw new Error('app_id 不匹配');
  const status = params.trade_status;
  if (status !== 'TRADE_SUCCESS' && status !== 'TRADE_FINISHED') return { ok: true, ignored: true, reason: 'trade_status=' + status };
  const amount = params.total_amount ? Math.round(parseFloat(params.total_amount) * 100) : undefined;
  return handlePaid(env.DB, {
    orderNo: params.out_trade_no,
    platformOrder: params.trade_no,
    amount,
    paidAt: params.gmt_payment ? new Date(params.gmt_payment.replace(/-/g, '/')).toISOString() : new Date().toISOString(),
  });
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
        channels: {
          wechat: !!(env.WECHAT_MCHID && env.WECHAT_PRIVATE_KEY),
          alipay: !!(env.ALIPAY_APP_ID && env.ALIPAY_PRIVATE_KEY),
        },
      });
    }

    // -- GET /api/vip/me (登录后查 VIP 状态) --
    if (m === 'GET' && path === 'me') {
      const userId = await getUserId(db, request);
      if (!userId) return j({ user: null, vip: null });
      const u = await db.prepare('SELECT username FROM users WHERE id=?').bind(userId).first();
      const v = await db.prepare('SELECT vip_until FROM vip_users WHERE user_id=?').bind(userId).first();
      let vip = null;
      if (v?.vip_until) {
        const until = new Date(v.vip_until);
        if (until > new Date()) {
          vip = { active: true, until: v.vip_until, daysLeft: Math.max(0, Math.ceil((until - Date.now()) / 86400000)) };
        } else {
          vip = { active: false, until: v.vip_until, daysLeft: 0 };
        }
      }
      return j({ user: u ? { id: userId, username: u.username } : null, vip });
    }

    // -- POST /api/vip/order {plan, channel} (登录) --
    if (m === 'POST' && path === 'order') {
      const userId = await getUserId(db, request);
      if (!userId) return j({ error: '请先登录' }, 401);

      const body = await request.json();
      const plan = PLANS[body.plan];
      const channel = body.channel;
      if (!plan) return j({ error: '无效的套餐' }, 400);
      if (channel !== 'wechat' && channel !== 'alipay') return j({ error: '无效的支付方式' }, 400);

      const order = {
        order_no: genOrderNo(),
        user_id: userId,
        plan: body.plan,
        amount: plan.amount,
        channel,
        desc: plan.desc,
      };

      // 调用支付平台生成动态二维码
      let qrContent;
      try {
        if (channel === 'wechat') {
          if (!env.WECHAT_MCHID || !env.WECHAT_PRIVATE_KEY) return j({ error: '微信支付暂未开通，请稍后再试' }, 400);
          qrContent = await wxCreateOrder(env, order);
        } else {
          if (!env.ALIPAY_APP_ID || !env.ALIPAY_PRIVATE_KEY) return j({ error: '支付宝暂未开通，请稍后再试' }, 400);
          qrContent = await aliCreateOrder(env, order);
        }
      } catch (e) {
        return j({ error: e.message }, 502);
      }

      await db.prepare(
        'INSERT INTO vip_orders(order_no,user_id,plan,amount,channel,status,qr_content,created_at) VALUES(?,?,?,?,?,?,?,?)'
      ).bind(order.order_no, userId, order.plan, order.amount, channel, 'pending', qrContent, new Date().toISOString()).run();

      return j({ ok: true, order_no: order.order_no, qr_content: qrContent, amount: order.amount, plan: order.plan });
    }

    // -- GET /api/vip/order/:orderNo (本人或管理员) --
    if (m === 'GET' && /^order\/.+/.test(path)) {
      const orderNo = path.slice(6);
      const userId = await getUserId(db, request);
      const isAdmin = env.VIP_ADMIN_KEY && url.searchParams.get('key') === env.VIP_ADMIN_KEY;
      const order = await db.prepare('SELECT * FROM vip_orders WHERE order_no=?').bind(orderNo).first();
      if (!order) return j({ error: '订单不存在' }, 404);
      if (order.user_id !== userId && !isAdmin) return j({ error: '无权查看' }, 403);

      // 懒过期: pending 超过 2 小时自动关闭
      if (order.status === 'pending' && order.created_at) {
        const age = Date.now() - new Date(order.created_at).getTime();
        if (age > 7200 * 1000) {
          await db.prepare("UPDATE vip_orders SET status='expired' WHERE order_no=? AND status='pending'").bind(orderNo).run();
          order.status = 'expired';
        }
      }
      return j({ order_no: order.order_no, plan: order.plan, amount: order.amount, channel: order.channel, status: order.status, vip_until: order.vip_until, paid_at: order.paid_at });
    }

    // -- POST /api/vip/notify/wechat (微信回调, 无鉴权) --
    if (m === 'POST' && path === 'notify/wechat') {
      const body = await request.text();
      let result;
      try {
        result = await wxHandleNotify(env, body, request.headers);
      } catch (e) {
        return j({ code: 'FAIL', message: e.message }, 400);
      }
      return j({ code: 'SUCCESS' });
    }

    // -- POST /api/vip/notify/alipay (支付宝回调, 无鉴权) --
    if (m === 'POST' && path === 'notify/alipay') {
      const body = await request.text();
      try {
        await aliHandleNotify(env, body);
      } catch (e) {
        return new Response('failure', { status: 200, headers: cors });
      }
      return new Response('success', { status: 200, headers: cors });
    }

    // -- GET /api/vip/orders?key=xxx (管理员查订单) --
    if (m === 'GET' && path === 'orders') {
      if (!env.VIP_ADMIN_KEY || url.searchParams.get('key') !== env.VIP_ADMIN_KEY) return j({ error: '无权访问' }, 403);
      const { results } = await db.prepare('SELECT * FROM vip_orders ORDER BY id DESC LIMIT 100').all();
      return j(results);
    }

    return j({ error: 'not found' }, 404);
  } catch (e) {
    return j({ error: e.message }, 500);
  }
}
