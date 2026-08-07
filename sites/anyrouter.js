// sites/anyrouter.js — Uses Playwright Firefox with anti-detection
const { firefox } = require('playwright');
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
  const GITHUB_USER = config.github_user || process.env.GITHUB_USER || '';
  const GITHUB_PASS = config.github_pass || process.env.GITHUB_PASS || '';
  const BASE = 'https://anyrouter.top';

  const browser = await firefox.launch({
    headless: true,
    args: ['--no-sandbox']
  });

  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0',
    viewport: { width: 1280, height: 800 },
    locale: 'en-US'
  });

  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
  });

  const saved = await loadCookies();
  if (saved.anyrouter && saved.anyrouter.length > 0) await ctx.addCookies(saved.anyrouter);

  const page = await ctx.newPage();
  page.on('console', msg => console.log('[PAGE]', msg.text().substring(0, 200)));
  page.on('pageerror', err => console.log('[PAGE ERROR]', err.message));

  try {
    console.log('anyrouter: starting...');
    await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(5000);
    console.log('anyrouter after main:', page.url());

    await page.goto(BASE + '/console/personal', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(3000);
    let url = page.url();
    console.log('anyrouter URL:', url);

    if (url.includes('login') || url.includes('oauth')) {
      console.log('anyrouter: not logged in');
      await page.goto(BASE + '/login', { waitUntil: 'domcontentloaded', timeout: 30000 });
      await sleep(3000);
      console.log('anyrouter login page URL:', page.url());

      const pageText = await page.evaluate(() => document.body.innerText);
      console.log('anyrouter page text:', pageText.substring(0, 300));

      const hasGitHubBtn = await page.evaluate(() => !!document.querySelector('[aria-label="github_logo"]'));
      console.log('anyrouter: has GitHub button:', hasGitHubBtn);

      if (hasGitHubBtn) {
        await page.evaluate(() => {
          const svg = document.querySelector('[aria-label="github_logo"]');
          if (svg) {
            const btn = svg.closest('button') || svg.parentElement?.closest('button');
            if (btn) btn.click();
          }
        });
        await sleep(3000);
        console.log('anyrouter after click, URL:', page.url());

        if (page.url().includes('github.com/login') && GITHUB_USER && GITHUB_PASS) {
          console.log('anyrouter: on GitHub login page');
          await page.locator('input[name="login"]').first().fill(GITHUB_USER);
          await page.locator('input[name="password"]').first().fill(GITHUB_PASS);
          await page.locator('input[type="submit"]').first().click();
          await sleep(2000);
          if (page.url().includes('github.com/login')) {
            console.log('anyrouter: 2FA required');
            await browser.close();
            return { success: false, error: '2fa_required' };
          }
        }

        try {
          await page.waitForURL(u => u.toString().includes('authorize'), { timeout: 15000 });
          console.log('anyrouter: on authorize page');
          const authBtn = page.locator('button[type="submit"], .btn-primary, text=Authorize').first();
          if (await authBtn.count() > 0) {
            await authBtn.click({ force: true });
            console.log('anyrouter: clicked Authorize');
          }
        } catch (e) {
          console.log('anyrouter: did not reach authorize, URL:', page.url());
        }

        await sleep(5000);
        console.log('anyrouter: final URL:', page.url());
      }
    }

    if (!page.url().includes('login')) {
      console.log('anyrouter: logged in!');
      try {
        const cr = await page.evaluate(async () => {
          try { const r = await fetch('/api/user/checkin', { method: 'POST' }); return await r.json(); }
          catch(e) { return { error: e.message }; }
        });
        console.log('anyrouter checkin:', JSON.stringify(cr));
      } catch(e) {}
    } else {
      console.log('anyrouter: still on login page');
    }

    const cookies = await ctx.cookies(BASE);
    if (cookies.length > 0) {
      const all = await loadCookies();
      all.anyrouter = cookies;
      await saveCookies(all);
      console.log('anyrouter cookies saved:', cookies.length);
    }

    await browser.close();
    console.log('anyrouter done');
    return { success: true };
  } catch (e) {
    console.error('anyrouter error:', e.message);
    await browser.close();
    return { success: false, error: e.message };
  }
}

module.exports = { run };
