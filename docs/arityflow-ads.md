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
| 本机雷电模拟器（家宽国内 IP） | ❌ 同样 700000 |

排查过的方向，均已排除或非阻塞：

- **网络**：容器内 `dc.sigmob.cn` / `tm.sigmob.cn` / 自有后端 DNS 与 HTTPS 全部可达
  （`cdp fetch-test` 实测三个域名全 ok），所以跟墙、跟地域无关。
- **出口 IP**：用本机雷电（家宽、国内 IP）复测，依然 700000 —— **IP 假设被推翻**。
- **root / su 痕迹**：关掉雷电 root、`/system/bin/su` 与 `/system/xbin/su` 均已移除后复测，
  依旧 700000 —— **root 不是原因**。
- **模拟器属性伪装**：`ro.boot.qemu` 1→0、`phone.productname` dnplayer→star2qltechn、
  `ro.build.characteristics` tablet→phone，全部改掉后依旧 700000。
- **手滑 bug**：曾长期存在一个致命错误 —— 顶部提示「要**退出**，请从顶部向下滑动」
  被误当成「进入播放」，导致每轮广告刚拉起就被脚本自己关掉，CTA 点击打在后台窗口上。
  已修复（下滑手势只保留在 `close_ad` 里）。
- **CTA 坐标**：快手下载广告的「立即下载」是纯色图、按钮文字不渲染成可点击文本，
  旧兜底坐标 `(540,1500)` 落在「快手极速版」几个字上。已按截图量改为 `(540,2172)`。
  实测真机页面上该按钮文字是「点击打开或下载第三方应用」，能被 uiautomator 抓到，
  走文字匹配即可，不依赖坐标。
- **OAID**：容器里 MSA SDK 报 `OAID 读取类创建失败`，退到 `getIMEI`（每次重启都变）。
  雷电其实自带 OAID provider（`com.android.flysilkworm/.provider.OaidProvider`），
  但 MSA SDK 只认厂商特定接口，不认它，所以 App 仍拿不到 OAID。

### 真实原因（Frida 注入 Sigmob SDK 拿到）

用 Frida attach 到 App 进程，hook Sigmob 内部（日志包名是 `com.czhj.sdk.*`，
**不是** `com.sigmob.*` —— 后者只有资源类，一开始搜错了包名）。关键 hook 点：

- `com.czhj.sdk.logger.SigmobLog.{v,d,i,w,e,c,dd}` —— SDK 内部日志被强制打开
- `com.czhj.sdk.common.network.SigmobRequest.{parseNetworkResponse,getUrl,parseNetworkError}`

拿到的链路全貌：

```
[SIGMOB_REQ] https://tm.sigmob.cn/strategy/v6?appId=83185&sdkVersion=4.8.9
[SM.d] dcdebug:{... "placement_id":"7368352132657660", "carrier":"46000",
                 "networktype":"100", "is_custom_oaid":"0", "uid":"52875e2f...",
                 "time_zone":"Asia/Shanghai", "seconds_from_GMT":"8" ...}
[SM.i] GDTAdapterProxy initializeADN:1219564395
[SM.d] dcdebug:{... "aggr_placement_id":"7387693363852159", "event_type":"ready", "ecpm":"9000" ...}
[SM.i] GDTRewardVideoAdapter onError 102006: 没有找到符合条件的广告
[SM.i] WMCustomRewardAdapter---callLoadFail()
[SIGMOB_REQ] https://win.gdt.qq.com/win_notice.fcg?...&loss=2&win_price=0&win_seat=2
```

**结论**：这不是「没有广告」，而是**服务端竞价成功、客户端取不到素材**。

- Sigmob 是聚合平台，一次请求会同时调度多个 ADN。服务端侧竞价是成功的 ——
  多个 ADN 回报 `event_type:"ready"`，最高出价 `ecpm:9000`（90 元/千次）。
- 但客户端去各 ADN 真正拉素材时，GDT 反复返回 `102006 没有找到符合条件的广告`
  和 `109502 该广告位请求失败`，最终 `WMCustomRewardAdapter callLoadFail()`
  → 前端收到 `onVideoAdLoadError` + `error_code:700000`。
- 所有 `win_notice` 都是 `loss=2`（竞价失败通知）。

也就是说，**模拟器/容器在广告平台的设备识别这一关过不去**。这不是脚本能改的东西：
可改的变量（IP、root、属性、OAID）都已逐个实测排除。CI 与模拟器方案到此为止。

### 判据链路已 100% 验证可用

真机看一次广告后实测：

```
reward/latest : 123560 → 120260       ← 到账凭证更新（注意是替换，不是累加）
adcap quota   : viewed_today 1→2, remaining 3→1
账户余额      : 686060 → 806320        ← 实际到账 +120260 quota = +0.2405 额度
```

`/adcap/api/view` 只扣次数不发额度；额度由广告平台服务端回调写入。
`/api/reward/latest` 是到账凭证。三重判据（余额 + reward/latest + viewed_today）可靠。

### 历史成功率（仅供参考，说明时段时间无关）

| 时间（UTC） | 结果 |
|---|---|
| 10-02 14:54 / 21:38 / 21:47 | ✅ 三次拿到快手素材 |
| 10-03 03:21 | ✅ 一次（round2 attempt10） |
| 10-03 01:48 / 02:17 / 04:49 | ❌ 共 48 次竞价全 700000 |

拿到素材的那几次也没结算，原因就是上面那个手滑 bug + CTA 点错位置，已修。

## 结论与建议

1. **签到自动化是确定的收益**（+30/天，OCR 验证码一次识别成功，已稳定运行）。
2. **广告额度目前只有真机手动看是可靠路径**（3 次 × 约 +24 = +74/天）。
3. **CI / 模拟器方案已到技术尽头**。真实原因已用 Frida 定位到广告平台侧的设备识别
   （服务端竞价成功、客户端取不到素材），所有可控变量都实测排除过。要继续攻只剩两条路，
   都需要真机配合：
   - 在真机上跑同样的 Frida hook，对比真机与模拟器的 ADN 竞价差异，定位到底是哪个
     设备维度被过滤；
   - 做一个「像真机」的云真机 / 或干脆用真机挂自动化（如 Tasker / Auto.js 定时触发），
     这不再是纯 CI 方案。
4. CI 上的广告调度已降频保留（每天 2 次 × 6 竞价），当碰运气看待，不要预期产出。

## 复现方式

Frida 诊断已跑完并清理干净（设备上的 `frida-server` / `frida-inject` / agent 文件，
以及本地 436MB 的 `.frida-tmp/` 全部删除）。要复现：

```bash
# 1. 依赖装在项目目录（用完删）
mkdir -p .frida-tmp && cd .frida-tmp
npm install frida@17 frida-compile -D frida-java-bridge lzma-native

# 2. 取 frida-inject（Frida 17 已把 Java bridge 移出内核，agent 必须
#    import 'frida-java-bridge' 并用 frida-compile 打包，否则报 'Java is not defined'）
curl -LO https://github.com/frida/frida/releases/download/17.22.0/frida-inject-17.22.0-android-x86_64.xz
node -e "const f=require('fs'),z=require('lzma-native');
  f.createReadStream('frida-inject.xz').pipe(z.createDecompressor()).pipe(f.createWriteStream('frida-inject'))"
npx frida-compile agent5.ts -o agent5-bundle.js

# 3. 推送并 attach（注意 adb forward 要带 -s，Git Bash 下要 MSYS_NO_PATHCONV=1）
adb -s 127.0.0.1:5555 push frida-inject /data/local/tmp/
adb -s 127.0.0.1:5555 shell "su -c 'nohup /data/local/tmp/frida-inject -D local -p <pid> -s /data/local/tmp/agent5-bundle.js > /data/local/tmp/f5.log 2>&1 &'"

# 4. 触发广告请求后读日志
adb -s 127.0.0.1:5555 shell "su -c 'cat /data/local/tmp/f5.log'" | node scripts/decode-frida-log.js
```

中文经 adb 会被打成 `?`，agent 里统一用 `Base64.encodeToString` 传回再解，
详见 `docs` 上文的 hook 清单。关键包名是 **`com.czhj.sdk`**，别再搜 `com.sigmob`。