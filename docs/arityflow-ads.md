# ArityFlow 激励视频自动化 —— 现状与结论

最后更新：2026-10-03

## 一句话结论

**签到自动化已经稳定成功；广告额度自动化目前 0 成功，卡在广告平台不向 CI 环境投放，
不是脚本 bug。**

## 已确认可用 ✅

### 每日签到（+30 额度/天）

`sites/arityflow.js` + `.github/workflows/daily.yml`

- 站点：`https://qd.arityflow.top`（签到站，与 App 账户站是两套系统）
- 验证码：图片验证码，`lib/captcha_ocr.py` 用 ddddocr 识别，5 次重试
- 真实产出：`{"reward":30,"streak":3,"cycle_position":3,"cycle_days":7,"date":"2026-10-03"}`

## 广告额度（+24.7/次，每天 3 次）—— 未成功 ❌

### 已还原的完整链路

从 App 前端 bundle（`https://afapp.ahne.cn/assets/app-*.js`）里挖出来的真实流程：

```
点击「看广告」
  → jsBridge.tobid.reward({ adId:"7368352132657660", userId })   // 原生拉起 Sigmob 激励视频
  → 视频播完 / 完成下载，SDK 回调 onVideoRewarded
  → POST https://af.52kele.cn/adcap/api/view   {oaid}            // 只扣次数，不发额度
  → GET  https://callback.af-freeapi.top/api/reward/latest?userId=  // 拉取到账金额并提示「🎉 +x 已到账」
  → GET  https://af.52kele.cn/api/user/self                        // 刷新余额
```

三个容易踩错的地方：

1. **`POST /adcap/api/view` 不发额度**。实测：调用后 `viewed_today 0→1`、`remaining 3→2`，
   但账户余额 686060 分毫未变。额度由**广告平台服务端回调**写入，HTTP 无法伪造。
2. **只有一个广告位**（Sigmob slot `7368352132657660`）。每次点击 = 一次独立竞价，
   失败即弹「当前无广告，请稍后再试」。前端常量 `DAILY_LIMIT:10` 是软上限，
   服务端 `daily_limit` 才是硬上限 3。
3. **`/api/reward/latest` 才是到账凭证**，`viewed_today` 只是次数计数。
   当前返回 `{"quota":123560,"success":true}`，即 +24.7 —— 这是 10-02 真机那次留下的记录。

### 广告平台

- 主 SDK：**Sigmob**（`dc.sigmob.cn` / `tm.sigmob.cn`），报错 `error_code:700000 无广告返回`
- App 里还集成了**腾讯广点通 GDT**，其请求在容器内一直 `Read timed out`
- Sigmob 有专门的 `getloadFailMessage` 接口能给出具体拒绝理由，
  但 App 的 `jsBridge.tobid` 没有暴露它（只有 `reward/interstitial/banner/ksTube/
  setListener/removeListener/requestPermissionIfNecessary`），所以拿不到细因。

### 卡在哪：环境，不是代码

| 环境 | 结果 |
|---|---|
| 真机（国内网络 + 真实 IMEI/OAID） | ✅ 稳定出广告，+24.7 到账 |
| GitHub Actions ARM runner + Redroid | ❌ 绝大多数 700000 |

排查过的方向，均已排除或非阻塞：

- **网络**：容器内 `dc.sigmob.cn` / `tm.sigmob.cn` / 自有后端 DNS 与 HTTPS 全部可达
  （`cdp fetch-test` 实测三个域名全 ok），所以跟墙、跟地域无关。
- **手滑 bug**：曾长期存在一个致命错误 —— 顶部提示「要**退出**，请从顶部向下滑动」
  被误当成「进入播放」，导致每轮广告刚拉起就被脚本自己关掉，CTA 点击打在后台窗口上。
  已修复（下滑手势只保留在 `close_ad` 里）。
- **CTA 坐标**：快手下载广告的「立即下载」是纯色图、按钮文字不渲染成可点击文本，
  旧兜底坐标 `(540,1500)` 落在「快手极速版」几个字上。已按截图量改为 `(540,2172)`。
- **OAID**：容器里 MSA SDK 报 `OAID 读取类创建失败`，退到 `getIMEI`（每次重启都变）。
  这是真实缺陷，但历史上无 OAID 时也拿到过素材，**不是阻塞项**。

### 剩余假设：CI 出口 IP 信誉

成功率随时间下降，且与具体时段无关：

| 时间（UTC） | 结果 |
|---|---|
| 10-02 14:54 / 21:38 / 21:47 | ✅ 三次拿到快手素材 |
| 10-03 03:21 | ✅ 一次（round2 attempt10） |
| 10-03 01:48 / 02:17 / 04:49 | ❌ 共 48 次竞价全 700000 |

GitHub Actions 的出口 IP 来自共享池，对中国广告平台而言信誉不高。连续高频竞价
（20+ run、近 200 次）后被限流，是目前最合理的解释，但**尚未拿到 SDK 的细因佐证**。

因此调度已改为**每天两次、每次 6 竞价、间隔 90 秒**，刻意压低频率给 IP 留恢复窗口。

## 结论与建议

1. 想要每天额外 74.1 额度，**目前只有真机看广告是确定可靠的**。
2. CI 方案保留低频重试，但请按「碰运气」看待，不要预期稳定产出。
3. 若要继续攻关，最有价值的一步是**拿到 Sigmob 的 `getloadFailMessage`**，
   那样就不用再靠统计推断。可行路径：hook APK 的 jsBridge 桥接层，或改用有 GMS 的
   设备指纹（Redroid 无 GMS，OAID 也取不到）。