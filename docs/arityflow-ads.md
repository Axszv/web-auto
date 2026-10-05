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

## Frida 路线的结论（已放弃）

2026-10-04 尝试用 Frida hook `TelephonyManager.getDeviceId()`，把 Redroid 生成的
假 IMEI（`5efb42d032e3dde4`，16 位纯 hex）换成格式合法的真机值
（`8609110312345670`，小米 TAC + Luhn 校验位）。

**结果：CI 上不可用。** Frida 17 的 Go 版 frida-inject 在 attach 成功后脚本加载即
`Connection closed`；降到 14.2.18（Python 版客户端）后错误变成
`Unexpected lack of content trying to read a line`。两种情况都说明 agent 没有真正
跑起来，所以**「SDK 到底认不认这个 IMEI」这个假设至今没有被验证过**。

工具链本身在 CI 上全部打通了（server 起动、agent 754KB 打包、inject 下载、
参数 `-D socket`、su 提权、绝对路径日志），卡点只在最后的脚本加载。
本地（雷电）用同一套代码 hook Sigmob 是成功的，所以方案本身可行，
但这个容器组合用不了。代码保留在 `scripts/frida/`，需要时可再启用
（`ENABLE_FRIDA=1`）。

**这条线一共花了约 13 轮 run，绝大部分花在修工具链自身的问题上**
（架构不兼容的参数体系、gitignore 静默吞文件、TS 编译错误、
下载逻辑被自己重构删掉、相对路径写不进 artifact……），
真正有价值的只有最后通过看截图发现的 CTA 坐标问题。

## 快手广告的两种页面形态（重要）

`run 37207187861` 的截图揭示了 CTA 坐标为什么一直点空：

| 形态 | 按钮 | 原始坐标 |
|---|---|---|
| A 沉浸式视频 + 底部卡片 | 点击打开或下载第三方应用 | (540, 2172) |
| B 应用详情页 | 红色「立即下载」大按钮 | **(540, 1676)** |

差了近 500 像素。之前只有 2172，命中 B 时完全点空 ——
`cta-clicked.png` 和 `after-cta.png` 两张截图一模一样，画面零变化，
说明是「没点到」而不是「点了没结算」。

现在改成候选坐标依次点击（1676 / 2100 / 2172），点完一个就检查广告是否还在
前台，离开即说明点中并跳转了。

另外：这两轮里 uiautomator dump 到的文本都是点击前的旧内容（有延迟），
所以不能只依赖 dump 找按钮，坐标候选是必要的兜底。

---

## 2026-10-05 突破：拿到 GDT 真实错误文案

用 Frida attach 到本机雷电模拟器（x86_64，frida-server 17.2.17），hook Sigmob SDK
（真实包名 `com.czhj.sdk.*`，**不是** `com.sigmob.*`——后者只有资源类）和 GDT
适配器（`com.windmill.gdt.*`，不是 `com.qq.e.ads.*`），把错误码解出来。

**怎么解出中文的**：adb shell 会把中文打成 `?`，所以 agent 里用
`Base64.encodeToString` 把 UTF-8 编码后传回，宿主端再解码。

### 真实错误

| 错误码 | 次数 | 含义 |
|---|---|---|
| 102006 | 311 | 没有找到符合**价格**要求或**体验**要求的广告 |
| 109502 | — | 该广告位**请求量大而收入较低**，出于成本考虑降低填充 |

**109502 是决定性的** —— GDT 拒绝的不是「这个设备」，而是「这个 IP 的请求模式」。

### 这解释了几周来所有想不通的地方

- **为什么 CI 上 10-02 成功率高于 10-03**：不是设备变了，是**请求累积量**。
- **为什么真机从没触发过**：真机一天就 3 次请求。
- **为什么改了那么多设备伪装都没用**：闸门在流量统计，不在设备字段。
- **为什么加大竞价次数完全无效**：每次都在被降权。

### 本地验证到的东西

1. **`setprop ro.*` 在雷电上真的能改，且重启后持久化** —— 我之前断定「改不动」
   是错的。CI 上失败是因为 Redroid 的 `adb shell` 是 `uid=2000(shell)`，su 压根没执行。
   但雷电上改一个 `ro.*` 会让 `getprop | wc -l` 段错误（固件对 getprop 全量遍历有边界
   处理），所以直接改属性有风险。
2. **Frida hook `android.os.Build` 静态字段完全可行**，成功改 19 项（MODEL/BRAND/
   DEVICE/FINGERPRINT 等），无崩溃。这正是 AndroidIdChanger 背后的机制 —— 它用
   Xposed 干同样的事。改 Build 字段**不碰 property service**，避开了 getprop 段错误。
3. **IMEI/OAID 伪装验证成功**：hook `TelephonyManager` 8 项 +
   `Settings.Secure.ANDROID_ID` + `ContentResolver.query(OAID)`，读回确认
   `getIMEI=8609110312345670`（15 位十进制 + Luhn 校验 + 小米 TAC 86091103）。
4. **但即使全部伪装，102006 依然存在** —— 印证闸门是流量统计而非设备。

### 调度调整

CI 调度降到**每天 1 次 × 2 次竞价**。理由：GDT 报错明说请求频率会被判为低价值
流量，多跑不提高命中率，反而被降填充。

### 待验证（静默期测试）

停止请求 40 分钟让 GDT 流量统计衰减后复测，观察 109502 是否消失。这将最终确认
「请求量过大导致降填充」这一根因。

### 静默期复测：证实了滑动窗口机制

| 阶段 | 请求数 | 109502 是否出现 |
|---|---|---|
| 高频（今天累计 400+ 次） | 311 | ✅ 出现 |
| 静默 40 分钟后复测 | 10 | ❌ 消失 |
| 三层伪装全开再测（隔几分钟） | 10 | ✅ **又出现** |

**结论：GDT 的「请求量大而收入较低」是滑动窗口降填充机制** —— 几分钟的高频请求就能
重新触发，40 分钟静默能让它消失。

**这解释了所有历史数据**：
- 10-02 成功：那天请求量还没累积起来
- 10-03 之后全灭：请求量累积到触发降填充
- 真机从没触发：真机一天就 3 次请求，远低于阈值

**三层伪装全部验证有效但不够**：
- Build 静态字段 19 项 ✅
- IMEI/OAID/IMSI 10 项 ✅（getIMEI 读回 8609110312345670）
- SystemProperties ✅（ro.hardware 读回 qcom、fingerprint 读回 Xiaomi/pudding）

即使三层全开，102006 依然存在 —— 说明闸门是**流量统计维度**，不是设备指纹维度。
**设备伪装方向可以判定：不足以解决问题。**

**CI 调度已定为每天 1 次 × 2 竞价**（约 2 次/天，远低于真机的 3 次/天且分散在 24 小时里）。
