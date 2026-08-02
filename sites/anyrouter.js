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
    // Step 1: bypass Cloudflare by visiting main page
    console.log('anyrouter: bypassing Cloudflare...');
    await page.goto(BASE + '/', { waitUntil: 'networkidle', timeout: 25000 });
    await sleep(3000);
    console.log('anyrouter after main:', page.url());

    // Step 2: try console with existing cookies
    console.log('anyrouter: checking session...');
    await page.goto(BASE + '/console/personal', { waitUntil: 'networkidle', timeout: 25000 });
    await sleep(3000);
    const url = page.url();
    console.log('anyrouter URL:', url);

    if (!url.includes('login') && !url.includes('oauth')) {
      console.log('anyrouter: logged in!');
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
    }

    // Step 3: try OAuth - with strict timeout
    console.log('anyrouter: trying GitHub OAuth...');
    await page.goto(BASE + '/login', { waitUntil: 'networkidle', timeout: 25000 });
    await sleep(2000);

    const clicked = await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('GitHub'));
      if (btn) { btn.click(); return 'button'; }
      const span = Array.from(document.querySelectorAll('span')).find(s => s.textContent.includes('GitHub'));
      if (span) { span.click(); return 'span'; }
      return 'none';
    });
    console.log('anyrouter click:', clicked);

    // Wait for OAuth page to open (max 10s)
    await sleep(8000);
    const oauthPage = ctx.pages().find(p => p.url().includes('github.com'));
    
    if (oauthPage) {
      console.log('anyrouter: OAuth opened');
      // Check if already signed into GitHub
      const ghText = await oauthPage.locator('body').innerText().catch(() => '');
      const ghSignedIn = ghText.includes('Sign out') || ghText.includes('退出');
      
      if (ghSignedIn) {
        console.log('anyrouter: GitHub already signed in, waiting for redirect...');
        // Wait for redirect back to anyrouter (max 15s)
        for (let i = 0; i < 15; i++) {
          await sleep(1000);
          const anyPages = ctx.pages().filter(p => p.url().includes('anyrouter.top'));
          for (const p of anyPages) {
            if (!p.url().includes('login') && !p.url().includes('oauth') && !p.url().includes('github')) {
              console.log('anyrouter: OAuth callback received!');
              const cr = await p.evaluate(async () => {
                try { const r = await fetch('/api/user/checkin', { method: 'POST' }); return await r.json(); }
                catch(e) { return { error: e.message }; }
              });
              console.log('anyrouter checkin:', JSON.stringify(cr));
              const cookies = await ctx.cookies(BASE);
              const all = await loadCookies();
              all.anyrouter = cookies;
              await saveCookies(all);
              return { success: true };
            }
          }
        }
      }
      console.log('anyrouter: OAuth did not complete automatically.');
    }

    console.log('anyrouter: cannot auto-login. Need manual GitHub OAuth login.');
    console.log('anyrouter: Run: node login-helper.js anyrouter');
    return { success: false, error: 'need_manual_login' };

  } catch (e) {
    console.error('anyrouter error:', e.message);
    return { success: false, error: e.message };
  } finally {
    await page.close();
    await browser.close();
  }
}

module.exports = { run };
