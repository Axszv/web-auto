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

## 广告额度（+24.7/次，每天 3 次）—— CI 未成功，真机可靠

### 真机实测：决定成败的是「有没有 VPN 接口」，不是出口 IP

这是用户在小米 10 Pro 上的三组对照：

| 真机环境 | 结果 |
|---|---|
| v2rayNG VPN 模式（美国节点） | ❌ 当前无广告 |
| v2rayNG VPN 模式（香港 / 台湾节点） | ❌ 当前无广告 |
| 电脑 v2rayN 局域网共享，规则分流（广告域名直连） | ✅ 正常加载 |
| 电脑 v2rayN **全局模式**（台湾 IP，全流量走代理） | ✅ 正常加载，只是慢 |
| 完全不开代理 | ✅ 正常加载 |

**结论**：全局模式把所有流量（含 `tm.sigmob.cn` / `v2mi.gdt.qq.com` / `sdk.e.qq.com`）
都送进台湾节点，广告照样出货 —— 所以**出口 IP 地域不是决定因素**。
失败的三次全是「手机上有 VPN 接口」，v2rayNG 的 VPN 模式会被检测出来。

这也纠正了本文档早期的一个误判：我曾在模拟器上测「家宽 IP 也失败」，据此
推断「IP 不是原因」；后来又据此推断「IP 是概率因素」。两次都不对 —— 模拟器上
的失败是**容器识别**造成的，与 IP 无关；而真机上的失败是 **VPN 检测**，也与 IP 无关。

**对 CI 的意义**：Redroid 本身没有 VPN 接口，所以 VPN 检测这条不适用；
CI 失败纯粹是容器/模拟器被识别。

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
   但账户余额 686060 分毫未变。额度由**广告平台服务端回调**写入。
2. **只有一个广告位**（Sigmob slot `7368352132657660`）。每次点击 = 一次独立竞价，
   失败即弹「当前无广告，请稍后再试」。该 ID 硬编码在前端 JS，APK 里搜不到，
   没有第二个 slot 可换。
3. **`/api/reward/latest` 才是到账凭证**，`viewed_today` 只是次数计数。
   当前返回 `{"quota":120260,"success":true}` —— 注意它是**替换**不是累加。

### CI 上的失败原因（Frida 注入 Sigmob SDK 拿到）

Frida attach 到 App 进程，hook Sigmob 内部（日志包名是 `com.czhj.sdk.*`，
**不是** `com.sigmob.*` —— 后者只有资源类，一开始搜错了包名）。关键 hook 点：

- `com.czhj.sdk.logger.SigmobLog.{v,d,i,w,e,c,dd}` —— SDK 内部日志被强制打开
- `com.czhj.sdk.common.network.SigmobRequest.{parseNetworkResponse,getUrl,parseNetworkError}`

拿到的链路全貌：

```
[SIGMOB_REQ] https://tm.sigmob.cn/strategy/v6?appId=83185&sdkVersion=4.8.9
[SM.d] dcdebug:{... "event_type":"ready", "ecpm":"9000" ...}   ← 服务端竞价成功，出价很高
[SM.i] GDTRewardVideoAdapter onError 102006: 没有找到符合条件的广告
[SM.i] WMCustomRewardAdapter---callLoadFail()
[SIGMOB_REQ] https://win.gdt.qq.com/win_notice.fcg?...&loss=2&win_price=0
```

**服务端竞价是成功的**（多个 ADN 报 `event_type:"ready"`，最高 `ecpm:9000`），
**但客户端去各 ADN 真正拉素材时全部被拒**：GDT 反复返回 `102006 没有找到符合
条件的广告`，最终 `callLoadFail()` → 前端收到 `onVideoAdLoadError` +
`error_code:700000`。所有 `win_notice` 都是 `loss=2`。

App 里其实还直接集成了 GDT（appId 1219564395）和多个 GDT position_id，
Sigmob 只是聚合层。

也就是说：**服务端认为这台设备值得出 9000 的价，但 ADN 侧的客户端拉取被
「设备不符合条件」过滤掉了。** 这与真机侧的 VPN 检测是同一类机制。

### 已逐个实测排除的因素

| 因素 | 怎么排除的 |
|---|---|
| 出口 IP / 地域 | 真机全局模式走台湾 IP 照样出货；runner IP 采样全是美国 Azure 但真机换美国 IP 也没被单独归因 |
| root / su 痕迹 | 关掉雷电 root、`/system/bin/su` 与 `/system/xbin/su` 移除后，仍 700000 |
| 模拟器属性 | `ro.boot.qemu` 1→0、`phone.productname` dnplayer→star2qltechn、`ro.build.characteristics` tablet→phone，改完仍 700000 |
| 网络连通性 | 容器内 `dc.sigmob.cn` / `tm.sigmob.cn` / 自有后端 DNS + HTTPS 全部可达（`cdp fetch-test`） |
| VPN 接口 | Redroid 无 VPN，不适用；真机侧已确认这是独立的一个失败维度 |

顺带修掉的两个自己的 bug（这两个是真实缺陷，但都不是当前阻塞点）：

- **手滑 bug**：顶部提示「要**退出**，请从顶部向下滑动」被误当成「进入播放」，
  导致每轮广告刚拉起就被脚本自己关掉，CTA 点击打在后台窗口上。
- **CTA 坐标**：快手下载广告的「立即下载」是纯色图，按钮文字不渲染成可点击文本，
  旧兜底坐标 `(540,1500)` 落在「快手极速版」几个字上。按截图量改为 `(540,2172)`。
  实测真机该按钮文字是「点击打开或下载第三方应用」，能被 uiautomator 抓到。
- **OAID**：容器里 MSA SDK 报 `OAID 读取类创建失败`，退到 `getIMEI`（每次重启都变）。
  雷电其实自带 OAID provider（`com.android.flysilkworm`），但 MSA SDK 只认厂商
  特定接口，不认它，所以 App 仍拿不到 OAID。Sigmob 日志里有 `is_custom_oaid: 0`。

### 判据链路已 100% 验证可用

真机看一次广告后实测：

```
reward/latest : 123560 → 120260       ← 到账凭证更新（替换，不是累加）
adcap quota   : viewed_today 1→2, remaining 3→1
账户余额      : 686060 → 806320        ← 实际到账 +120260 quota = +0.2405 额度
```

三重判据（余额 + reward/latest + viewed_today）可靠，其中账户余额已改为直连
`af.52kele.cn` 的 new-api 登录接口读，不依赖 CDP。

### 历史成功率（仅供参照）

| 时间（UTC） | 结果 |
|---|---|
| 10-02 14:54 / 21:38 / 21:47 | ✅ 三次拿到快手素材 |
| 10-03 03:21 | ✅ 一次（round2 attempt10） |
| 10-03 01:48 / 02:17 / 04:49 及以后 | ❌ 全 700000 |

拿到素材的那几次也没结算，原因就是上面那两个自己的 bug，已修。

## 结论与建议

1. **签到自动化是确定的收益**（+30/天，OCR 验证码一次识别成功，已稳定运行）。
2. **广告额度目前只有真机看是可靠路径**（3 次 × 约 +24 = +74/天）。
3. **CI / 模拟器方案的瓶颈是广告平台的设备反作弊**，而不是 IP、网络或脚本逻辑。
   服务端竞价已经成功、出价高达 9000，被拒在 ADN 客户端拉素材这一环 ——
   这一环判定的是设备是否真实。继续往下走就是在和广告平台的反作弊对抗，
   收益不确定、投入会很大，且可能违反平台条款。
   **建议：不再投入这条线。**
4. CI 上的广告调度保留低频（每天 1 次 × 4 竞价），当碰运气看待。

## 复现方式（Frida 诊断）

诊断已跑完并清理干净（设备上的 frida 文件与进程、本地 436MB 的 `.frida-tmp/`
均已删除）。要复现：

```bash
# 1. 依赖装在项目目录（用完删）
mkdir -p .frida-tmp && cd .frida-tmp
npm install frida@17 frida-compile -D frida-java-bridge lzma-native

# 2. 取 frida-inject。Frida 17 已把 Java bridge 移出内核，agent 必须
#    import 'frida-java-bridge' 并用 frida-compile 打包，否则 'Java is not defined'
curl -LO https://github.com/frida/frida/releases/download/17.22.0/frida-inject-17.22.0-android-x86_64.xz
node -e "const f=require('fs'),z=require('lzma-native');
  f.createReadStream('frida-inject.xz').pipe(z.createDecompressor()).pipe(f.createWriteStream('frida-inject'))"
npx frida-compile agent5.ts -o agent5-bundle.js

# 3. 推送并 attach（adb 要带 -s；Git Bash 下需 MSYS_NO_PATHCONV=1）
adb -s 127.0.0.1:5555 push frida-inject /data/local/tmp/
adb -s 127.0.0.1:5555 shell "su -c 'nohup /data/local/tmp/frida-inject -D local -p <pid> -s /data/local/tmp/agent5-bundle.js > /data/local/tmp/f5.log 2>&1 &'"

# 4. 触发广告请求后读日志（中文经 adb 会被打成 ?，agent 里用 Base64 编码再解）
adb -s 127.0.0.1:5555 shell "su -c 'cat /data/local/tmp/f5.log'" | node scripts/decode-frida-log.js
```

关键包名是 **`com.czhj.sdk`**，别再搜 `com.sigmob`。