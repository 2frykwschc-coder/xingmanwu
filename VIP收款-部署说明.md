# 星漫屋 VIP 收款 — 部署说明（固定收款码 · 自动开通版）

套餐：周VIP ¥8 / 月VIP ¥28 / 季VIP ¥88 / 年VIP ¥188
模式：**微信/支付宝固定收款码 + 用户点击「我已付款」立即自动开通**（无人工核对）+ 全站锁（游客登录墙、阅读需VIP）

## 收款流程

```
用户：VIP页 → 选套餐 → 选微信/支付宝 → 看到收款码图片 + 应付金额
    → 扫码转账 → 点「我已付款」(可填交易单号) → 🎉 VIP 立即自动开通(按套餐天数顺延)
站长：VIP页底部「🛠 管理台」→ 事后抽查订单与实际到账是否相符 → 异常订单可标记关闭
```

## 代码结构

| 文件 | 说明 |
|------|------|
| `functions/api/vip/[[path]].js` | 后端：下单/「我已付款」自动开通/我的订单/管理台抽查（D1 自动建表） |
| `public/pay/wechat.jpg` | 你的**微信**收款码截图 |
| `public/pay/alipay.jpg` | 你的**支付宝**收款码截图 |
| `public/js/app.js` | 前端：选套餐→展示收款码→点「我已付款」立即开通→管理台 |

## 管理员是谁

- users 表有 `is_admin` 列；**第一个注册的用户自动成为管理员**（通常是你本人）。
- 也可改后端顶部 `ADMIN_USERS` 指定：`new Set(['你的用户名'])`。
- 管理台仅管理员可见，接口校验登录态 + 管理员身份。

## 换收款码图片

1. 微信/支付宝 App：我 → 收付款 → 收款码 → 保存图片
2. 覆盖 `public/pay/wechat.jpg` / `public/pay/alipay.jpg`
3. 重新部署

## 部署

仓库 github.com/2frykwschc-coder/xingmanwu → Cloudflare Pages（项目 xingmanwu）自动部署。
本机 github.com 直连不通时用 Git Data API 推送（memory 2026-09-03 有脚本），或：

```bash
git push origin main
npx wrangler pages deploy public/ --branch main   # 需要 Cloudflare 令牌
```

线上验证：`https://xingmanwu.pages.dev`（`/api/vip/plans` 返回 4 档价格、channels 全 true、mode=manual）。
正式域名 xinmanwu.top 的 DNS 记录丢失，需在 Cloudflare 后台把自定义域名重新加到 Pages 项目（或提供 API 令牌代加）。

## ⚠️ 风险提示（重要）

- **自动开通 = 信任模式**：不核对到账就发 VIP，用户不付款也能白嫖（点一下就有）。
  是否合算你自行权衡；建议：偶尔去管理台抽查大额订单；发现惯犯可改数据库撤销其 VIP。
  想真正防白嫖，只能上商户 API 版（微信 Native/支付宝当面付，需要个体户营业执照）自动验单。
- 个人收款码**官方不允许用于经营/异地远程收款**，量大可能触发风控冻结；请控制规模。
- 收款以你 App 实际到账为准，有争议时先查自己账单再处理。

## 常见问题

- 用户点了没开通？→ 检查是否登录态失效/订单已关闭，看管理台订单状态。
- 白嫖用户 → 管理台关闭其订单；撤销 VIP 需改数据库 `vip_users`（可后续加撤销按钮）。
- 误操作 → 管理台可标记「关闭」订单（不影响已发 VIP）。

## 全站锁（2026-09-03 上线）

- **游客**：全站内容不可见，页面被登录墙覆盖（只放行注册/登录接口，后端强制 401）。
- **登录非 VIP**：可浏览目录/详情/收藏，点「在线阅读」弹开通引导；后端对阅读接口强制 403（dex/* 与 ext/search）。
- **VIP**：可阅读全部章节与图片；图片代理校验 `?t=token`（<img> 无法带 Header）。
- **管理员**(users.is_admin=1)：免 VIP 检查，方便站长自己看。
- 外部阅读链接(Comick/MangaFire/MangaDex)仅 VIP 可见——注意这些是站外网站，**无法真正锁死**，会员仍可自行前往免费站。
- 细节：登录后 api 请求自动带 Bearer token；token 失效自动回登录墙；前端文件 index.html 引 app.js?v=23。
- 测试账号 vip_test_0903 / Test12345 留在库里用于验证，可无视或后续删除。
