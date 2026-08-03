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

  let browser;
  try {
    browser = await chromium.launch({ headless: true, args: ['--proxy-server=http://127.0.0.1:10808'], channel: 'msedge' });
    console.log('agentrouter: using channel=msedge');
  } catch (e) {
    console.log('agentrouter: msedge not available, using built-in chromium');
    browser = await chromium.launch({ headless: true, args: ['--disable-blink-features=AutomationControlled'] });
  }

  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 }
  });

  const saved = await loadCookies();
  if (saved.agentrouter && saved.agentrouter.length > 0) await ctx.addCookies(saved.agentrouter);

  const page = await ctx.newPage();

  try {
    // Step 1: Get fresh Cloudflare cookies
    console.log('agentrouter: getting fresh CF cookies...');
    await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(5000);
    console.log('agentrouter CF passed, URL:', page.url());

    // Step 2: Try console with fresh CF + saved session
    await page.goto(BASE + '/console/personal', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(3000);
    const url = page.url();
    console.log('agentrouter URL:', url);

    if (url.includes('login')) {
      console.log('agentrouter: session expired, attempting login...');
      // Try OAuth via msedge
      await page.goto(BASE + '/login', { waitUntil: 'domcontentloaded', timeout: 60000 });
      await sleep(2000);

      // Check if GitHub OAuth button exists
      const hasGithubBtn = await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('button'));
        return btns.some(b => (b.textContent || '').includes('GitHub'));
      });

      if (hasGithubBtn) {
        console.log('agentrouter: GitHub OAuth available, cannot automate. Run: node login-helper.js agentrouter');
        return { success: false, error: 'need_manual_login' };
      }

      // Try email/password if available
      if (email && password) {
        const inputs = await page.locator('input').all();
        if (inputs.length >= 2) {
          await inputs[0].fill(email);
          await inputs[1].fill(password);
          const btn = page.locator('button:has-text("继续"), button[type=submit]');
          if (await btn.count() > 0) {
            await btn.first().click();
            await sleep(3000);
          }
        }
      }

      if (page.url().includes('login')) {
        console.log('agentrouter: login failed. Need manual OAuth.');
        return { success: false, error: 'need_manual_login' };
      }
    }

    console.log('agentrouter: logged in!');
    const cr = await page.evaluate(async () => {
      try { const r = await fetch('/api/user/checkin', { method: 'POST' }); return await r.text(); }
      catch(e) { return { error: e.message }; }
    });
    console.log('agentrouter checkin:', cr);

    const cookies = await ctx.cookies(BASE);
    if (cookies.length > 0) {
      const all = await loadCookies();
      all.agentrouter = cookies;
      await saveCookies(all);
      console.log('agentrouter cookies saved:', cookies.length);
    }
    console.log('agentrouter done');
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