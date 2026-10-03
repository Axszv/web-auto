#!/usr/bin/env bash
# 探测 Redroid 容器 OAID 支持现状：厂商服务、系统库、APK 内 SDK 类
out="${1:-diagnostics}"
mkdir -p "$out"

# 必须指定设备：ARM runner 上可能残留多台 adb 设备，不指定时下面所有
# `adb shell` 都可能落到错误目标，导致整份诊断全是空值（历史 bug）。
SERIAL="${SERIAL:-127.0.0.1:5555}"
export ANDROID_SERIAL="$SERIAL"
adb_s() { timeout 25s adb -s "$SERIAL" shell "$@" 2>/dev/null | tr -d '\r'; }

{
  echo "=== 已装厂商/OAID 相关包 ==="
  adb_s pm list packages 2>/dev/null | grep -iE "miui|huawei|honor|oppo|vivo|samsung|msa|oaid|bun\." || echo "(无任何厂商 OAID 服务)"

  echo ""
  echo "=== 系统服务里有无 OAID ==="
  adb_s service list 2>/dev/null | grep -iE "miui|msa|oaid|mdid" || echo "(无 OAID 系统服务)"

  echo ""
  echo "=== APK 内含的 OAID SDK 类名 ==="
  apk_path=$(adb_s pm path com.klkjapp.www 2>/dev/null | sed 's/package://' | tr -d '\r' | head -1)
  echo "apk: $apk_path"
  if [[ -n "$apk_path" ]]; then
    adb pull "$apk_path" "$out/app.apk" >/dev/null 2>&1
    if [[ -f "$out/app.apk" ]]; then
      rm -rf "$out/dex" && mkdir -p "$out/dex"
      unzip -o -q "$out/app.apk" "classes*.dex" -d "$out/dex" 2>/dev/null
      # 用 node 扫（容器无 strings），提取 OAID 相关类路径
      node -e "
        const fs=require('fs'),path=require('path');
        const dir=process.argv[1];
        const found=new Set();
        for(const f of fs.readdirSync(dir)){
          if(!f.endsWith('.dex')) continue;
          const s=fs.readFileSync(path.join(dir,f)).toString('latin1');
          const m=s.match(/L?com[\\/](bun[\\/]miitmdid|miui[\\/][a-zA-Z0-9_\\/]+|huawei[\\/][a-zA-Z0-9_\\/]*mdid)/g);
          if(m) m.forEach(x=>found.add(x.replace(/^L/,'')));
        }
        console.log(found.size? [...found].slice(0,15).join('  ') : '(未找到 OAID SDK 类)');
      " "$out/dex"
    fi
  fi

  echo ""
  echo "=== 设备标识现状 ==="
  echo "ANDROID_ID: $(adb_s settings get secure android_id 2>/dev/null | tr -d '\r')"
  echo "brand: $(adb_s getprop ro.product.brand 2>/dev/null | tr -d '\r')"
  echo "manufacturer: $(adb_s getprop ro.product.manufacturer 2>/dev/null | tr -d '\r')"
  echo "fingerprint: $(adb_s getprop ro.build.fingerprint 2>/dev/null | tr -d '\r')"
} > "$out/oaid-probe.txt" 2>&1

cat "$out/oaid-probe.txt"
