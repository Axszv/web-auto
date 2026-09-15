# Web Auto - 每日网站自动化签到

自动登录若干网站并执行签到 / 配置操作，部署在 GitHub Actions 定时运行。所有凭据走 GitHub Secrets；仓库不存任何会话状态。

## 支持的网站

| 网站 | 状态 | 说明 |
|------|------|------|
| gogocs (user.gogocs.xyz) | ✅ 全自动 | 邮箱密码登录 + PoW 挑战 + 取消账户保护 + 设置「延迟优先」分组 |
| agentrouter (agentrouter.org) | ✅ 全自动 | GitHub OAuth（含 2FA 自动验证）登录，登录即触发每日签到 +$25 额度 |
| a-n-y-router (a-n-y-router.top) | ✅ 全自动 | GitHub OAuth（含 2FA 自动验证）登录 + `POST /api/user/sign_in` 签到 +$25 额度 |
| sharedchat | ⛔ 已禁用 | 账号被 Cloudflare 拦截，已从自动运行中移除 |

两个 router 站都是 new-api 架构，GitHub OAuth 已完全自动化：脚本自动填 GitHub 账号密码 → 自动计算 TOTP 填 2FA 验证码 → 点授权 → 回调登录 → 签到。**每次运行都重新登录，仓库不存 cookies**（new-api 鉴权依赖浏览器 localStorage，Actions 全新环境下 cookie 无法复用，故直接省掉持久化）。

## 签到成功的判定

`auto.js` 按站点语义判定成功，任一失败则 workflow 以非零码退出：

- **gogocs**：取消账户保护 + 改分组完成（`success: true`）
- **agentrouter / a-n-y-router**：**余额相比上次运行实际增加**（每次运行读取 `/api/user/self` 的 quota，与上次持久化值比较；基线存在一个**私有 gist** 里，见 `lib/baseline.js`）

## 定时与拆分

拆成两个 workflow（`auto.js` 通过 `SITES` 环境变量按站过滤，复用同一入口）：

| workflow 文件 | 站点 | cron (UTC) | 北京时间 | 代理 |
|---|---|---|---|---|
| `.github/workflows/daily.yml` | gogocs + agentrouter | `17 18 * * *` | 提交 02:17，实际约 04:17 跑 | ✅ 需要 |
| `.github/workflows/daily-anyrouter.yml` | a-n-y-router | `17 22 * * *` | 提交 06:17，实际约 08:17 跑 | ❌ 不需要 |

**为什么这样安排：**
- GitHub Actions 的 cron **只认 UTC**，无时区选项。
- gogocs 每天北京时间 04:11 才出现「账户保护」，需在其后取消；叠加 Actions 排队延迟（约 1.5–2h），设 02:17 提交、约 04:17 实际跑。
- agentrouter.org 签到按**北京时间 0 点**重置；a-n-y-router.top 按 **UTC 0 点（北京 08:00）** 重置，故单独放更晚的 workflow。
- a-n-y-router.top 的 Cloudflare 无头浏览器能自动通过，**不需要代理**；agentrouter.org 直连会被**阿里云 WAF** 拦成验证页，必须走代理换出口 IP。

> 注意：两个 workflow 都会读写同一个 gist 基线文件。定时里相差 4 小时不冲突；**不要同时手动触发两个**（并发写会互相覆盖基线），手动验证请串行。

## 安全

- 所有密码 / 密钥 / 代理配置只存 GitHub Secrets，代码与仓库零明文。
- **仓库不存任何会话状态**：cookies 不落盘、不入库，每次运行重新登录。
- 唯一的跨运行持久数据是 quota 基线（就是个余额数字），存于**私有 gist**，由 `GIST_ID` + `GIST_TOKEN`（仅 gist scope 的细粒度 token）访问；读写失败时降级为"当天建立基线"，不影响登录与签到。
- 详见 [DEPLOY.md](DEPLOY.md)。

## 本地运行

需先在环境变量里提供凭据（否则脚本会抛 `... env required`）：

```powershell
cd I:\Codex\web auto
$env:GH_USER="..."; $env:GH_PASS="..."; $env:GH_TOTP_SECRET="..."
$env:GOGOCS_EMAIL="..."; $env:GOGOCS_PASSWORD="..."
$env:GIST_ID="..."; $env:GIST_TOKEN="..."   # 可选：不配则跳过基线比较
node auto.js                   # 跑全部；或 $env:SITES="gogocs,agentrouter" 只跑部分
```

## 部署到 GitHub Actions

详见 [DEPLOY.md](DEPLOY.md)。
