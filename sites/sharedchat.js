// sites/sharedchat.js — Uses built-in Chromium
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function randomReason() {
  const reasons = [
    'Daily automation check-in for coding tool testing and usage verification',
    'Automated daily verification for developer productivity platform access',
    'Routine daily authentication verification and account status confirmation'
  ];
  return reasons[Math.floor(Math.random() * reasons.length)];
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
  const email = config.email || process.env.SHAREDCHAT_EMAIL || '504740633@qq.com';
  const password = config.password || process.env.SHAREDCHAT_PASSWORD || 'LZ37265981^';
  const BASE = 'https://new.sharedchat.cc';

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  });

  const saved = await loadCookies();
  if (saved.sharedchat && saved.sharedchat.length > 0) await ctx.addCookies(saved.sharedchat);

  const page = await ctx.newPage();

  try {
    await page.goto(BASE + '/list/', { waitUntil: 'networkidle', timeout: 30000 });
    await sleep(2000);
    const url = page.url();
    console.log('sharedchat URL:', url);

    if (url.includes('login') || url.includes('sign')) {
      await page.locator('span:has-text("用户登录")').first().click();
      await sleep(1000);
      const inputs = await page.locator('input').all();
      if (inputs.length >= 2) {
        await inputs[0].fill(email);
        await inputs[1].fill(password);
        await page.evaluate(() => {
          const b = document.querySelector('button');
          if (b && b.textContent.includes('登录')) b.click();
        });
      }
      await sleep(2000);
      console.log('Login URL:', page.url());
    } else {
      console.log('Already logged in (cookie reused)');
    }

    // Click the claim button on page
    const claimBtn = page.locator('button:has-text("领取 Codex 权益")').first();
    if (await claimBtn.count() > 0) {
      await claimBtn.click();
      await sleep(2000);
      // Check for modal/dialog
      const modal = page.locator('.el-dialog, .v-dialog, [role="dialog"]').first();
      if (await modal.count() > 0) {
        const inputs = await modal.locator('input, textarea').all();
        if (inputs.length > 0) {
          const reason = randomReason();
          await inputs[0].fill(reason);
          console.log('Filled reason');
          const submitBtn = modal.locator('button:has-text("领取"), button:has-text("确认"), button:has-text("确定")').first();
          if (await submitBtn.count() > 0) {
            await submitBtn.click();
            await sleep(1500);
            console.log('Claim submitted!');
          }
        }
      }
    } else {
      console.log('Claim button not found (already claimed today?)');
    }

    const cookies = await ctx.cookies(BASE);
    if (cookies.length > 0) {
      const all = await loadCookies();
      all.sharedchat = cookies;
      await saveCookies(all);
      console.log('sharedchat cookies saved:', cookies.length);
    }

    console.log('All done for sharedchat.cc');
    return { success: true };
  } catch (e) {
    console.error('sharedchat Error:', e.message);
    return { success: false, error: e.message };
  } finally {
    await page.close();
    await browser.close();
  }
}

module.exports = { run };
