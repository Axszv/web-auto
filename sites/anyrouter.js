// sites/anyrouter.js
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

async function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function loadCookies() {
  const f = path.join(__dirname, '..', 'cookies.json');
  if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8'));
  return {};
}

async function saveCookies(data) {
  fs.writeFileSync(path.join(__dirname, '..', 'cookies.json'), JSON.stringify(data, null, 2), 'utf8');
}

async function run(config = {}) {
  const BASE = 'https://anyrouter.top';

  const browser = await chromium.launch({
    headless: true,
    args: ['--proxy-server=http://127.0.0.1:10808', '--disable-blink-features=AutomationControlled']
  });
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 }
  });

  // Clear old expired cookies first to avoid CF blocking
  const saved = await loadCookies();
  if (saved.anyrouter && saved.anyrouter.length > 0) {
    console.log('anyrouter: clearing old expired cookies...');
    await ctx.clearCookies();
  }

  const page = await ctx.newPage();

  try {
    // Step 1: Visit main page WITHOUT cookies to pass Cloudflare
    console.log('anyrouter: visiting main page (no cookies)...');
    await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 120000 });
    await sleep(15000);
    console.log('anyrouter: main page URL:', page.url());

    // Step 2: Navigate to login page
    console.log('anyrouter: going to login...');
    await page.goto(BASE + '/login', { waitUntil: 'domcontentloaded', timeout: 120000 });
    await sleep(8000);
    console.log('anyrouter: login URL:', page.url());

    // Check if we can access the console (maybe session still works)
    await page.goto(BASE + '/console/personal', { waitUntil: 'domcontentloaded', timeout: 120000 });
    await sleep(5000);
    const url = page.url();
    console.log('anyrouter: console URL:', url);

    if (!url.includes('login') && !url.includes('oauth')) {
      console.log('anyrouter: already logged in!');
      // Try checkin
      const cr = await page.evaluate(async () => {
        try { const r = await fetch('/api/user/checkin', { method: 'POST' }); return await r.json(); }
        catch(e) { return { error: e.message }; }
      });
      console.log('anyrouter: checkin:', JSON.stringify(cr));

      const cookies = await ctx.cookies(BASE);
      if (cookies.length > 0) {
        const all = await loadCookies();
        all.anyrouter = cookies;
        await saveCookies(all);
      }
      console.log('anyrouter: done, cookies:', cookies.length);
      return { success: true, checkin: cr };
    }

    // Step 3: Session expired - need manual login
    console.log('anyrouter: session expired, needs manual login.');
    console.log('anyrouter: run: node login-helper.js anyrouter');
    return { success: false, error: 'need_manual_login' };

  } catch (e) {
    console.error('anyrouter error:', e.message.substring(0, 200));
    return { success: false, error: e.message.substring(0, 200) };
  } finally {
    await page.close();
    await browser.close();
  }
}

module.exports = { run };
