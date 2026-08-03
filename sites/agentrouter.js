// sites/agentrouter.js
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
  const BASE = 'https://agentrouter.org';
  const email = config.email || process.env.AGENTROUTER_EMAIL || '';
  const password = config.password || process.env.AGENTROUTER_PASSWORD || '';

  const browser = await chromium.launch({
    headless: true,
    args: ['--proxy-server=http://127.0.0.1:10808', '--disable-blink-features=AutomationControlled']
  });
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 }
  });

  const saved = await loadCookies();
  if (saved.agentrouter && saved.agentrouter.length > 0) await ctx.addCookies(saved.agentrouter);

  const page = await ctx.newPage();

  try {
    // Step 1: Pass Cloudflare
    console.log('agentrouter: passing Cloudflare...');
    await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(5000);
    console.log('agentrouter: CF passed, URL:', page.url());

    // Step 2: Try console page with saved session
    await page.goto(BASE + '/console/personal', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(3000);
    const url = page.url();
    console.log('agentrouter: console URL:', url);

    if (url.includes('login')) {
      console.log('agentrouter: session expired, attempting login...');
      await page.goto(BASE + '/login', { waitUntil: 'domcontentloaded', timeout: 60000 });
      await sleep(3000);

      // Wait for form to render
      await page.waitForSelector('#username', { timeout: 15000 }).catch(() => {});
      await sleep(1000);

      if (email && password) {
        console.log('agentrouter: trying password login...');
        await page.fill('#username', email);
        await page.fill('#password', password);
        await sleep(500);

        const apiCalls = [];
        page.on('response', async (resp) => {
          if (resp.url().includes('/api/')) {
            try {
              const text = await resp.text();
              apiCalls.push({ path: resp.url().split('/api/')[1], status: resp.status(), body: text.substring(0, 200) });
            } catch(e) {}
          }
        });

        await page.click('button:has-text("继续")');
        await sleep(4000);

        console.log('agentrouter: login API calls:', JSON.stringify(apiCalls));

        if (page.url().includes('login')) {
          console.log('agentrouter: login failed with password');
          return { success: false, error: 'password_login_failed' };
        }
        console.log('agentrouter: password login successful!');
      } else {
        console.log('agentrouter: no credentials provided. Need manual login.');
        return { success: false, error: 'need_manual_login' };
      }
    }

    // Step 3: Check in
    console.log('agentrouter: checking in...');
    const cr = await page.evaluate(async () => {
      try {
        const r = await fetch('/api/user/checkin', { method: 'POST' });
        return await r.json();
      } catch(e) { return { error: e.message }; }
    });
    console.log('agentrouter: checkin result:', JSON.stringify(cr));

    // Step 4: Save cookies
    const cookies = await ctx.cookies(BASE);
    if (cookies.length > 0) {
      const all = await loadCookies();
      all.agentrouter = cookies;
      await saveCookies(all);
      console.log('agentrouter: cookies saved:', cookies.length);
    }
    console.log('agentrouter: done');
    return { success: true, checkin: cr };
  } catch (e) {
    console.error('agentrouter error:', e.message);
    return { success: false, error: e.message };
  } finally {
    await page.close();
    await browser.close();
  }
}

module.exports = { run };
