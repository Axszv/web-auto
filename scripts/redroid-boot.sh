#!/usr/bin/env bash
# 等待 Redroid 容器内 Android 启动完成
set -euo pipefail

out="${1:-diagnostics}"
container="redroid"
mkdir -p "$out"

for attempt in $(seq 1 60); do
  running="$(docker inspect --format '{{.State.Running}}' "$container" 2>/dev/null || true)"
  boot_completed=""
  if [[ "$running" == "true" ]]; then
    boot_completed="$(
      timeout --kill-after=2s 5s docker exec "$container" \
        /system/bin/getprop sys.boot_completed 2>>"$out/getprop-errors.txt" \
        | tr -d '\r' || true
    )"
  fi
  printf 'attempt=%s running=%s boot=%s\n' "$attempt" "$running" "$boot_completed" \
    | tee -a "$out/boot-progress.txt"
  if [[ "$boot_completed" == "1" ]]; then
    adb connect 127.0.0.1:5555 >/dev/null 2>&1 || true
    adb wait-for-device
    echo "Android booted; adb device: $(adb shell getprop ro.product.model 2>/dev/null | tr -d '\r')"
    exit 0
  fi
  if [[ "$running" != "true" ]]; then
    break
  fi
  sleep 3
done

docker ps -a --no-trunc > "$out/docker-ps.txt" 2>&1 || true
docker logs --timestamps "$container" > "$out/redroid.log" 2>&1 || true
echo "Android boot timeout" >&2
exit 2