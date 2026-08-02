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

推送时如果用 HTTPS，会提示输入 GitHub 用户名和 PAT（不是密码）。

## 步骤 4: 配置 GitHub Secrets

仓库 → Settings → Secrets and variables → Actions → New repository secret

添加以下 4 个 Secret：

| Secret 名称 | 值 |
|------------|-----|
| `GOGOCS_EMAIL` | 504740633@qq.com |
| `GOGOCS_PASSWORD` | XA531729 |
| `SHAREDCHAT_EMAIL` | 504740633@qq.com |
| `SHAREDCHAT_PASSWORD` | LZ37265981^ |

## 步骤 5: 处理 agentrouter / anyrouter

这两个站点需要手动登录一次获取 session cookie。

**方案 A：手动登录后上传 cookies.json**
```powershell
# 本地运行手动登录
node login-helper.js agentrouter
node login-helper.js anyrouter
# 然后提交 cookies.json
git add cookies.json
git commit -m "add initial cookies"
git push
```

**方案 B（推荐）：直接在 GitHub Secrets 配置 token**
agentrouter 的 token 不能用于网页登录，但可以在 config.json 里配置用户名/密码（如果有）。
如果只有 token，只能手动登录后把 cookies.json 推上去。

## 步骤 6: 首次运行 workflow

1. 仓库 → Actions → "Daily Web Auto" → Run workflow
2. 查看日志，确认 gogocs 和 sharedchat 成功
3. 如果 agentrouter/anyrouter 失败，按步骤 5 处理

## 定时设置

Workflow 默认每天 UTC 1:00（北京时间 9:00）自动运行。
修改时间：编辑 `.github/workflows/daily.yml` 中的 cron 字段。

## 注意事项

- cookies.json 包含 session 信息，务必使用**私有仓库**
- anyrouter 的 session cookie 有效期约 30 天，过期后需重新手动登录
- agentrouter 的 token 不是登录密码，需使用用户名/密码或手动 OAuth
