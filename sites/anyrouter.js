// sites/anyrouter.js — GitHub OAuth with CF bypass via context route
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
  const useProxy = process.env.HTTP_PROXY || process.env.all_proxy || '';

  const browser = await chromium.launch({
    headless: true,
    args: useProxy
      ? ['--proxy-server=' + useProxy, '--disable-blink-features=AutomationControlled', '--disable-popup-blocking', '--ignore-certificate-errors']
      : ['--disable-blink-features=AutomationControlled', '--disable-popup-blocking']
  });
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 }
  });

  // Clear old expired cookies
  const saved = await loadCookies();
  if (saved.anyrouter && saved.anyrouter.length > 0) {
    console.log('anyrouter: clearing old expired cookies...');
    await ctx.clearCookies();
  }

  // Context-level route to bypass CF on /api/status
  await ctx.route('**/api/status', route => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        data: {
          github_oauth: true,
          linuxdo_oauth: true,
          github_client_id: 'Ov23lidtiR4LeVZvVRNL',
          linuxdo_client_id: 'KZUecGfhhDZMVnv8UtEdhOhf9sNOhqVX',
          wechat_login: false,
          telegram_oauth: false,
          oidc_enabled: false,
          announcements: [],
          announcements_enabled: false,
          system_name: 'Any Router',
          setup: true
        },
        success: true
      })
    });
  });
  await ctx.route('**/api/notice', route => {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: [], success: true }) });
  });

  const page = await ctx.newPage();

  try {
    // Step 1: Visit main page to pass Cloudflare
    console.log('anyrouter: visiting main page...');
    await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 120000 });
    await sleep(15000);
    console.log('anyrouter: main page URL:', page.url());

    // Step 2: Navigate to login
    console.log('anyrouter: going to login...');
    await page.goto(BASE + '/login', { waitUntil: 'domcontentloaded', timeout: 120000 });
    await sleep(8000);
    console.log('anyrouter: login URL:', page.url());

    // Close announcement
    const closeBtn = page.locator('button:has-text(\"关闭公告\")');
    if (await closeBtn.count() > 0) await closeBtn.first().click();
    await sleep(2000);

    // Step 3: Check if already logged in
    if (!page.url().includes('login')) {
      console.log('anyrouter: already logged in!');
    } else {
      // Step 4: Use GitHub OAuth
      console.log('anyrouter: using GitHub OAuth...');
      
      // Reload to ensure status API is called with mock
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 120000 });
      await sleep(8000);
      
      // Click GitHub OAuth button
      const hasGitHubBtn = await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('button'));
        return btns.some(b => (b.textContent || '').includes('GitHub'));
      });

      if (hasGitHubBtn) {
        console.log('anyrouter: GitHub button found, clicking...');
        await page.evaluate(() => {
          const btns = Array.from(document.querySelectorAll('button'));
          for (const b of btns) {
            if ((b.textContent || '').includes('GitHub')) {
              b.click();
              return;
            }
          }
        });
        await sleep(5000);
        console.log('anyrouter: OAuth initiated, URL:', page.url());
        
        // Check for new pages (popup)
        const pages = ctx.pages();
        for (const p of pages) {
          if (p !== page) {
            console.log('anyrouter: popup URL:', p.url());
          }
        }
      } else {
        console.log('anyrouter: GitHub button not found');
        const btns = await page.evaluate(() => 
          Array.from(document.querySelectorAll('button')).map(b => b.textContent.trim()).filter(t => t.length > 0)
        );
        console.log('anyrouter: buttons:', JSON.stringify(btns));
      }
    }

    // Step 5: Try checkin if logged in
    if (!page.url().includes('login')) {
      console.log('anyrouter: checking in...');
      const cr = await page.evaluate(async () => {
        try { const r = await fetch('/api/user/checkin', { method: 'POST' }); return await r.json(); }
        catch(e) { return { error: e.message }; }
      });
      console.log('anyrouter: checkin:', JSON.stringify(cr));
    }

    // Step 6: Save cookies
    const cookies = await ctx.cookies(BASE);
    if (cookies.length > 0) {
      const all = await loadCookies();
      all.anyrouter = cookies;
      await saveCookies(all);
      console.log('anyrouter: cookies saved:', cookies.length);
    }
    console.log('anyrouter: done');
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
