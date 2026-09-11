// lib/crypt-decrypt-cli.js — CI 用：解密 cookies 密文
// 用法: node lib/crypt-decrypt-cli.js <enc-file> <out-file>  （密钥在 COOKIES_KEY 环境变量）
const fs = require('fs');
const { decryptFile } = require('./crypt');

const [enc, out] = process.argv.slice(2);
if (!enc || !out) {
  console.error('usage: node lib/crypt-decrypt-cli.js <enc-file> <out-file>');
  process.exit(1);
}
if (!process.env.COOKIES_KEY) {
  console.error('COOKIES_KEY env required');
  process.exit(1);
}
if (!fs.existsSync(enc)) {
  console.log('no encrypted cookies yet, starting fresh');
  fs.writeFileSync(out, '{}');
  process.exit(0);
}
decryptFile(enc, out, process.env.COOKIES_KEY);
console.log('decrypted', enc, '->', out);
