# 部署到 GitHub Actions

## 步骤 1: 创建 GitHub 仓库

1. 登录 https://github.com
2. 点击右上角 + → New repository
3. 仓库名填 `web-auto`
4. 不要勾选 "Initialize with README"
5. 点 Create repository

## 步骤 2: 创建私有 gist（存 quota 基线）

两个 router 站签到成功判定为"余额相比上次实际增加"，需要一个跨运行的小存储放上次 quota。用私有 gist：

1. 打开 https://gist.github.com/gists/new?=private （或建后设为 private）
2. 文件名 `quota-baseline.json`，内容先填：
   ```json
   { "agentrouter": 0, "anyrouter": 0 }
   ```
3. 创建后，URL 里 `.../Axszv/` 后面那串 **32 位十六进制** 就是 `GIST_ID`

## 步骤 3: 创建 gist token

仓库不再回写任何内容到 git，只需一个**能读写 gist 的最小权限 token**：

1. GitHub → Settings → Developer settings → Personal access tokens → **Fine-grained token**
2. Repository access 选 **Public repositories**（最小权限；web-auto 是私有仓，不在其范围内）
3. Account permissions → **Gist: Read and write**（仅此一项；gist 权限与 repo 权限相互独立）
4. 生成并复制，作为 `GIST_TOKEN`

> 不要用带 repo/workflow 权限的全能 token —— 它会被存进 Actions secret，泄露面越大越危险。

## 步骤 4: 推送代码到 GitHub

```powershell
cd I:\Codex\web auto
git remote add origin https://github.com/YOUR_USERNAME/web-auto.git
git add .
git commit -m "init: web auto automation"
git push -u origin main
```

## 步骤 5: 配置 GitHub Secrets

仓库 → Settings → Secrets and variables → Actions → New repository secret

| Secret 名称 | 用途 |
|------------|------|
| `GH_USER` | GitHub 用户名（OAuth 登录用） |
| `GH_PASS` | GitHub 密码 |
| `GH_TOTP_SECRET` | GitHub 2FA 的 base32 密钥（无 2FA 则不填） |
| `GOGOCS_EMAIL` | gogocs 登录邮箱 |
| `GOGOCS_PASSWORD` | gogocs 登录密码 |
| `SINGBOX_CONFIG` | sing-box 代理配置 JSON 全文（agentrouter 需要） |
| `GIST_ID` | 步骤 2 的 32 位 gist id |
| `GIST_TOKEN` | 步骤 3 的 gist-only token |

所有凭据一律走 secrets，**禁止写进代码或文档**。

## 会话状态：不落盘

两个 router 站是 new-api 架构，其鉴权依赖浏览器 localStorage，GitHub Actions 每次是全新环境，cookie 无法复用 —— 因此**每次运行直接重新走 GitHub OAuth 登录，不持久化任何 cookies**。仓库里没有任何会话状态。

唯一跨运行持久的是 quota 基线（一个余额数字），存于步骤 2 的私有 gist，由 `lib/baseline.js` 读写；读写失败时自动降级为"当天建立基线"，不影响登录与签到本身。

## 步骤 6: 首次运行 workflow

1. 仓库 → Actions → 选 "Daily Web Auto (gogocs + agentrouter)" 或 "(anyrouter)" → Run workflow
2. 查看日志，确认各站点运行结果（首次会打印 `no baseline quota, establishing` 建立基线）

## 定时设置

拆成两个 workflow（cron 只认 UTC）：

| workflow | 站点 | cron (UTC) | 北京时间 |
|---|---|---|---|
| `daily.yml` | gogocs + agentrouter | `17 18` | 提交 02:17，排队后约 04:17 跑 |
| `daily-anyrouter.yml` | a-n-y-router | `17 22` | 提交 06:17，排队后约 08:17 跑 |

## 注意事项

- 所有敏感信息（密码/密钥/代理配置）只存 GitHub Secrets
- `singbox.json` / `cookies.json` 已在 .gitignore 中，不会入库
- a-n-y-router.top 的签到按 UTC 零点重置，agentrouter.org 按北京时间零点重置
- 两个 workflow 都读写同一 gist，**不要并发手动触发**（会互相覆盖基线），验证请串行
