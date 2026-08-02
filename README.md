# Web Auto - 每日网站自动化签到

自动化登录 4 个网站并执行签到/配置操作，部署在 GitHub Actions 定时运行。

## 支持的网站

| 网站 | 状态 | 说明 |
|------|------|------|
| gogocs.xyz | ✅ 全自动 | 邮箱密码登录 + PoW挑战 + 取消保护 + 设置分组 |
| new.sharedchat.cc | ✅ 全自动 | 邮箱密码登录 + 领取Codex权益 |
| agentrouter.org | ⚠️ 需配置 | 需用户名/密码（token不可用于登录） |
| anyrouter.top | ⚠️ 需初始登录 | Cloudflare WAF，需手动完成一次 GitHub OAuth |

## 本地运行

```powershell
cd I:\Codex\web auto
node auto.js
```

## 手动登录（一次）

```powershell
# anyrouter: 打开浏览器完成 GitHub OAuth，自动保存 cookies
node login-helper.js anyrouter

# agentrouter: 如果有用户名密码，直接在 config.json 配置
# 如果没有，用 login-helper 手动登录
node login-helper.js agentrouter
```

## 部署到 GitHub Actions

详见 [DEPLOY.md](DEPLOY.md)
