// sites/anyrouter.js
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

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
    args: ['--disable-blink-features=AutomationControlled']
  });
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 }
  });

  // Load saved cookies (including session + old CF cookies)
  const saved = await loadCookies();
  if (saved.anyrouter && saved.anyrouter.length > 0) await ctx.addCookies(saved.anyrouter);

  const page = await ctx.newPage();

  try {
    // Step 1: Visit main page - this refreshes CF challenge cookies
    // The session cookie from saved cookies will be sent, keeping us logged in
    console.log('anyrouter: refreshing Cloudflare cookies...');
    await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 20000 });
    await sleep(3000);
    console.log('anyrouter after main:', page.url());

    // Step 2: Try console with fresh CF cookies + saved session
    console.log('anyrouter: checking session...');
    await page.goto(BASE + '/console/personal', { waitUntil: 'domcontentloaded', timeout: 20000 });
    await sleep(2000);
    const url = page.url();
    console.log('anyrouter URL:', url);

    if (!url.includes('login') && !url.includes('oauth')) {
      console.log('anyrouter: logged in!');
      try {
        const cr = await page.evaluate(async () => {
          try { const r = await fetch('/api/user/checkin', { method: 'POST' }); return await r.json(); }
          catch(e) { return { error: e.message }; }
        });
        console.log('anyrouter checkin:', JSON.stringify(cr));
      } catch(e) { console.log('anyrouter checkin err:', e.message); }

      const cookies = await ctx.cookies(BASE);
      if (cookies.length > 0) {
        const all = await loadCookies();
        all.anyrouter = cookies;
        await saveCookies(all);
      }
      console.log('anyrouter done, cookies:', cookies.length);
      return { success: true };
    }

    // Step 3: Session expired, try OAuth
    console.log('anyrouter: session expired, trying OAuth...');
    await page.goto(BASE + '/oauth/github', { waitUntil: 'domcontentloaded', timeout: 20000 });
    await sleep(5000);
    if (page.url().includes('login') || page.url().includes('oauth')) {
      console.log('anyrouter: OAuth blocked. run manually: node login-helper.js anyrouter');
      return { success: false, error: 'need_manual_login' };
    }

    // OAuth succeeded
    console.log('anyrouter: OAuth complete!');
    const cr = await page.evaluate(async () => {
      try { const r = await fetch('/api/user/checkin', { method: 'POST' }); return await r.json(); }
      catch(e) { return { error: e.message }; }
    });
    console.log('anyrouter checkin:', JSON.stringify(cr));

    const cookies = await ctx.cookies(BASE);
    const all = await loadCookies();
    all.anyrouter = cookies;
    await saveCookies(all);
    console.log('anyrouter done, cookies:', cookies.length);
    return { success: true };

  } catch (e) {
    console.error('anyrouter error:', e.message.substring(0, 100));
    return { success: false, error: e.message.substring(0, 100) };
  } finally {
    await page.close();
    await browser.close();
  }
}

module.exports = { run };
