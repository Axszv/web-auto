// sites/gogocs.js — 无需代理，直接访问
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
  const BASE = 'https://user.gogocs.xyz';

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

    // After login, gogocs redirects to /user/disable — wait and check
    await sleep(3000);
    let url = page.url();
    console.log('gogocs URL after login flow:', url);

    // If not on disable page, navigate directly
    if (!url.includes('disable')) {
      console.log('gogocs: navigating to /user/disable directly');
      await page.goto(BASE + '/user/disable', { waitUntil: 'domcontentloaded', timeout: 30000 });
      await sleep(2000);
      url = page.url();
    }
    console.log('gogocs disable page detected:', url.includes('disable'), 'url:', url);

    if (url.includes('disable')) {
      // Also check for button by text in case URL hasn't updated yet
      const btn = page.locator('text=取消账户保护').first();
      if (await btn.count() > 0) {
        console.log('gogocs: clicking 取消账户保护');
        await btn.click({ force: true });
        await sleep(5000);
        // Check if redirected or modal appeared
        url = page.url();
        console.log('gogocs URL after click:', url);
        // Try to dismiss modal if still on disable page
        if (url.includes('disable')) {
          try {
            const okBtn = page.locator('text=知道了').first();
            if (await okBtn.count() > 0 && await okBtn.isVisible()) {
              await okBtn.click({ force: true });
              console.log('gogocs: clicked 知道了');
              await sleep(2000);
            }
          } catch (e) {
            console.log('gogocs: modal dismiss skipped:', e.message);
          }
        } else {
          console.log('gogocs: redirected after cancel (likely success)');
        }
      } else {
        console.log('gogocs: button not found, URL:', url);
      }
    }

    await page.goto(BASE + '/user/edit', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(3000);
    console.log('gogocs /user/edit URL:', page.url());

    // Set group: click dropdown button → select option → click check button
    console.log('gogocs: setting group...');
    const groupBtn = page.locator('#group');
    if (await groupBtn.count() > 0) {
      console.log('gogocs: clicking group dropdown');
      await groupBtn.click({ force: true });
      await sleep(1000);

      // Click the 延迟优先 option (dropdown may not be visible)
      const option = page.locator('a.dropdown-option').filter({ hasText: '延迟优先' });
      if (await option.count() > 0) {
        console.log('gogocs: clicking 延迟优先 option');
        await option.evaluate(el => el.click());
        await sleep(1000);
      } else {
        console.log('gogocs: 延迟优先 option not found');
      }

      // Click check button to confirm
      const checkBtn = page.locator('#group-update');
      if (await checkBtn.count() > 0) {
        console.log('gogocs: clicking group-update button');
        await checkBtn.click({ force: true });
        await sleep(2000);
      }
      console.log('gogocs: group setting done, URL:', page.url());
    } else {
      console.log('gogocs: #group button not found');
    }

    const cookies = await ctx.cookies(BASE);
    if (cookies.length > 0) {
      const all = await loadCookies();
      all.gogocs = cookies;
      await saveCookies(all);
      console.log('gogocs cookies saved:', cookies.length);
    }

    console.log('All done for user.gogocs.xyz');
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
