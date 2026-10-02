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

close_ad() {
  for _ in 1 2 3 4; do
    handle_perm_dialog && continue
    adb_run input keyevent 4 >/dev/null 2>&1 || true
    sleep 4
    ad_is_open || return 0
    # 右上角关闭（1080 宽，比例坐标）
    adb_run input tap 985 88 >/dev/null 2>&1 || true
    sleep 4
    ad_is_open || return 0
  done
  adb_run input keyevent 3 >/dev/null 2>&1 || true
  sleep 3
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

# WebView 页面 uiautomator dump 抓不到内部文字，改用 CDP 直连 WebView DOM 操作。
app_pid() { adb shell pidof "$PKG" 2>/dev/null | tr -d '\r\n'; }
cdp() {
  local pid; pid="$(app_pid)"
  if [[ -z "$pid" ]]; then echo "CDP_ERR:no-pid"; return; fi
  node "$script_dir/webview-cdp.js" "$SERIAL" "$pid" "$@" 2>&1 || echo "CDP_ERR:node-failed"
}

echo "[ad] install apk"
adb install -r -d "$apk" 2>&1 | tee "$out/install.log" | tail -2

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

# 容器内网络连通性诊断（Redroid 能否访问后端 API）
echo "[ad] net check:"
adb_quick shell "ping -c1 -W2 8.8.8.8" 2>/dev/null | tail -2 | tee -a "$out/net-check.txt" || true
adb_quick shell "getprop | grep -iE 'dns|net.eth0'" 2>/dev/null | head -5 | tee -a "$out/net-check.txt" || true

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
screenshot "02-after-login"

# 读取本机（Redroid）真实设备标识，供 adcap 查询用；不用真机硬编码值
OAID_JSON="$(cdp get-oaid)"
echo "[ad] device id: $OAID_JSON"
DEVICE_OAID="$(echo "$OAID_JSON" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const j=JSON.parse(d.trim());console.log(j.id||'')}catch{console.log('')}})" 2>/dev/null)"
[[ -n "$DEVICE_OAID" ]] && OAID="$DEVICE_OAID" && echo "[ad] using device oaid: $OAID (source)" || echo "[ad] fallback oaid (真机): $OAID"


watched=0
for round in $(seq 1 "$MAX_ADS"); do
  echo "[ad] ===== round $round/$MAX_ADS ====="
  echo "[ad] status: $(api_get_quota)"

  # 点「看广告」（CDP 精确定位 button.quota-ad-btn）
  echo "[ad] click-ad: $(cdp click-ad)"
  # 轮询等待广告出现：SDK 拉素材可能要几十秒
  opened=0
  for i in $(seq 1 30); do
    sleep 2
    handle_perm_dialog && continue
    if ad_is_open; then opened=1; break; fi
  done
  screenshot "round${round}-after-tap"

  if [[ "$opened" != "1" ]]; then
    echo "[ad] ad did not open within 60s (无广告/SDK未出素材)"
    adb_quick logcat -d 2>/dev/null | grep -iE "no.?bid|no_?fill|no.?ad|RewardVideo|onAdError|onRewardVerify|ad.*fail|mediat|sigmob|gdt|oaid|imei" | tail -40 > "$out/ad-sdk.log" || true
    echo "[ad] ad-sdk log lines: $(wc -l < "$out/ad-sdk.log" 2>/dev/null || echo 0)"
    screenshot "round${round}-noad"
    # 冷却 240s 避免频繁重试
    if [[ "$round" -lt "$MAX_ADS" ]]; then echo "[ad] cooldown 240s"; sleep 240; fi
    continue
  fi

  echo "[ad] ad is playing, waiting for completion (up to 90s)"
  for i in $(seq 1 45); do
    sleep 2
    handle_perm_dialog && continue
    ad_is_open || break
  done
  screenshot "round${round}-endcard"

  close_ad
  sleep 6
  watched=$((watched+1))
  echo "[ad] round $round done, ad status: $(api_get_quota)"

  if [[ "$round" -lt "$MAX_ADS" ]]; then
    echo "[ad] cooldown 240s"
    sleep 240
  fi
done

echo "[ad] completed $watched ad(s)"
echo "[ad] final ad status: $(api_get_quota)"
exit 0