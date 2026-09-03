# 星漫屋 VIP 会员收款 — 部署说明

周VIP ¥8 / 月VIP ¥28 / 季VIP ¥88 / 年VIP ¥188
动态二维码：微信支付 Native + 支付宝当面付，支付成功后自动开通/续费 VIP。

## 代码结构

| 文件 | 说明 |
|------|------|
| `functions/api/vip/[[path]].js` | VIP 支付后端（下单/回调验签/自动开通） |
| `public/js/qrcode.min.js` | 二维码生成库（本地） |
| `public/index.html` | 导航加了「👑VIP」入口 + 页面 |
| `public/js/app.js` | 前端逻辑（选套餐→选支付→扫码→轮询） |
| `public/css/style.css` | VIP 样式 |
| `sql/vip.sql` | D1 建表语句（运行时会自动建，此文件用于手动初始化） |

## 第一步：开通商户（需要个体户/企业营业执照）

> 没有执照的话，先办一张个体户营业执照（全程网上办、免费、1-3 天下证），
> 经营范围写「网络技术服务 / 互联网信息服务」等。这是正规收款的前提。

### 微信支付
1. 注册 [微信支付商户平台](https://pay.weixin.qq.com)（用营业执照）
2. 开通「Native 支付」产品（产品中心 → Native支付）
3. API 安全里：
   - 申请 **API 证书** → 下载 `apiclient_key.pem`（商户私钥）
   - 查看 **APIv3 密钥** → 自己设置 32 位密钥
   - 下载 **平台证书** `wechatpay_xxx.pem`（用于回调验签）
4. 拿到：商户号 mchid、AppID（公众号/小程序/开放平台的）、证书序列号

提取平台证书公钥（供验签用）：
```bash
openssl x509 -in wechatpay_xxx.pem -pubkey -noout
# 输出 -----BEGIN PUBLIC KEY----- ... -----END PUBLIC KEY-----
```

### 支付宝
1. 注册 [支付宝开放平台](https://open.alipay.com)（用营业执照，创建「自研应用」）
2. 应用 → 开发设置 → 接口加签方式 → **公钥模式**：
   - 用 `openssl genrsa -out app_private.pem 2048` 生成密钥
   - `openssl rsa -in app_private.pem -pubout -out app_public.pem` 导出公钥
   - 上传应用公钥，保存平台返回的「**支付宝公钥**」（纯 base64 字符串）
3. 应用 → 添加能力 → 签约「**当面付**」（审核一般很快）
4. 拿到：AppID、应用私钥、支付宝公钥

## 第二步：配置 Cloudflare Pages 环境变量

在 Pages 项目 `xingmanwu` → Settings → Variables and Secrets 添加
（或用命令行，每个都要重新部署才生效）：

```bash
npx wrangler pages secret put WECHAT_APPID           --project-name xingmanwu
npx wrangler pages secret put WECHAT_MCHID           --project-name xingmanwu
npx wrangler pages secret put WECHAT_SERIAL_NO       --project-name xingmanwu
npx wrangler pages secret put WECHAT_APIV3_KEY       --project-name xingmanwu
npx wrangler pages secret put WECHAT_PRIVATE_KEY     --project-name xingmanwu   # apiclient_key.pem 全文
npx wrangler pages secret put WECHAT_PLATFORM_PUBKEY --project-name xingmanwu   # 平台证书公钥(含 BEGIN/END)
npx wrangler pages secret put ALIPAY_APP_ID          --project-name xingmanwu
npx wrangler pages secret put ALIPAY_PRIVATE_KEY     --project-name xingmanwu   # 应用私钥 PEM 全文
npx wrangler pages secret put ALIPAY_PUBLIC_KEY      --project-name xingmanwu   # 支付宝公钥 base64
npx wrangler pages secret put PAY_BASE_URL           --project-name xingmanwu   # 填 https://xinmanwu.top
npx wrangler pages secret put VIP_ADMIN_KEY          --project-name xingmanwu   # 管理密钥(自己定)
```

⚠️ PEM 私钥含换行，粘贴时保持原样（`\n` 换行）。

## 第三步：初始化数据库

```bash
npx wrangler d1 execute xingmanwu --remote --file=sql/vip.sql
```

（不执行也行——后端每次请求会自动建表，但建议手动执行确认）

## 第四步：部署

```bash
git add -A
git commit -m "feat: VIP 会员支付(微信Native+支付宝当面付)"
git push   # Cloudflare Pages 自动部署
```

部署后验证：
- 打开 `https://xinmanwu.top` → 点「👑VIP」
- 未登录时提示登录；登录后显示 4 个套餐
- 未配置密钥时页面提示「支付通道配置中」；配置后显示微信/支付宝按钮

## 使用与运维

- **订单查询**（管理）：`GET https://xinmanwu.top/api/vip/orders?key=你的VIP_ADMIN_KEY`
- **VIP 有效期**：购买后自动叠加到现有到期时间上（没到期就顺延）
- **手动开通 VIP**（比如退款补偿）：
  ```bash
  npx wrangler d1 execute xingmanwu --remote --command \
    "INSERT INTO vip_users(user_id,vip_until,updated_at) VALUES(1,datetime('now','+30 days'),datetime('now')) ON CONFLICT(user_id) DO UPDATE SET vip_until=excluded.vip_until"
  ```
- **订单超时**：二维码 2 小时有效，超时自动标记 expired

## 安全说明

- 回调接口做了严格验签（微信平台证书 RSA 验签 + AES-GCM 解密；支付宝 RSA2 验签）
- 金额、订单号、商户号全部二次校验，防伪造回调
- 验签密钥缺失时回调直接拒绝，不会误开 VIP

## 常见问题

- **下单报「微信下单失败」**：检查商户号/AppID 是否匹配、证书序列号是否正确、Native 支付是否已开通
- **回调一直失败**：确认 `PAY_BASE_URL` 是外网可访问的域名（不能是 localhost），微信/支付宝必须能访问到 `/api/vip/notify/*`
- **支付宝验签失败**：确认用的是「支付宝公钥」而不是「应用公钥」，格式为纯 base64（无 BEGIN 头）
