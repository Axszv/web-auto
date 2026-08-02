# 部署到 GitHub Actions

## 步骤 1: 创建 GitHub 仓库

1. 登录 https://github.com
2. 点击右上角 + → New repository
3. 仓库名填 `web-auto`，设为 **Private**（cookies.json 含敏感信息）
4. 不要勾选 "Initialize with README"
5. 点 Create repository

## 步骤 2: 配置 GitHub Personal Access Token (PAT)

1. GitHub → Settings → Developer settings → Personal access tokens → Tokens (classic)
2. 点 Generate new token (classic)
3. 描述填 `web-auto`
4. 勾选权限：`repo`（全部子项）
5. 点 Generate token → **复制保存好**

## 步骤 3: 推送代码到 GitHub

```powershell
cd I:\Codex\web auto
git remote add origin https://github.com/YOUR_USERNAME/web-auto.git
git add .
git commit -m "init: web auto automation"
git push -u origin main
```

## 步骤 4: 配置 GitHub Secrets

仓库 → Settings → Secrets and variables → Actions → New repository secret

| Secret 名称 | 值 |
|------------|-----|
| `GOGOCS_EMAIL` | 504740633@qq.com |
| `GOGOCS_PASSWORD` | XA531729 |
| `SHAREDCHAT_EMAIL` | 504740633@qq.com |
| `SHAREDCHAT_PASSWORD` | LZ37265981^ |

## 步骤 5: 处理 anyrouter 和 agentrouter

### anyrouter（需要手动完成一次 GitHub OAuth）

```powershell
# 运行登录助手，浏览器会打开并完成 OAuth
node login-helper.js anyrouter
# 登录完成后，cookies 自动保存到 cookies.json
# 推送到 GitHub
git add cookies.json && git commit -m "add anyrouter cookie" && git push
```

### agentrouter（需要用户名/密码）

如果你知道 agentrouter 的用户名和密码：
```json
// config.json 中配置
{
  "sites": [{
    "name": "agentrouter",
    "config": { "username": "your_email", "password": "your_password" }
  }]
}
```

如果没有用户名密码，只能手动登录：
```powershell
node login-helper.js agentrouter
git add cookies.json && git commit -m "add agentrouter cookie" && git push
```

## 步骤 6: 首次运行 workflow

1. 仓库 → Actions → "Daily Web Auto" → Run workflow
2. 查看日志，确认各站点运行结果

## 定时设置

Workflow 默认每天 UTC 1:00（北京时间 9:00）自动运行。

## 注意事项

- cookies.json 包含 session 信息，务必使用**私有仓库**
- anyrouter 的 session cookie 有效期约 30 天，过期后需重新手动登录
- GitHub Actions 上只有内置 Chromium（无 msedge），anyrouter 的 Cloudflare 绕过可能偶尔失败
- agentrouter 的 token 不能用于网页登录，需要用户名/密码
