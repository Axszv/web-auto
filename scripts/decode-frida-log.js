// scripts/decode-frida-log.js — 解开 Frida agent 输出的 base64 行
// adb shell 会把中文打成 ?，所以 agent 里统一 Base64.encodeToString 后再传回。
// 用法：node scripts/decode-frida-log.js < 原始日志
//      或 node scripts/decode-frida-log.js /path/to/f5.log
const fs = require('fs');

const src = process.argv[2]
  ? fs.readFileSync(process.argv[2], 'utf8')
  : fs.readFileSync(0, 'utf8');

const seen = new Set();
for (const line of src.split(/\r?\n/)) {
  // agent 里 emit() 输出格式是 "<tag>|<base64>"
  const m = line.match(/^(\[[^\s|]{1,40}\|[A-Za-z0-9+/=]{4,})\s*$/);
  if (!m) continue;
  const raw = m[1];
  const i = raw.indexOf('|');
  const tag = raw.slice(0, i);
  let text;
  try { text = Buffer.from(raw.slice(i + 1), 'base64').toString('utf8'); } catch { continue; }
  if (!text) continue;
  const key = tag + '::' + text.slice(0, 80);
  if (seen.has(key)) continue;      // agent 里每次都带完整堆栈，去重避免刷屏
  seen.add(key);
  console.log(tag + ' :: ' + text);
}