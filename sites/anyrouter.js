// sites/anyrouter.js — 完整的 Cloudflare + GitHub OAuth 自动化
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
    // Step 1: Visit main page to get Cloudflare challenge cookies
    console.log('anyrouter: bypassing Cloudflare...');
    await page.goto(BASE + '/', { waitUntil: 'networkidle', timeout: 30000 });
    await sleep(3000);
    const afterMain = page.url();
    console.log('anyrouter after main:', afterMain);

    // Step 2: Check if already logged in (session cookie still valid)
    await page.goto(BASE + '/console/personal', { waitUntil: 'networkidle', timeout: 30000 });
    await sleep(3000);
    const url = page.url();
    console.log('anyrouter URL:', url);

    if (!url.includes('login') && !url.includes('oauth')) {
      console.log('anyrouter: already logged in!');
      // Do checkin
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

    // Step 3: Try GitHub OAuth - click the button
    console.log('anyrouter: trying GitHub OAuth...');
    await page.goto(BASE + '/login', { waitUntil: 'networkidle', timeout: 30000 });
    await sleep(2000);

    // Click GitHub button via evaluate (bypasses Cloudflare overlay)
    const clicked = await page.evaluate(() => {
      const all = document.querySelectorAll('button');
      for (const el of all) {
        if (el.textContent && el.textContent.includes('GitHub')) {
          el.click();
          return 'clicked';
        }
      }
      // Try spans too
      const spans = document.querySelectorAll('span');
      for (const el of spans) {
        if (el.textContent && el.textContent.includes('GitHub')) {
          el.click();
          return 'clicked-span';
        }
      }
      return 'not-found';
    });
    console.log('anyrouter click result:', clicked);

    await sleep(5000);

    // Check if OAuth page opened
    const oauthPage = ctx.pages().find(p => p.url().includes('github.com'));
    if (oauthPage) {
      console.log('anyrouter: OAuth page opened');
      console.log('anyrouter: GitHub OAuth URL:', oauthPage.url().substring(0, 80));

      // Check if GitHub session exists
      const ghText = await oauthPage.locator('body').innerText().catch(() => '');
      const ghSignedIn = ghText.includes('Sign out') || ghText.includes('退出');
      console.log('anyrouter: GitHub signed in:', ghSignedIn);

      if (!ghSignedIn) {
        console.log('anyrouter: GitHub not logged in. Please login in the opened browser tab.');
        // Wait for user to login
        for (let i = 0; i < 180; i++) {
          await sleep(2000);
          const newText = await oauthPage.locator('body').innerText().catch(() => '');
          if (newText.includes('Sign out') || newText.includes('退出')) {
            console.log('anyrouter: GitHub login detected!');
            break;
          }
          if (i % 10 === 0) console.log('anyrouter: waiting for GitHub login... ' + (i*2) + 's');
        }
      }

      // Wait for OAuth callback
      console.log('anyrouter: waiting for OAuth callback...');
      for (let i = 0; i < 90; i++) {
        await sleep(2000);
        const anyrouterPages = ctx.pages().filter(p => p.url().includes('anyrouter.top'));
        for (const p of anyrouterPages) {
          const u = p.url();
          if (!u.includes('login') && !u.includes('oauth') && !u.includes('github')) {
            console.log('anyrouter: OAuth complete! URL:', u);
            
            // Do checkin
            const cr = await p.evaluate(async () => {
              try { const r = await fetch('/api/user/checkin', { method: 'POST' }); return await r.json(); }
              catch(e) { return { error: e.message }; }
            });
            console.log('anyrouter checkin:', JSON.stringify(cr));
            
            const cookies = await ctx.cookies(BASE);
            const all = await loadCookies();
            all.anyrouter = cookies;
            await saveCookies(all);
            console.log('anyrouter cookies saved:', cookies.length);
            
            await browser.close();
            return { success: true };
          }
        }
        if (i % 10 === 0) console.log('anyrouter: waiting... ' + (i*2) + 's');
      }
    }

    console.log('anyrouter: OAuth failed or timed out.');
    return { success: false, error: 'OAuth failed - need manual login' };

  } catch (e) {
    console.error('anyrouter error:', e.message);
    return { success: false, error: e.message };
  } finally {
    await page.close();
    await browser.close();
  }
}

module.exports = { run };
