#!/usr/bin/env bash
# 用 Frida 把 TelephonyManager 报的 IMEI 换成格式合法的真机值。
#
# 起因：Redroid 官方维护者明确说过「the telephony is not emulated in redroid」，
# 它生成的 IMEI 形如 5efb42d032e3dde4 —— 16 位纯 hex。而真实 IMEI 是 15 位
# 十进制、带 Luhn 校验位、前 8 位是厂商 TAC。App 的 OAID 链退到 getIMEI 之后，
# 这个一眼假的值会被直接塞进广告请求里。
#
# 为什么改 getprop 没用：已实测注入 7 项设备属性后容器正常启动、服务端 967ms 秒回，
# 但仍然全部无填充。SDK 读的是 TelephonyManager，不是系统属性 —— 只有在 framework
# 层拦截返回值才能改变「请求内容本身」。
#
# 结构：frida-server 跑在容器里（root），frida-inject 这个客户端跑在 runner 上，
# 通过 adb forward 的 27042 端口 attach。两个二进制版本必须一致。
set -uo pipefail

MODE="${1:-attach}"
OUT="${2:-diagnostics}"
# 转绝对路径：attach 阶段的工作目录未必是仓库根，相对路径会写到不存在的位置
mkdir -p "$OUT" 2>/dev/null
OUT="$(cd "$OUT" 2>/dev/null && pwd || echo "$OUT")"
FRIDA_VER="${FRIDA_VER:-17.22.0}"
PKG="com.klkjapp.www"
SERIAL=127.0.0.1:5555
export ANDROID_SERIAL="$SERIAL"

mkdir -p "$OUT"
WORK="${RUNNER_TEMP:-/tmp}/frida-hook"
mkdir -p "$WORK"
cd "$WORK" || exit 1

dl() {  # $1=url  $2=outfile；返回 0 成功
  local base
  for base in "$1" "https://ghproxy.net/$1"; do
    if curl -fsSL --max-time 300 -o "$2" "$base"; then return 0; fi
  done
  return 1
}

unxz() {  # $1=in.xz  $2=out
  command -v xz >/dev/null 2>&1 && { xz -dkf "$1" && mv "${1%.xz}" "$2" && return 0; }
  command -v python3 >/dev/null 2>&1 && python3 -c \
    "import lzma,shutil;shutil.copyfileobj(lzma.open('$1'),open('$2','wb'))" && return 0
  return 1
}

# ---- 1. frida-server → 容器 ----
echo "[frida] 取 frida-server ${FRIDA_VER} (android-arm64)"
if ! dl "https://github.com/frida/frida/releases/download/${FRIDA_VER}/frida-server-${FRIDA_VER}-android-arm64.xz" fsrv.xz; then
  echo "[frida] frida-server 下载失败，跳过（不影响主流程）"; exit 0
fi
if ! unxz fsrv.xz frida-server; then
  echo "[frida] 解压失败（缺 xz/python3），跳过"; exit 0
fi
adb -s "$SERIAL" push frida-server /data/local/tmp/frida-server >/dev/null 2>&1
adb -s "$SERIAL" shell "chmod 755 /data/local/tmp/frida-server" >/dev/null 2>&1
adb -s "$SERIAL" shell "pkill -f frida-server" >/dev/null 2>&1
# 必须以 root 身份起 —— 否则 attach 时 ptrace 权限不够，报
# "Unable to access process with pid X"。Redroid 的 shell 默认不是 root。
adb -s "$SERIAL" shell "su -c 'nohup /data/local/tmp/frida-server -l 0.0.0.0:27042 >/data/local/tmp/frida.log 2>&1 &'" >/dev/null 2>&1
# yama ptrace_scope=1 会拦下跨进程 attach，放开它
adb -s "$SERIAL" shell "su -c 'echo 0 > /proc/sys/kernel/yama/ptrace_scope'" >/dev/null 2>&1 || true
sleep 5
adb -s "$SERIAL" forward tcp:27042 tcp:27042 >/dev/null 2>&1
if ! adb -s "$SERIAL" shell "cat /data/local/tmp/frida.log" 2>/dev/null | grep -qiE "listening|started|server"; then
  echo "[frida] server 未正常启动：$(adb -s "$SERIAL" shell "cat /data/local/tmp/frida.log" 2>/dev/null | tr -d '\r' | head -3)"
fi
echo "[frida] frida-server 就绪，端口已转发"

# ---- 2. 打包 agent ----
AGENT_SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/frida/agent-imei.ts"
cp "$AGENT_SRC" "$WORK/"
[[ -f package.json ]] || npm init -y > npm.log 2>&1
if [[ ! -d node_modules/frida-compile ]]; then
  # runner 上 npm 较慢，加超时兜底；失败也不阻塞主流程
  timeout 300 npm install --no-audit --no-fund --prefer-offline frida-java-bridge frida-compile > npm.log 2>&1 || echo "[frida] npm install 超时或失败"
fi
# Frida 17 把 Java bridge 移出了内核，必须显式 import 再用 frida-compile 打包
npx frida-compile agent-imei.ts -o agent-bundle.js > compile.log 2>&1
if [[ ! -s agent-bundle.js ]]; then
  echo "[frida] agent 打包失败，日志："
  sed "s/^/[npm] /" npm.log 2>/dev/null | tail -15
  sed "s/^/[compile] /" compile.log 2>/dev/null | tail -15
  exit 0
fi
echo "[frida] agent 打包完成 ($(stat -c%s agent-bundle.js) bytes)"

# ---- attach（prepare 阶段已把 server / frida-inject / agent 都备好）----
if [[ "$MODE" != "attach" ]]; then echo "[frida] prepare 完成"; exit 0; fi

cd "$WORK" || exit 1

# frida-inject 客户端跑在 runner 上（linux-arm64），通过 adb 连容器里的
# frida-server。之前把脚本拆成 prepare/attach 两阶段时，这段下载逻辑被误删了，
# attach 阶段直接引用一个不存在的文件 → "frida-inject 未就绪"。
if [[ ! -x ./frida-inject ]]; then
  echo "[frida] 下载 frida-inject (linux-arm64)"
  if dl "https://github.com/frida/frida/releases/download/${FRIDA_VER}/frida-inject-${FRIDA_VER}-linux-arm64.xz" finj.xz && unxz finj.xz frida-inject; then
    chmod +x frida-inject
    echo "[frida] frida-inject 就绪 ($(stat -c%s frida-inject) bytes)"
  else
    echo "[frida] frida-inject 下载/解压失败"
    sed 's/^/[dl] /' finj.xz 2>/dev/null | head -3
    exit 0
  fi
fi
[[ -x ./frida-inject ]] || { echo "[frida] frida-inject 仍不可用，跳过 attach"; exit 0; }
[[ -s agent-bundle.js ]] || { echo "[frida] agent 未就绪，跳过 attach"; exit 0; }
adb -s "$SERIAL" forward tcp:27042 tcp:27042 >/dev/null 2>&1

pid="$(adb -s "$SERIAL" shell pidof "$PKG" 2>/dev/null | tr -d '\r\n')"
if [[ -z "$pid" ]]; then
  echo "[frida] App 未运行，跳过 attach"
  exit 0
fi
echo "[frida] attach pid=$pid"
# frida-inject 在 Frida 17 是 Go 重写版，参数体系跟老的 Python 版不同
# （-U 已不存在）。先把它的可用参数打出来，避免再猜。
echo "[frida] frida-inject --help:"
./frida-inject --help 2>&1 | sed 's/^/[inject-help] /' | head -20
# 正确写法是 -D/--device（Go 版 frida-inject 的参数体系，-U 和 -H 都不存在，
# 由上面那次 --help 自省确认）。socket 表示走adb/USB 通道直连设备上的 server；
# 也可用 -D 127.0.0.1:27042 指定前面 forward 出来的地址。
nohup ./frida-inject -D socket -p "$pid" -s agent-bundle.js > "$OUT/frida-agent.log" 2>&1 &
sleep 15
echo "[frida] hook 输出："
sed 's/^/[agent] /' "$OUT/frida-agent.log" 2>/dev/null | head -25
exit 0
