// lib/totp.js — RFC 6238 TOTP 生成器（零依赖）
const crypto = require('crypto');

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Decode(input) {
  let bits = 0, val = 0;
  const bytes = [];
  for (const c of input.toUpperCase().replace(/=+$/, '')) {
    const idx = B32.indexOf(c);
    if (idx < 0) continue;
    val = (val << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((val >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

function totp(secretB32, t, timeStep = 30) {
  const key = base32Decode(secretB32);
  const counter = Math.floor((t === undefined ? Date.now() / 1000 : t) / timeStep);
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  buf.writeUInt32BE(counter >>> 0, 4);
  const hmac = crypto.createHmac('sha1', key).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  const code = ((hmac[offset] & 0x7f) << 24) | (hmac[offset + 1] << 16) | (hmac[offset + 2] << 8) | hmac[offset + 3];
  return String(code % 1000000).padStart(6, '0');
}

module.exports = { totp, base32Decode };
