#!/usr/bin/env bash
# ArityFlow 看广告自动化：Redroid ARM64 上驱动真实 App 播放激励视频
# 机制（已实测）：纯 HTTP POST /adcap/api/view {oaid} 只扣次数不发额度；
# 真实播放后由广告 SDK 回调 callback.af-freeapi.top 发放 +24.7/次，每天上限 3 次
set -uo pipefail

apk="${1:-artifacts/ArityFlow.apk}"
out="${2:-diagnostics}"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
mkdir -p "$out"

PKG="com.klkjapp.www"
ACT="com.lt.app.MainActivity"
MAX_ADS="${MAX_ADS:-3}"
ADS_ATTEMPTS="${ADS_ATTEMPTS:-16}"   # 竞价密度：最后一次成功是在 round2 attempt10（第26次点击）才出货，砍到4次等于把唯一能出货的区间切掉了
ADS_RETRY_WAIT="${ADS_RETRY_WAIT:-60}" # 两次竞价间隔；8s 连发会被限流，20s 能出货，成功那版用的就是这个量级
OAID="1ed4c87b179ff56d"   # 从真机抓包拿到的设备标识（不依赖原生桥，避免 IMEI 权限问题）

# 指定唯一设备（ARM runner 上可能有多设备/残留）
SERIAL=127.0.0.1:5555
export ANDROID_SERIAL="$SERIAL"

adb_run()  { adb shell "$@"; }
adb_quick() { timeout 25s adb shell "$@" 2>/dev/null || true; }

screenshot() { adb exec-out screencap -p > "$out/$1.png" 2>/dev/null || true; }
dump_ui()    { adb_run uiautomator dump "/sdcard/$1.xml" >/dev/null 2>&1 || true
                adb exec-out cat "/sdcard/$1.xml" 2>/dev/null > "$out/$1.xml" || true; }

# 前台 activity（广告 SDK 打开时会切到 SDK 自己的 Activity）
resumed_activity() {
  adb_quick dumpsys activity activities 2>/dev/null \
    | grep -E 'topResumedActivity=|mResumedActivity:|ResumedActivity:' | tail -n 1
}

# 目标站页面：MainActivity(登录/首页) / SplashActivity。其它 = 广告 SDK 浮层在前台
ad_is_open() {
  local r; r="$(resumed_activity)"
  [[ -z "$r" ]] && return 1
  grep -Eqi 'SplashActivity|MainActivity|launcher3|ResolverActivity' <<<"$r" && return 1
  return 0
}

# 原生权限弹窗：点「ALLOW / WHILE USING」放行。返回 0=处理了一个弹窗
handle_perm_dialog() {
  [[ "$(resumed_activity)" == *"GrantPermissionsActivity"* ]] || return 1
  adb_run input tap 540 1261 >/dev/null 2>&1 || true   # 两选项弹窗的 ALLOW
  sleep 2
  # 仍是权限弹窗（三选项定位框）则点「WHILE USING THE APP」
  if [[ "$(resumed_activity)" == *"GrantPermissionsActivity"* ]]; then
    adb_run input tap 540 1531 >/dev/null 2>&1 || true
    sleep 2
  fi
  return 0
}

# 快手/穿山甲等沉浸式广告顶部有「全屏模式，要退出请从顶部向下滑动」入口页，
# 返回键无效，必须用顶部下滑手势才能进入真正播放或退出
enter_or_exit_fullscreen() {
  adb_run input swipe 540 80 540 900 300 >/dev/null 2>&1 || true
  sleep 3
}

# 激励视频结算需要点 endcard 的行动按钮（快手「立即下载」/抖音「下载」/微信小程序等），
# 点后等 15 秒才 onVideoRewarded 结算。广告是原生 Activity，uiautomator 能抓到按钮文字。
# 注意：Android 上按钮常常只有 content-desc 没有 text，两个都要匹配。
ui_dump() { adb_quick uiautomator dump "/sdcard/ui.xml" >/dev/null 2>&1 || true
            adb exec-out cat /sdcard/ui.xml 2>/dev/null; }

# Android 沉浸式模式的系统提示「目前处于全屏模式，要退出请从顶部向下滑动 / 知道了」
# 会一直叠在广告上方。实测截图里它占掉了顶部 22% 屏，每次广告拉起都重新出现。
# 每次进入广告先点掉它，否则会一直挡着，也容易被后续手势误触。
dismiss_immersive_tip() {
  local xml xy
  xml="$(ui_dump)"
  [[ -z "$xml" ]] && return 1
  xy="$(node -e "
    const xml=require('fs').readFileSync(0,'utf8');
    if(!/全屏模式|向下滑动/.test(xml)) process.exit(0);
    const nodes=[...xml.matchAll(/<node[^>]*>/g)].map(m=>m[0]);
    for(const n of nodes){
      const t=((n.match(/text=\"([^\"]*)\"/)||[])[1]||'').trim();
      const d=((n.match(/content-desc=\"([^\"]*)\"/)||[])[1]||'').trim();
      if(t==='知道了'||d==='知道了'){
        const b=n.match(/bounds=\"\[(\d+),(\d+)\]\[(\d+),(\d+)\]\"/);
        if(b){ console.log(Math.round((parseInt(b[1])+parseInt(b[3]))/2)+' '+Math.round((parseInt(b[2])+parseInt(b[4]))/2)); process.exit(0); }
      }
    }
  " <<<"$xml" 2>/dev/null)"
  if [[ -n "$xy" ]]; then
    echo "[tip] 关闭沉浸式全屏提示 tap $xy"
    adb_run input tap $xy >/dev/null 2>&1 || true
    sleep 1
    return 0
  fi
  return 1
}

# CTA 兜底坐标：实测快手下载类广告的「立即下载」蓝色按钮是整块纯色，
# 文字不渲染成可点击文本（uiautomator 抓不到），只能按位置点。
# 1080x2400 屏上该按钮区间约 y=2030..2320，中心 (540, 2172)。
# 之前的兜底是 (540,1500) —— 落在「快手极速版」文字区域，点了个寂寞。
CTA_FALLBACK="${CTA_FALLBACK:-540 2172}"

click_cta() {
  local xml; xml="$(ui_dump)"
  if [[ -z "$xml" ]]; then
    echo "[cta] dump 为空（全屏 Canvas/Surface 渲染），坐标兜底 $CTA_FALLBACK"
    adb_run input tap $CTA_FALLBACK >/dev/null 2>&1 || true
    sleep 2
    return 0
  fi
  echo "$xml" > "$out/cta-r${CURRENT_ROUND}-endcard.xml"

  # 打印可见文本摘要：定位不到按钮时靠它判断广告到底处于什么状态
  node -e "
    const xml=require('fs').readFileSync(0,'utf8');
    const nodes=[...xml.matchAll(/<node[^>]*>/g)].map(m=>m[0]);
    const seen=new Set();
    for(const n of nodes){
      const t=((n.match(/text=\"([^\"]*)\"/)||[])[1]||'').trim();
      const d=((n.match(/content-desc=\"([^\"]*)\"/)||[])[1]||'').trim();
      const s=t||d; if(s) seen.add(s);
    }
    console.log('[cta] 可见文本: '+[...seen].slice(0,40).join(' | ').slice(0,500));
  " <<<"$xml" 2>/dev/null || true

  # 找行动按钮：优先下载/安装类，其次打开/继续/领取
  local xy
  xy="$(node -e "
    const xml=require('fs').readFileSync(0,'utf8');
    const nodes=[...xml.matchAll(/<node[^>]*>/g)].map(m=>m[0]);
    const pick=(kw,skip)=>{
      for(const n of nodes){
        const t=((n.match(/text=\"([^\"]*)\"/)||[])[1]||'').trim();
        const d=((n.match(/content-desc=\"([^\"]*)\"/)||[])[1]||'').trim();
        const lbl=t||d;
        if(!lbl) continue;
        if(kw.some(k=>lbl.includes(k)) && !skip.some(k=>lbl.includes(k))){
          const b=n.match(/bounds=\"\[(\d+),(\d+)\]\[(\d+),(\d+)\]\"/);
          if(b) return [ (parseInt(b[1])+parseInt(b[3]))/2, (parseInt(b[2])+parseInt(b[4]))/2 ];
        }
      }
      return null;
    };
    const hit = pick(['立即下载','下载','安装','打开','继续','领取','查看广告','查看'], ['关闭','跳过','以后再说','不再','取消'])
             || pick(['广告'], []);
    if(hit) console.log(Math.round(hit[0])+' '+Math.round(hit[1]));
  " <<<"$xml" 2>/dev/null)"
  if [[ -n "$xy" ]]; then
    echo "[cta] tap $xy"
    adb_run input tap $xy >/dev/null 2>&1 || true
  else
    echo "[cta] UI 树里没有可点文字（快手的下载按钮是纯色图），坐标兜底 $CTA_FALLBACK"
    adb_run input tap $CTA_FALLBACK >/dev/null 2>&1 || true
  fi
  sleep 2

  # 部分广告点完会弹二次确认（「是否立即下载」/「打开应用商店」）或跳转应用商店，
  # 那样同样拿不到结算，必须把确认框点掉。
  #
  # 但绝不能在这里点「知道了」—— 那是 Android 沉浸式全屏提示的关闭按钮，
  # 点它等于把广告关掉。之前没排除这个词，导致：点完 CTA 后系统提示框还在，
  # 就被当成二次确认又点了一遍，广告被关掉，奖励自然不结算
  #（失败轮日志：二次确认 tap 860 527 → round 1 播了但没发奖）。
  # 成功轮只是恰好提示框已经消失才没踩到，所以这个 bug 时隐时现。
  local xml2; xml2="$(ui_dump)"
  if [[ -n "$xml2" ]]; then
    # 若 UI 树里还带着沉浸式提示词，说明这仍是系统提示而非下载确认框，跳过
    if grep -qE '全屏模式|向下滑动' <<<"$xml2"; then
      echo "[cta] 仍有沉浸式提示（非二次确认场景），跳过"
      return 0
    fi
    local xy2
    xy2="$(node -e "
      const xml=require('fs').readFileSync(0,'utf8');
      const nodes=[...xml.matchAll(/<node[^>]*>/g)].map(m=>m[0]);
      const kw=['确定','确认','允许','继续','是','好的','立即','去安装'];
      const skip=['取消','否','关闭','以后','设置','未知来源'];
      for(const n of nodes){
        const t=((n.match(/text=\"([^\"]*)\"/)||[])[1]||'').trim();
        const d=((n.match(/content-desc=\"([^\"]*)\"/)||[])[1]||'').trim();
        const lbl=t||d; if(!lbl) continue;
        if(kw.some(k=>lbl===k||lbl.includes(k)) && !skip.some(k=>lbl.includes(k))){
          const b=n.match(/bounds=\"\[(\d+),(\d+)\]\[(\d+),(\d+)\]\"/);
          if(b){ console.log(Math.round((parseInt(b[1])+parseInt(b[3]))/2)+' '+Math.round((parseInt(b[2])+parseInt(b[4]))/2)); process.exit(0); }
        }
      }
    " <<<"$xml2" 2>/dev/null)"
    if [[ -n "$xy2" ]]; then
      echo "[cta] 二次确认 tap $xy2"
      adb_run input tap $xy2 >/dev/null 2>&1 || true
      sleep 2
    fi
  fi
  return 0
}

close_ad() {
  ad_is_open || return 0        # 广告已不在前台就别乱点，否则会把主界面点花
  for _ in 1 2 3 4 5; do
    handle_perm_dialog && continue
    adb_run input keyevent 4 >/dev/null 2>&1 || true
    sleep 3
    ad_is_open || return 0
    enter_or_exit_fullscreen          # 顶部下滑退出（这才是这个手势的正确用途）
    ad_is_open || return 0
    adb_run input tap 985 88 >/dev/null 2>&1 || true   # 右上角关闭
    sleep 3
    ad_is_open || return 0
  done
  adb_run input keyevent 3 >/dev/null 2>&1 || true
  sleep 3
}

# 每轮开始前确认 App 还停在首页且「看广告」按钮还在。
# 上一轮收尾时 close_ad 把界面点坏，第三轮 16 次全是 no-ad-btn，等于白跑一轮。
ensure_app_ready() {
  if [[ "$(cdp status)" == *'"hasAdBtn":true'* ]]; then
    return 0
  fi
  echo "[ad] 首页按钮不可用，重启 App 恢复"
  adb_run am force-stop "$PKG" >/dev/null 2>&1 || true
  sleep 3
  adb_run am start -n "$PKG/$ACT" >/dev/null 2>&1 || true
  sleep 28
  for _ in $(seq 1 20); do
    adb shell "cat /proc/net/unix" 2>/dev/null | grep -q "webview_devtools_remote" && break
    sleep 2
  done
  if [[ "$(cdp status)" == *"hasLogin\":true"* ]]; then
    echo "[ad] 需重新登录: $(cdp login "$ARITY_USER" "$ARITY_PASS")"
    for _ in $(seq 1 25); do
      sleep 3
      [[ "$(cdp status)" != *"hasLogin\":true"* ]] && break
    done
  fi
  dismiss_immersive_tip || true
  echo "[ad] 恢复后: $(cdp status | head -c 200)"
}

api_get_quota() {
  # 从 runner 宿主侧查（Redroid 容器内无 curl/wget）
  node -e "
    fetch('https://af.52kele.cn/adcap/api/quota', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ oaid: '$OAID' })
    }).then(r => r.text()).then(t => console.log(t)).catch(e => console.log('ERR:' + e.message));
  " 2>/dev/null
}

# App 内账户额度（localStorage 里的 user.quota）。这是与账号绑定的权威判据：
# adcap/quota 依赖 OAID 匹配，OAID 一旦取不到真值（容器里常退回 InstallId），
# viewed_today 就恒为 0，看起来像"没结算"，其实是查错了账号维度。
account_quota() {
  local q; q="$(api_account_quota)"
  [[ -z "$q" ]] && q="$(cdp user-info | node -e "
    let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{
      try{
        const j=JSON.parse(d.trim());
        const u=j.user||{};
        console.log(String(u.quota ?? u.balance ?? u.amount ?? ''));
      }catch{ console.log(''); }
    })
  " 2>/dev/null)"
  printf '%s' "$q"
}

# 账户余额直连后端：af.52kele.cn 是标准 new-api 站（/api/user/login + /api/user/self），
# 登录一次就能读到账号真实 quota。这样判据完全不依赖 WebView/CDP ——
# 即使广告浮层把 WebView 挡住、或 CDP 断了，奖励是否到账依然可判定。
api_account_quota() {
  node -e "
    (async () => {
      const r = await fetch('https://af.52kele.cn/api/user/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: process.argv[1], password: process.argv[2] })
      });
      const j = JSON.parse(await r.text());
      const t = j.data.access_token, uid = String(j.data.user.id);
      const s = await fetch('https://af.52kele.cn/api/user/self', {
        headers: { 'Authorization': 'Bearer ' + t, 'New-Api-User': uid }
      });
      console.log((JSON.parse(await s.text()).data).quota);
    })().catch(() => console.log(''));
  " "$ARITY_USER" "$ARITY_PASS" 2>/dev/null
}

# 广告奖励的「到账凭证」。前端在 onVideoRewarded 后就是拉这个接口并提示
# 「🎉 +x 已到账」—— 它比 viewed_today 更权威：viewed_today 只是次数，
# 这个才是广告平台回调服务端真正发放的那笔额度（单位与账户 quota 相同）。
api_reward_latest() {
  node -e "
    fetch('https://callback.af-freeapi.top/api/reward/latest?userId=$ADS_UID', {
      headers: { 'Accept': 'application/json' }
    }).then(r => r.text()).then(t => console.log(t)).catch(e => console.log('ERR:' + e.message));
  " 2>/dev/null
}

# 额度数值化（new-api 的 quota 是 ×500000 的整数），返回可比较的浮点
quota_num() {
  node -e "
    const v=parseFloat(process.argv[1]);
    console.log(isFinite(v)? String(v/500000) : '');
  " "$1" 2>/dev/null
}

# WebView 页面 uiautomator dump 抓不到内部文字，改用 CDP 直连 WebView DOM 操作。
app_pid() { adb shell pidof "$PKG" 2>/dev/null | tr -d '\r\n'; }
cdp() {
  local pid; pid="$(app_pid)"
  if [[ -z "$pid" ]]; then echo "CDP_ERR:no-pid"; return; fi
  node "$script_dir/webview-cdp.js" "$SERIAL" "$pid" "$@" 2>&1 || echo "CDP_ERR:node-failed"
}

echo "[ad] install apk"
adb install -r -d "$apk" 2>&1 | tee "$out/install.log" | tail -2

# 固定设备身份。Redroid 每次启动 android_id 都是随机生成的，对广告 SDK 来说
# 等于「每次都换一台全新设备来索要广告」—— 这本身就是典型的异常流量特征。
# 固定成一个稳定值，让 SDK 眼里的这台设备是有连续行为的老设备，而不是
# 每天开机一次的陌生机器。IMEI 在容器里改不了（TelephonyManager 生成），
# 但 android_id 是广告 SDK 一定会采的字段。
STABLE_ANDROID_ID="${STABLE_ANDROID_ID:-7d3f1a9c5e2b8406}"
adb_run settings put secure android_id "$STABLE_ANDROID_ID" >/dev/null 2>&1 || true
# 国内设备默认不限制广告跟踪；显式关掉，避免被当作隐私严格型设备而少填充
adb_run settings put secure limit_ad_tracking 0 >/dev/null 2>&1 || true
echo "[ad] device identity: android_id=$(adb_quick settings get secure android_id 2>/dev/null | tr -d '\r') limit_ad_tracking=$(adb_quick settings get secure limit_ad_tracking 2>/dev/null | tr -d '\r')"

# Root / 模拟器痕迹自查。广告 SDK 的反作弊常把这些当一票否决项 ——
# 容器本身就是 --privileged 起的，痕迹藏不干净，但至少要知道有哪些。
{
  echo "--- root 痕迹"
  for f in /system/xbin/su /system/bin/su /sbin/su /su/bin/su /system/app/Superuser.apk; do
    adb_quick ls "$f" >/dev/null 2>&1 && echo "存在: $f"
  done
  echo "--- 关键属性（SDK 会读）"
  for p in ro.debuggable ro.secure ro.build.tags ro.build.type ro.kernel.qemu \
           ro.hardware ro.product.cpu.abi ro.build.characteristics ro.boot.verifiedbootstate; do
    printf '%s = %s\n' "$p" "$(adb_quick getprop "$p" 2>/dev/null | tr -d '\r')"
  done
  echo "--- 已装可疑包（root/模拟器/抓包）"
  adb_quick pm list packages 2>/dev/null \
    | grep -iE 'supersu|magisk|frida|xposed|charles|proxy|virtual|emulator|genymotion|bluestacks|nox|memu|ldplayer' \
    || echo "(无)"
  echo "--- SELinux / 容器痕迹"
  echo "selinux: $(adb_quick getenforce 2>/dev/null | tr -d '\r')"
  adb_quick getprop 2>/dev/null | grep -iE 'docker|container|redroid|qemu' | head -8
} 2>&1 | tee "$out/emulator-traces.txt" | sed 's/^/[env] /'

# 预授予权限，避免运行时弹原生权限框挡住广告
for perm in ACCESS_FINE_LOCATION ACCESS_COARSE_LOCATION READ_PHONE_STATE \
            READ_EXTERNAL_STORAGE WRITE_EXTERNAL_STORAGE READ_MEDIA_IMAGES; do
  adb_run pm grant "$PKG" "android.permission.$perm" >/dev/null 2>&1 || true
done

echo "[ad] launch app"
adb_run am start -n "$PKG/$ACT" 2>&1 | tee "$out/start.log" | tail -2
sleep 30
echo "[ad] resumed: $(resumed_activity)"
screenshot "01-launch"

# 等 WebView devtools socket 出现
for _ in $(seq 1 20); do
  adb shell "cat /proc/net/unix" 2>/dev/null | grep -q "webview_devtools_remote" && break
  sleep 2
done
pid="$(app_pid)"
echo "[ad] app pid: $pid"

# 容器内网络连通性诊断（Redroid 能否访问后端 API 和广告平台）
echo "[ad] net check:"
{
  # 出口 IP：这是判断「广告为什么不出货」的关键维度。
  # 实测真机换美国 IP 就「当前无广告」，换国内 IP 就正常；而 CI 用美国 IP
  # 偶尔也能出货（10-02 三次），说明 IP 是概率因素不是一票否决。
  # GitHub runner 每次分配到的 IP 都不同，所以多个短 run = 多次 IP 采样，
  # 比单个长 run 反复用同一个 IP 更有效。这个值就是用来验证该假设的。
  echo "--- 出口 IP"
  echo "runner_ip: $(node -e "
    const urls=['https://api.ipify.org','https://ifconfig.me/ip','https://icanhazip.com'];
    (async()=>{ for(const u of urls){ try{ const r=await fetch(u); const t=(await r.text()).trim(); if(t) { console.log(t); return; } }catch(e){} } console.log('(unknown)'); })();
  " 2>/dev/null)"
  echo "--- ping 8.8.8.8"
  adb_quick ping -c 1 -W 3 8.8.8.8 2>&1 | tail -3
  echo "--- DNS 解析 sigmob（广告平台，字节系）"
  adb_quick ping -c 1 -W 3 dc.sigmob.cn 2>&1 | tail -3
  adb_quick ping -c 1 -W 3 tm.sigmob.cn 2>&1 | tail -3
  echo "--- DNS 解析自有后端"
  adb_quick ping -c 1 -W 3 af.52kele.cn 2>&1 | tail -3
  echo "--- 网络属性"
  adb_quick getprop 2>/dev/null | grep -iE 'dns|eth0|net\.' | head -8
  echo "--- 是否有 GMS（很多广告 SDK 需要）"
  adb_quick pm list packages 2>/dev/null | grep -iE 'com.google.android.gms|vending|com.android.vending' || echo "(无 GMS / 无 Play Store)"
  echo "--- 设备标识"
  echo "android_id: $(adb_quick settings get secure android_id 2>/dev/null)"
  echo "--- telephony/IMEI 来源（Redroid 无真实基带，IMEI 是生成的，看能不能固定）"
  adb_quick getprop 2>/dev/null | grep -iE 'gsm|imei|ril|cdma|sim' | head -15
  echo "imei(bridge): 见下方 get-oaid"
} 2>&1 | tee -a "$out/net-check.txt" || true

# 关掉"广告权限提示"弹窗（首次启动才有）
echo "[ad] dismiss tips: $(cdp dismiss-tips)"
sleep 2

# 登录（若在登录页）：提交后轮询等待，跳出 #/auth 才算成功
if [[ "$(cdp status)" == *"hasLogin\":true"* ]]; then
  echo "[ad] login: $(cdp login "$ARITY_USER" "$ARITY_PASS")"
  for i in $(seq 1 30); do
    sleep 3
    st="$(cdp status)"
    [[ "$st" != *"hasLogin\":true"* ]] && break
    [[ "$i" == "10" ]] && adb_quick logcat -d 2>/dev/null | grep -iE "ERR_|Exception|net::|SSL|UnknownHost" | tail -20 > "$out/login-err.log" || true
  done
  echo "[ad] login errors: $(wc -l < "$out/login-err.log" 2>/dev/null || echo 0)"
fi
echo "[ad] status: $(cdp status)"
# 记录广告发奖回调服务用的 userId（= 账户 id，reward/latest 按它取）
ADS_UID="$(cdp user-info | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const u=JSON.parse(d.trim()).user||{};console.log(u.id||'')}catch{console.log('')}})" 2>/dev/null)"
if [[ -z "$ADS_UID" ]]; then
  ADS_UID="$(node -e "
    (async () => {
      const r = await fetch('https://af.52kele.cn/api/user/login', { method:'POST',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify({username:process.argv[1],password:process.argv[2]}) });
      console.log(String(JSON.parse(await r.text()).data.user.id));
    })().catch(()=>console.log(''));
  " "$ARITY_USER" "$ARITY_PASS" 2>/dev/null)"
fi
echo "[ad] ads reward uid: $ADS_UID  (reward/latest: $(api_reward_latest))"
screenshot "02-after-login"

# 探测原生广告桥 jsBridge.tobid（前端靠它拿广告位、调 reward）
echo "[ad] tobid probe: $(cdp tobid-probe | head -c 600)"
# 广告平台可达性：从 WebView 内部发起（WebView 与原生 SDK 同一个网络栈）。
# 这里通、Sigmob 却 700000 → 是 SDK 层的设备标识/签名问题，不是网络。
echo "[ad] ad-network probe: $(cdp fetch-test)"

# 诊断：列出 App 原生桥的全部方法，找广告 SDK 的失败原因查询接口
echo "[ad] bridge methods: $(cdp bridge-list)"
echo "[ad] getloadFailMessage: $(cdp call-bridge getloadFailMessage '{}' 2>&1 | head -c 400)"

# 读取本机（Redroid）真实设备标识，供 adcap 查询用；不用真机硬编码值
OAID_JSON="$(cdp get-oaid)"
echo "[ad] device id: $OAID_JSON"
DEVICE_OAID="$(echo "$OAID_JSON" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const j=JSON.parse(d.trim());console.log(j.id||'')}catch{console.log('')}})" 2>/dev/null)"
[[ -n "$DEVICE_OAID" ]] && OAID="$DEVICE_OAID" && echo "[ad] using device oaid: $OAID (source)" || echo "[ad] fallback oaid (真机): $OAID"


watched=0
# 每轮的对比基线：本轮开始前的到账凭证与观看计数
REWARD_BASE="$(api_reward_latest | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d.trim()).data.quota)}catch{console.log('')}})" 2>/dev/null)"
VT_BASE="$(api_get_quota | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d.trim()).viewed_today)}catch{console.log('')}})" 2>/dev/null)"
echo "[ad] baselines: reward_latest=$REWARD_BASE viewed_today=$VT_BASE account_quota=$(quota_num "$(account_quota)")"

for round in $(seq 1 "$MAX_ADS"); do
  CURRENT_ROUND="$round"
  echo "[ad] ===== round $round/$MAX_ADS ====="
  ensure_app_ready
  bal_before="$(cdp home-ad-info | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d.trim()).balance||'')}catch{console.log('')}})" 2>/dev/null)"
  echo "[ad] balance before: $bal_before"

  # SDK 全量日志：700000 只是聚合错误，Sigmob 真正的拒绝原因在里面。
# 关键点：Sigmob 只打了 3 条日志，全是 OAID 相关，说明它的日志级别被关掉了，
# 光靠 tag 过滤看不到竞价细节 —— 所以这里抓 logcat 全量，靠时间戳和上下文反推。
dump_ad_log() {
  adb_quick logcat -d -v time 2>/dev/null > "$out/ad-sdk-full-r${1}.log" 2>/dev/null || true
  adb_quick logcat -d -v time 2>/dev/null \
    | grep -iE 'sigmob|smad|wxad|\badn\b|no_?bid|no_?fill|700000|onVideoAd|RewardVideo|adload|adLoad|ecpm|tobid|slot|ksTube|gdt|bugly|miitmdid|oaid' \
    > "$out/ad-sdk-filtered-r${1}.log" 2>/dev/null || true
  echo "[ad] logcat -> $(wc -l < "$out/ad-sdk-full-r${1}.log" 2>/dev/null || echo 0) lines full, $(wc -l < "$out/ad-sdk-filtered-r${1}.log" 2>/dev/null || echo 0) filtered"
}

# 广告素材填充是概率性的：Sigmob 的 700000 既可能是库存问题，也可能是它把这个
# 容器环境判成无效设备后静默不返填充。两种都只能靠反复试，所以重试次数给足、
# 间隔保持 60s（实测 8s 连发会触发限流）。
got=0
  for attempt in $(seq 1 "$ADS_ATTEMPTS"); do
    echo "[ad] attempt $attempt/$ADS_ATTEMPTS: $(cdp click-ad)"
    sleep 4
    handle_perm_dialog || true
    # 轮询等待广告浮层出现（最多 25 秒）
    opened=0
    for i in $(seq 1 12); do
      sleep 2
      handle_perm_dialog && continue
      if ad_is_open; then opened=1; break; fi
    done
    if [[ "$opened" == "1" ]]; then got=1; break; fi
    adb_run input keyevent 4 >/dev/null 2>&1 || true
    sleep "$ADS_RETRY_WAIT"
  done

  if [[ "$got" != "1" ]]; then
    echo "[ad] round $round: $ADS_ATTEMPTS attempts all got no ad fill (${ADS_RETRY_WAIT}s apart)"
    dump_ad_log "$round"
    screenshot "round${round}-noad"
    # 失败后不做长冷却：前端的 250s cooldown 只在 onVideoRewarded 成功时才设置，
    # 没拿到素材时前端立刻允许再点。只留一个 ADS_RETRY_WAIT 的缓冲。
    if [[ "$round" -lt "$MAX_ADS" ]]; then
      echo "[ad] retry in ${ADS_RETRY_WAIT}s (no long cooldown: nothing was credited)"
      sleep "$ADS_RETRY_WAIT"
    fi
    continue
  fi

  screenshot "round${round}-opened"

  # 绝对不要再做「从顶部向下滑动」。
  # 那个提示的原话是「要退出，请从顶部向下滑动」—— 下滑手势是**退出广告**，
  # 不是进入播放。之前每轮都执行它，结果广告刚拉起就被自己关掉，前台退回
  # MainActivity，后面那次 CTA 点击打在后台窗口上，SDK 完全没反应。
  # 正确做法：只点掉系统提示，然后不动，等广告自己走完。
  dismiss_immersive_tip || true
  sleep 3
  screenshot "round${round}-tip-dismissed"
  echo "[ad] front after tip dismiss: $(resumed_activity | sed 's/.* //')"

  # 阶段 1：短暂等待，不碰任何东西。
  # 纯视频类激励会自然触发 onVideoRewarded，给它 30s；但实测这批广告是
  # 快手应用下载页，文案明写「完成App下载，即可获得奖励」——它在等点击，不会
  # 自己发奖。所以这里只做短暂观察就转入 phase2，别干等 90 秒。
  echo "[ad] phase1: 短暂等待自然回调，最多 30s"
  phase1_ok=0
  for i in $(seq 1 5); do
    sleep 6
    vt_probe="$(api_get_quota | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d.trim()).viewed_today)}catch{console.log('')}})" 2>/dev/null)"
    rl_probe="$(api_reward_latest | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d.trim()).data.quota)}catch{console.log('')}})" 2>/dev/null)"
    echo "[ad] phase1 t+$((i*6))s viewed_today=$vt_probe reward_latest=$rl_probe resumed=$(resumed_activity | sed 's/.* //')"
    if [[ -n "$REWARD_BASE" && -n "$rl_probe" && "$rl_probe" != "$REWARD_BASE" ]]; then
      echo "[ad] phase1 rewarded: reward_latest $REWARD_BASE -> $rl_probe"
      phase1_ok=1
      break
    fi
    # 广告自然放完会退回 WebView，且 onVideoRewarded 已让 viewed_today 递增
    if ! ad_is_open && [[ -n "$VT_BASE" && -n "$vt_probe" && "$vt_probe" -gt "$VT_BASE" ]]; then
      echo "[ad] phase1: 广告已关闭且计数递增 ($VT_BASE -> $vt_probe)"
      phase1_ok=1
      break
    fi
  done
  screenshot "round${round}-phase1"

  # 阶段 2：没拿到奖励才去点 endcard 的行动按钮（下载/打开），再等 15s。
  # 点之前必须确认广告 Activity 真的还在前台 —— uiautomator 能抓到后台窗口的
  # UI 树，点在后台窗口上等于没点。上一轮就是栽在这里：广告早退到后台了，
  # 日志却照样打出 [cta] tap 540 2188。
  if [[ "$phase1_ok" != "1" ]]; then
    if ad_is_open; then
      echo "[ad] phase2: 广告仍在前台，点击行动按钮"
      click_cta
      sleep 15
      screenshot "round${round}-cta-clicked"
      # 点完可能弹出「是否立即下载」/ 下载器确认，也可能直接跳应用商店
      for _ in 1 2 3; do
        ad_is_open || break
        sleep 3
      done
      screenshot "round${round}-after-cta"
    else
      echo "[ad] phase2: 广告已不在前台（resumed=$(resumed_activity | sed 's/.* //')），跳过点击"
      adb_quick uiautomator dump "/sdcard/after.xml" >/dev/null 2>&1 || true
      adb exec-out cat /sdcard/after.xml 2>/dev/null > "$out/after-r${round}.xml" || true
      echo "[ad] 残留 UI 文本: $(node -e "
        const fs=require('fs');
        try{
          const x=fs.readFileSync('$out/after-r${round}.xml','utf8');
          const s=new Set();
          for(const m of x.matchAll(/text=\"([^\"]+)\"/g)) if(m[1].trim()) s.add(m[1].trim());
          console.log([...s].slice(0,25).join(' | ').slice(0,400));
        }catch{ console.log('(无)') }
      " 2>/dev/null)"
      screenshot "round${round}-ad-gone"
    fi
  fi

  # 三判据（任一变化 = 奖励已发放）：
  #   account_quota —— 账户余额，最权威（服务端加的）
  #   reward/latest —— 广告发奖回调服务的到账凭证（前端靠它提示「🎉 +x 已到账」）
  #   viewed_today   —— 次数计数，仅作参考
  aq_before="$(account_quota)"
  aq_before_num="$(quota_num "$aq_before")"
  aq_after_num="$aq_before_num"
  vt_after="$VT_BASE"; rl_after="$REWARD_BASE"
  rewarded="$phase1_ok"
  for i in $(seq 1 25); do
    aq_after_num="$(quota_num "$(account_quota)")"
    rl_after="$(api_reward_latest | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d.trim()).data.quota)}catch{console.log('')}})" 2>/dev/null)"
    vt_after="$(api_get_quota | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d.trim()).viewed_today)}catch{console.log('')}})" 2>/dev/null)"
    aq_up=0; rl_up=0; vt_up=0
    [[ -n "$aq_before_num" && -n "$aq_after_num" ]] && awk -v a="$aq_after_num" -v b="$aq_before_num" 'BEGIN{exit !(a>b)}' && aq_up=1
    [[ -n "$REWARD_BASE" && -n "$rl_after" && "$rl_after" != "$REWARD_BASE" ]] && rl_up=1
    [[ -n "$VT_BASE" && -n "$vt_after" && "$vt_after" -gt "$VT_BASE" ]] && vt_up=1
    if [[ "$aq_up" == "1" || "$rl_up" == "1" ]]; then
      echo "[ad] rewarded! account_quota $aq_before_num -> $aq_after_num ; reward_latest $REWARD_BASE -> $rl_after (aq_up=$aq_up rl_up=$rl_up vt_up=$vt_up)"
      rewarded=1
      break
    fi
    sleep 3
  done
  screenshot "round${round}-settled"

  close_ad
  sleep 8
  if [[ "$rewarded" == "1" ]]; then
    watched=$((watched+1))
    echo "[ad] round $round SUCCESS"
  else
    echo "[ad] round $round: 广告播了但没发奖 (reward_latest 仍=$rl_after, viewed_today $VT_BASE -> $vt_after)"
  fi
  REWARD_BASE="$rl_after"; VT_BASE="$vt_after"

  if [[ "$round" -lt "$MAX_ADS" ]]; then
    echo "[ad] cooldown 240s"
    sleep 240
  fi
done

echo "[ad] completed $watched ad(s)"
echo "[ad] final ad status: $(api_get_quota)"
exit 0