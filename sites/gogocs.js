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
    console.log('gogocs /user/edit title:', await page.title());

    // Debug: dump page content around group section
    try {
      const pageText = await page.evaluate(() => document.body.innerText);
      console.log('gogocs page text snippet:', pageText.substring(0, 800));
    } catch(e) {}

    // Try multiple selectors for the group label
    let groupLabel = null;
    const groupSelectors = [
      'text=分组 网络',
      'text=分组',
      'label:has-text("分组")',
      '[data-label*="分组"]',
      '.form-group:has-text("分组")'
    ];
    for (const sel of groupSelectors) {
      try {
        const el = page.locator(sel).first();
        if (await el.count() > 0) {
          console.log('gogocs: found group label via selector:', sel);
          groupLabel = el;
          break;
        }
      } catch(e) {}
    }

    if (groupLabel) {
      console.log('gogocs: clicking group label');
      await groupLabel.click({ force: true });
      await sleep(1500);

      // Debug: check what's visible after click
      try {
        const opts = await page.locator('text=延迟优先').all();
        console.log('gogocs: found', opts.length, '延迟优先 elements');
        for (let i = 0; i < opts.length; i++) {
          try {
            const visible = await opts[i].isVisible();
            console.log('gogocs: option', i, 'visible:', visible, 'text:', await opts[i].textContent().catch(() => 'N/A'));
          } catch(e) {}
        }
      } catch(e) {}

      // Try clicking the option
      let optionClicked = false;
      try {
        const opts = await page.locator('text=延迟优先').all();
        for (const opt of opts) {
          if (await opt.isVisible().catch(() => false)) {
            console.log('gogocs: clicking 延迟优先 option');
            await opt.click({ force: true });
            optionClicked = true;
            break;
          }
        }
      } catch(e) {
        console.log('gogocs: option click error:', e.message);
      }

      if (!optionClicked) {
        // Fallback: try clicking via JavaScript
        console.log('gogocs: trying JS click fallback for 延迟优先');
        await page.evaluate(() => {
          const els = Array.from(document.querySelectorAll('*')).filter(el => el.textContent && el.textContent.includes('延迟优先'));
          for (const el of els) {
            if (el.offsetParent !== null) { el.click(); break; }
          }
        });
      }
      await sleep(1000);

      // Submit
      try {
        const submit = page.locator('button[type="submit"]').first();
        if (await submit.count() > 0) {
          console.log('gogocs: submitting form');
          await submit.click({ force: true });
          await sleep(3000);
          console.log('gogocs: after submit URL:', page.url());
          console.log('gogocs: after submit title:', await page.title());
        }
      } catch(e) {
        console.log('gogocs: submit error:', e.message);
      }
      console.log('Group setting attempted');
    } else {
      console.log('gogocs: group label not found, skipping group setting');
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
