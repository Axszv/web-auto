# Web Auto - 每日网站自动化签到

自动化登录 4 个网站并执行签到/配置操作，部署在 GitHub Actions 定时运行。

## 支持的网站

| 网站 | 状态 | 说明 |
|------|------|------|
| gogocs.xyz | ✅ 全自动 | 邮箱密码登录 + PoW挑战 + 取消保护 + 设置分组 |
| new.sharedchat.cc | ✅ 全自动 | 邮箱密码登录 + 领取Codex权益 |
| agentrouter.org | ⚠️ 需配置 | 需用户名/密码（token不可用于登录） |
| anyrouter.top | ⚠️ 需初始登录 | Cloudflare阻挡OAuth，需手动登录一次 |

## 本地运行

```powershell
cd I:\Codex\web auto
node auto.js
```

## 手动登录（一次）

```powershell
# 用真实浏览器打开网站，完成登录，自动保存cookies
node login-helper.js agentrouter
node login-helper.js anyrouter
```

## 部署到 GitHub Actions

详见 [DEPLOY.md](DEPLOY.md)
