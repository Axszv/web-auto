# 部署到 GitHub Actions

## 步骤 1: 创建 GitHub 仓库

1. 登录 https://github.com
2. 点击右上角 + → New repository
3. 仓库名填 `web-auto`
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

| Secret 名称 | 用途 |
|------------|------|
| `GH_USER` | GitHub 用户名（OAuth 登录用） |
| `GH_PASS` | GitHub 密码 |
| `GH_TOTP_SECRET` | GitHub 2FA 的 base32 密钥（可选，无 2FA 则不填） |
| `GOGOCS_EMAIL` | gogocs 登录邮箱 |
| `GOGOCS_PASSWORD` | gogocs 登录密码 |
| `SINGBOX_CONFIG` | sing-box 代理配置 JSON 全文 |
| `COOKIES_KEY` | 64 位 hex，用于加解密 cookies.json.enc |

所有凭据一律走 secrets，**禁止写进代码或文档**。

## cookies 的加密持久化

cookies.json（session）运行时从 `COOKIES_KEY` 解密 `cookies.json.enc` 得到，运行结束 auto.js 自动把最新 session 加密回写 `cookies.json.enc` 并提交。仓库里只有密文，密钥只在 secrets 里。

本地手动加解密：

```powershell
# 解密（设置 COOKIES_KEY 环境变量后）
node lib/crypt-decrypt-cli.js cookies.json.enc cookies.json

# 加密（auto.js 运行时自动做，也可手动）
node -e "require('./lib/crypt').encryptFile('cookies.json','cookies.json.enc',process.env.COOKIES_KEY)"
```

## 步骤 5: 首次运行 workflow

1. 仓库 → Actions → "Daily Web Auto" → Run workflow
2. 查看日志，确认各站点运行结果

## 定时设置

Workflow 默认每天 UTC 21:17（北京时间凌晨 5:17 提交，Actions 排队后约 7 点多实际运行）自动执行。

## 注意事项

- 所有敏感信息（密码/密钥/代理配置）只存 GitHub Secrets
- cookies.json 与 singbox.json 已在 .gitignore 中，不会入库
- a-n-y-router.top 的签到按 UTC 零点重置，agentrouter.org 按北京时间零点重置
