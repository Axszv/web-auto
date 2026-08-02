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

async function launchBrowser() {
  const channels = ['msedge', 'chrome'];
  for (const ch of channels) {
    try {
      const b = await chromium.launch({ headless: true, channel: ch });
      console.log('anyrouter: using channel=' + ch);
      return b;
    } catch (e) { /* try next */ }
  }
  console.log('anyrouter: using built-in chromium');
  return await chromium.launch({ headless: true, args: ['--disable-blink-features=AutomationControlled'] });
}

async function run(config = {}) {
  const BASE = 'https://anyrouter.top';
  const browser = await launchBrowser();
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 }
  });

  const saved = await loadCookies();
  if (saved.anyrouter && saved.anyrouter.length > 0) await ctx.addCookies(saved.anyrouter);

  const page = await ctx.newPage();

  try {
    await page.goto(BASE + '/console/personal', { waitUntil: 'networkidle', timeout: 30000 });
    await sleep(3000);
    const url = page.url();
    console.log('anyrouter URL:', url);

    if (url.includes('login')) {
      // Try GitHub OAuth
      await page.goto(BASE + '/oauth/github', { waitUntil: 'networkidle', timeout: 30000 });
      await sleep(8000);
      const newUrl = page.url();
      console.log('anyrouter oauth URL:', newUrl);
      if (newUrl.includes('login') || newUrl.includes('oauth') || newUrl.includes('github.com')) {
        console.log('anyrouter: oauth blocked. need manual login.');
        return { success: false, error: 'need_manual_login' };
      }
    }

    console.log('anyrouter: logged in');
    const cr = await page.evaluate(async () => {
      try { const r = await fetch('/api/user/checkin', { method: 'POST' }); return await r.json(); }
      catch(e) { return { error: e.message }; }
    });
    console.log('anyrouter checkin:', JSON.stringify(cr));

    const cookies = await ctx.cookies(BASE);
    if (cookies.length > 0) {
      const all = await loadCookies();
      all.anyrouter = cookies;
      await saveCookies(all);
    }
    console.log('anyrouter done, cookies:', cookies.length);
    return { success: true };
  } catch (e) {
    console.error('anyrouter error:', e.message);
    return { success: false, error: e.message };
  } finally {
    await page.close();
    await browser.close();
  }
}

module.exports = { run };
