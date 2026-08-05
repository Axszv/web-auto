// sites/agentrouter.js
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
      console.log('agentrouter: using channel=' + ch);
      return b;
    } catch (e) { /* try next */ }
  }
  console.log('agentrouter: using built-in chromium');
  return await chromium.launch({ headless: true, args: ['--disable-blink-features=AutomationControlled'] });
}

async function run(config = {}) {
  const BASE = 'https://agentrouter.org';
  const browser = await launchBrowser();
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 }
  });

  const saved = await loadCookies();
  if (saved.agentrouter && saved.agentrouter.length > 0) await ctx.addCookies(saved.agentrouter);

  const page = await ctx.newPage();

  try {
    await page.goto(BASE + '/console/personal', { waitUntil: 'networkidle', timeout: 30000 });
    await sleep(3000);
    const url = page.url();
    console.log('agentrouter URL:', url);

    if (url.includes('login')) {
      await page.goto(BASE + '/login', { waitUntil: 'networkidle', timeout: 30000 });
      await sleep(2000);
      const inputs = await page.locator('input').all();
      const token = config.token || '';
      if (token && inputs.length >= 2) {
        await inputs[0].fill(token);
        await inputs[1].fill('');
        await page.evaluate(() => { const b = document.querySelector('button[type="submit"]'); if(b) b.click(); });
        await sleep(3000);
      }
      if (page.url().includes('login')) {
        console.log('agentrouter: need username/password (token invalid).');
        return { success: false, error: 'need_manual_login' };
      }
    }

    console.log('agentrouter: logged in');
    const cr = await page.evaluate(async () => {
      try { const r = await fetch('/api/user/checkin', {
          method: 'POST',
          headers: { 'Accept': 'application/json', 'Referer': 'https://agentrouter.org/console/personal' }
        }); return await r.json(); }
      catch(e) { return { error: e.message }; }
    });
    console.log('agentrouter checkin:', JSON.stringify(cr));

    const cookies = await ctx.cookies(BASE);
    if (cookies.length > 0) {
      const all = await loadCookies();
      all.agentrouter = cookies;
      await saveCookies(all);
    }
    console.log('agentrouter done, cookies:', cookies.length);
    return { success: true };
  } catch (e) {
    console.error('agentrouter error:', e.message);
    return { success: false, error: e.message };
  } finally {
    await page.close();
    await browser.close();
  }
}

module.exports = { run };


