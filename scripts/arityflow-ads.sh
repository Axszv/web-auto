#!/usr/bin/env bash
# ArityFlow 看广告自动化：Redroid ARM64 上驱动真实 App 播放激励视频
# 机制（已实测）：纯 HTTP POST /adcap/api/view {oaid} 只扣次数不发额度；
# 真实播放后由广告 SDK 回调 callback.af-freeapi.top 发放 +24.7/次，每天上限 3 次
set -uo pipefail

apk="${1:-artifacts/ArityFlow.apk}"
out="${2:-diagnostics}"
mkdir -p "$out"

PKG="com.klkjapp.www"
ACT="com.lt.app.MainActivity"
MAX_ADS="${MAX_ADS:-3}"
OAID="1ed4c87b179ff56d"   # 从真机抓包拿到的设备标识（不依赖原生桥，避免 IMEI 权限问题）

# 指定唯一设备（ARM runner 上可能有多设备/残留）
export ANDROID_SERIAL=127.0.0.1:5555

adb_run()  { adb shell "$@"; }
adb_quick() { timeout 25s adb shell "$@" 2>/dev/null || true; }

screenshot() { adb exec-out screencap -p > "$out/$1.png" 2>/dev/null || true; }
dump_ui()    { adb_run shell uiautomator dump "/sdcard/$1.xml" >/dev/null 2>&1 || true
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

close_ad() {
  for _ in 1 2 3; do
    adb_run shell input keyevent 4 >/dev/null 2>&1 || true
    sleep 4
    ad_is_open || return 0
    # 右上角关闭（1080 宽，比例坐标）
    adb_run shell input tap 985 88 >/dev/null 2>&1 || true
    sleep 4
    ad_is_open || return 0
  done
  adb_run shell input keyevent 3 >/dev/null 2>&1 || true
  sleep 3
}

api_get_quota() {
  adb_quick shell "curl -s -X POST https://af.52kele.cn/adcap/api/quota \
    -H 'Content-Type: application/json' -d '{\"oaid\":\"$OAID\"}'" 2>/dev/null \
    | tr -d '\r'
}

wait_text() {  # 等待某个文本出现在 UI
  local needle="$1" limit="${2:-40}" i
  for ((i=0;i<limit;i++)); do
    adb_quick uiautomator dump "/sdcard/w.xml" >/dev/null 2>&1 || true
    if adb exec-out cat /sdcard/w.xml 2>/dev/null | grep -q "$needle"; then
      return 0
    fi
    sleep 2
  done
  return 1
}

echo "[ad] install apk"
adb install -r -d "$apk" >/dev/null 2>&1 || { echo "install failed"; exit 3; }

echo "[ad] launch app"
adb_run shell am start -n "$PKG/$ACT" >/dev/null 2>&1 || true
sleep 25

# 登录（若未登录）
if wait_text "请输入用户名" 6; then
  echo "[ad] logging in"
  adb_run shell input text "$ARITY_USER" >/dev/null 2>&1 || true
  sleep 2
  adb_run shell input text "$ARITY_PASS" >/dev/null 2>&1 || true
  sleep 2
  adb_run shell input tap 540 1290 >/dev/null 2>&1 || true  # 登录按钮（中下方）
  sleep 20
fi
screenshot "after-login"

echo "[ad] ad status: $(api_get_quota)"

watched=0
for round in $(seq 1 "$MAX_ADS"); do
  echo "[ad] ===== round $round/$MAX_ADS ====="
  if ! wait_text "看广告" 20; then
    echo "[ad] 看广告 button not found; skip"; break
  fi

  # 点「看广告」
  adb_run shell input tap 300 670 >/dev/null 2>&1 || true
  sleep 8

  if ! ad_is_open; then
    echo "[ad] ad did not open (无广告/SDK未出素材)"
    screenshot "round${round}-noad"
    # 冷却 240s 避免频繁重试
    if [[ "$round" -lt "$MAX_ADS" ]]; then echo "[ad] cooldown 240s"; sleep 240; fi
    continue
  fi

  echo "[ad] ad is playing, waiting for completion (up to 90s)"
  for i in $(seq 1 45); do
    sleep 2
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