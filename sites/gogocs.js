// sites/gogocs.js — Uses built-in Chromium (works on all platforms)
const crypto = require('crypto');
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function solvePow(salt, difficulty, ip, timestamp, originalSignature) {
  const prefix = '' + timestamp + ip + difficulty + salt;
  const threshold = Math.floor(0xFFFFFF / difficulty);
  for (let nonce = 0; nonce < 50000000; nonce++) {
    const hashBuffer = crypto.createHash('sha256').update(prefix + nonce).digest();
    const first3Bytes = (hashBuffer[0] << 16) | (hashBuffer[1] << 8) | hashBuffer[2];
    if (first3Bytes < threshold) return { nonce: String(nonce), timestamp, ip, difficulty, salt, signature: originalSignature };
  }
  return null;
}

async function loadCookies() {
  const f = path.join(__dirname, '..', 'cookies.json');
  if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8'));
  return {};
}

async function saveCookies(data) {
  fs.writeFileSync(path.join(__dirname, '..', 'cookies.json'), JSON.stringify(data, null, 2), 'utf8');
}

async function run(config = {}) {
  const email = config.email || process.env.GOGOCS_EMAIL || '504740633@qq.com';
  const password = config.password || process.env.GOGOCS_PASSWORD || 'XA531729';
  const BASE = 'https://gogocs.xyz';

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  });

  const saved = await loadCookies();
  if (saved.gogocs && saved.gogocs.length > 0) await ctx.addCookies(saved.gogocs);

  const page = await ctx.newPage();

  try {
    await page.goto(BASE + '/user', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(2000);
    const currentUrl = page.url();
    console.log('gogocs initial URL:', currentUrl);

    if (currentUrl.includes('login')) {
      await page.goto(BASE + '/auth/login', { waitUntil: 'domcontentloaded', timeout: 30000 });
      await sleep(3000);
      const challenge = await page.evaluate(async () => {
        const r = await fetch('/auth/pow_challenge', { method: 'POST' });
        return await r.json();
      });
      await sleep(1000);
      const solution = await solvePow(challenge.salt, challenge.difficulty, challenge.ip, challenge.timestamp, challenge.signature);
      await sleep(1000);

      const loginData = new URLSearchParams({
        email, passwd: password, code: '',
        pow_timestamp: String(solution.timestamp), pow_ip: solution.ip,
        pow_difficulty: String(solution.difficulty), pow_salt: solution.salt,
        pow_signature: solution.signature, pow_nonce: solution.nonce
      });

      const result = await page.evaluate(async (data) => {
        const r = await fetch('/auth/login', {
          method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: data, credentials: 'include'
        });
        return await r.json();
      }, loginData.toString());

      if (result.ret !== 1) throw new Error('Login failed: ' + (result.msg || JSON.stringify(result)));
      console.log('Login OK');
    } else {
      console.log('Already logged in (cookie reused)');
    }

    if (page.url().includes('disable')) {
      console.log('On disable page');
      const btn = page.locator('text=取消账户保护').first();
      if (await btn.count() > 0) {
        await btn.evaluate(el => el.click());
        await sleep(5000);
        const ok = page.locator('text=知道了').first();
        if (await ok.count() > 0) await ok.evaluate(el => el.click());
        await sleep(2000);
      }
    }

    await page.goto(BASE + '/user/edit', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(2000);
    const groupLabel = page.locator('text=分组 网络').first();
    if (await groupLabel.count() > 0) {
      await groupLabel.evaluate(el => el.click());
      await sleep(1000);
      const opts = await page.locator('text=延迟优先').all();
      for (const opt of opts) {
        if (await opt.isVisible().catch(() => false)) {
          await opt.evaluate(el => el.click());
          break;
        }
      }
      await sleep(500);
      const submit = page.locator('button[type="submit"]');
      if (await submit.count() > 0) await submit.click();
      console.log('Group set to 延迟优先');
    }

    const cookies = await ctx.cookies(BASE);
    if (cookies.length > 0) {
      const all = await loadCookies();
      all.gogocs = cookies;
      await saveCookies(all);
      console.log('gogocs cookies saved:', cookies.length);
    }

    console.log('All done for gogocs.xyz');
    return { success: true };
  } catch (e) {
    console.error('gogocs Error:', e.message);
    return { success: false, error: e.message };
  } finally {
    await page.close();
    await browser.close();
  }
}

module.exports = { run };
