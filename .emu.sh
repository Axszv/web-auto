#!/usr/bin/env bash
# 清除 Redroid 容器里的模拟器指纹，让广告 SDK 认不出是模拟器
# 依据：从 APK dex 里提取的模拟器检测字符串清单（classes3.dex 等）
set -uo pipefail
container="redroid"
SERIAL=127.0.0.1:5555
export ANDROID_SERIAL="$SERIAL"

echo "[emu] 清除容器模拟器指纹..."
# 删除 SDK 检测的模拟器文件（存在则删；--privileged + docker exec 有权限）
for f in /dev/qemu_pipe /dev/socket/qemud /sys/qemu_trace \
         /system/bin/qemu-props /system/lib/libc_malloc_debug_qemu.so \
         /system/bin/qemu-props /dev/goldfish_pipe /dev/qemu_sensors; do
  docker exec "$container" sh -c "rm -f $f 2>/dev/null" 2>/dev/null && echo "  删除 $f" || true
done

# 改属性：模拟器标志置 0/隐藏
for kv in "ro.kernel.qemu 0" "qemu.hw.mainkeys 1" "ro.boot.qemu 0"; do
  k="${kv%% *}"; v="${kv##* }"
  docker exec "$container" sh -c "setprop $k $v 2>/dev/null" 2>/dev/null && echo "  属性 $k=$v" || true
done

# 确认
echo "[emu] 复核:"
docker exec "$container" sh -c "getprop ro.kernel.qemu; ls /dev/qemu_pipe 2>&1; ls /system/bin/qemu-props 2>&1" 2>/dev/null | head -5
echo "[emu] 清除完成"
