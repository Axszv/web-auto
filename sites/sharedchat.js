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
    await page.goto(BASE + '/list/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(2000);
    let url = page.url();
    console.log('sharedchat URL:', url);

    // Always try to login if not already logged in
    if (url.includes('login') || url.includes('sign')) {
      console.log('sharedchat: logging in');
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
      await sleep(3000);
      url = page.url();
      console.log('sharedchat after login:', url);
    } else {
      console.log('sharedchat: already logged in (cookie reused)');
    }

    // Navigate to the claim page to find the button
    await page.goto(BASE + '/list/#/vibe-code/dashboard?activeMenu=dashboard&service=codex', {
      waitUntil: 'domcontentloaded', timeout: 30000
    });
    await sleep(2000);
    console.log('sharedchat claim page URL:', page.url());

    // Click the claim button on page (more reliable than API call)
    // Try multiple text variations
    const claimBtn = page.locator('text=领取Codex权益').or(page.locator('text=领取 Codex 权益')).or(page.locator('text=领取'));
    if (await claimBtn.count() > 0) {
      console.log('sharedchat: clicking claim button');
      await claimBtn.click({ force: true });
      await sleep(3000);
      console.log('sharedchat after claim click, URL:', page.url());
      // Check result message
      const pageText = await page.evaluate(() => document.body.innerText);
      console.log('sharedchat page after click:', pageText.substring(0, 300));
    } else {
      console.log('sharedchat: claim button not found, checking page state');
      // Try navigating to dashboard to trigger claim
      await page.goto(BASE + '/list/#/vibe-code', { waitUntil: 'domcontentloaded', timeout: 30000 });
      await sleep(2000);
      const newClaimBtn = page.locator('text=领取Codex权益').or(page.locator('text=领取 Codex 权益')).or(page.locator('text=领取'));
      if (await newClaimBtn.count() > 0) {
        console.log('sharedchat: clicking claim button after navigate');
        await newClaimBtn.click({ force: true });
        await sleep(3000);
      }
    }

    // Also try API call to check status
    const reason = randomReason();
    try {
      const apiResult = await page.evaluate(async (data) => {
        try {
          const r = await fetch('/frontend-api/vibe-code/codex/claim', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
            body: JSON.stringify(data),
            credentials: 'include'
          });
          return { status: r.status, body: await r.text() };
        } catch (e) {
          return { error: e.message };
        }
      }, { reason });
      console.log('sharedchat API result:', apiResult.status);
      try {
        const json = JSON.parse(apiResult.body);
        if (json.code === 1) {
          console.log('sharedchat claim message:', json.data?.message || 'success');
        }
      } catch (e) {
        console.log('sharedchat API response:', apiResult.body.substring(0, 200));
      }
    } catch (e) {
      console.log('sharedchat API error:', e.message);
    }

    // Save cookies (always, even if already claimed)
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


