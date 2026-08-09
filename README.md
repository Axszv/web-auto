# Web Auto - 每日网站自动化签到

自动化登录 4 个网站并执行签到/配置操作，部署在 GitHub Actions 定时运行。

## 支持的网站

| 网站 | 状态 | 说明 |
|------|------|------|
| gogocs.xyz | ✅ 全自动 | 邮箱密码登录 + PoW挑战 + 取消保护 + 设置分组 |
| new.sharedchat.cc | ✅ 全自动 | 邮箱密码登录 + 领取Codex权益 |
| agentrouter.org | ⚠️ 需手动登录 | GitHub OAuth 需要手动完成授权，cookies 有效期约 30 天 |
| anyrouter.top | ⚠️ 需手动登录 | GitHub OAuth 需要手动完成授权，cookies 有效期约 30 天 |

## 重要说明

**agentrouter 和 anyrouter 的 GitHub OAuth 无法完全自动化**，因为：
1. GitHub 的 `/session` 页面是安全验证页面，需要人工交互
2. Headless 浏览器点击 Authorize 后，GitHub 不会跳转到回调 URL
3. 需要定期手动更新 cookies

**解决方案**：
```powershell
# 手动登录（非 headless 模式）
node login-helper.js anyrouter
node login-helper-agentrouter.js

# 完成后推送 cookies
git add cookies.json && git commit -m "update cookies" && git push
```

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
