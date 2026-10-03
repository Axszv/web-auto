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

click_cta() {
  local xml; xml="$(ui_dump)"
  if [[ -z "$xml" ]]; then
    echo "[cta] dump 为空（全屏 Canvas/Surface 渲染），坐标兜底"
    adb_run input tap 540 1500 >/dev/null 2>&1 || true
    sleep 2
    return 0
  fi
  echo "$xml" > "$out/cta-r${CURRENT_ROUND}-endcard.xml"

  # 打印可见文本摘要：定位不到按钮时靠它判断广告到底处于什么状态
  node -e "
    const xml=require('fs').readFileSync(0,'utf8');
    const re=/<node[^>]*?>/g; const seen=new Set(); let m;
    while((m=re.exec(xml))){
      const t=(m[0].match(/text=\"([^\"]+)\"/)||[])[1]||'';
      const d=(m[0].match(/content-desc=\"([^\"]+)\"/)||[])[1]||'';
      const s=(t||d).trim(); if(s) seen.add(s);
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
    echo "[cta] UI 树未找到按钮文字，坐标兜底 540 1500"
    adb_run input tap 540 1500 >/dev/null 2>&1 || true
  fi
  sleep 2

  # 部分广告点完会弹二次确认（「是否立即下载」/「打开应用商店」）或跳转应用商店，
  # 那样同样拿不到结算，必须把确认框点掉。
  local xml2; xml2="$(ui_dump)"
  if [[ -n "$xml2" ]]; then
    local xy2
    xy2="$(node -e "
      const xml=require('fs').readFileSync(0,'utf8');
      const nodes=[...xml.matchAll(/<node[^>]*>/g)].map(m=>m[0]);
      const kw=['确定','确认','允许','继续','是','好的','知道了'];
      const skip=['取消','否','关闭','以后'];
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
  for _ in 1 2 3 4 5; do
    handle_perm_dialog && continue
    adb_run input keyevent 4 >/dev/null 2>&1 || true
    sleep 3
    ad_is_open || return 0
    enter_or_exit_fullscreen          # 顶部下滑退出
    ad_is_open || return 0
    adb_run input tap 985 88 >/dev/null 2>&1 || true   # 右上角关闭
    sleep 3
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
  bal_before="$(cdp home-ad-info | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d.trim()).balance||'')}catch{console.log('')}})" 2>/dev/null)"
  echo "[ad] balance before: $bal_before"

  # 广告素材填充是概率性的（同样环境有时拿到快手广告、有时 12 次全 700000 无广告返回），
  # 靠高频重试提高命中率；700000 错误通常几秒内就返回，不必等满 60 秒。
  got=0
  for attempt in $(seq 1 8); do
    echo "[ad] attempt $attempt: $(cdp click-ad)"
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
    # 重试间隔必须够长：实测 8 秒连发会被广告平台限流（60 次全 700000），
    # 而 20 秒间隔能正常拿到素材。etalien 也是每次间隔几分钟。
    sleep 60
  done

  if [[ "$got" != "1" ]]; then
    echo "[ad] round $round: 8 attempts all got no ad fill (60s apart)"
    adb_quick logcat -d 2>/dev/null | grep -iE "no.?bid|no_?fill|RewardVideo|onAdError|ad.*fail|sigmob|gdt|oaid|imei" | tail -30 > "$out/ad-sdk-r${round}.log" || true
    screenshot "round${round}-noad"
    if [[ "$round" -lt "$MAX_ADS" ]]; then echo "[ad] cooldown 240s"; sleep 240; fi
    continue
  fi

  screenshot "round${round}-opened"

  # 沉浸式广告顶部有「全屏模式，从顶部下滑」入口页，先下滑进入真正播放
  sleep 3
  enter_or_exit_fullscreen
  sleep 8

  # 阶段 1：纯等待，不碰任何东西。
  # 关键：onVideoRewarded 由 Sigmob SDK 在视频播完时主动回调。如果此时还在播
  # 就去点 CTA，会中断播放，SDK 判定未完整观看 → 不发奖。之前固定 40s 后无条件
  # 点 CTA，很可能就是这样把奖励点没了。
  echo "[ad] phase1: 纯等待 onVideoRewarded（不点任何东西），最多 90s"
  phase1_ok=0
  for i in $(seq 1 15); do
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

  # 阶段 2：没拿到奖励才去点 endcard 的行动按钮（下载/打开），再等 15s
  if [[ "$phase1_ok" != "1" ]]; then
    echo "[ad] phase2: 点击 endcard 行动按钮"
    click_cta
    sleep 15
    screenshot "round${round}-cta-clicked"
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