// lib/crypt.js — cookies.json AES-256-GCM 加解密（密钥经环境变量 COOKIES_KEY）
const fs = require('fs');
const crypto = require('crypto');

function encryptFile(file, out, keyHex) {
  const k = Buffer.from(keyHex, 'hex');
  if (k.length !== 32) throw new Error('COOKIES_KEY must be 64 hex chars');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', k, iv);
  const plain = fs.readFileSync(file);
  const enc = Buffer.concat([cipher.update(plain), cipher.final()]);
  fs.writeFileSync(out, JSON.stringify({
    v: 1,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: enc.toString('base64')
  }));
}

function decryptFile(file, out, keyHex) {
  const k = Buffer.from(keyHex, 'hex');
  if (k.length !== 32) throw new Error('COOKIES_KEY must be 64 hex chars');
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', k, Buffer.from(j.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(j.tag, 'base64'));
  const plain = Buffer.concat([decipher.update(Buffer.from(j.data, 'base64')), decipher.final()]);
  fs.writeFileSync(out, plain);
}

module.exports = { encryptFile, decryptFile };
