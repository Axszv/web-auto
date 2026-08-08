// sites/agentrouter.js — 使用HTTP代理绕过Cloudflare
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
  const GH_USER = config.GH_USER || process.env.GH_USER || '';
  const GH_PASS = config.GH_PASS || process.env.GH_PASS || '';
  const BASE = 'https://agentrouter.org';

  // oxylabs免费住宅代理
  const PROXY = { server: 'http://proxy.oxylabs.io:55000', username: 'lkjh5_4gW1v', password: 'Lz1979474206_' };

  const browser = await firefox.launch({
    headless: false,
    args: ['--no-sandbox'],
    proxy: PROXY
  });

  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
    locale: 'en-US'
  });

  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
  });

  const saved = await loadCookies();
  if (saved.agentrouter && saved.agentrouter.length > 0) await ctx.addCookies(saved.agentrouter);

  const page = await ctx.newPage();
  page.on('console', msg => console.log('[PAGE]', msg.text().substring(0, 200)));
  page.on('pageerror', err => console.log('[PAGE ERROR]', err.message));

  try {
    console.log('agentrouter: navigating via proxy...');
    await page.goto(BASE + '/login', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(5000);
    console.log('agentrouter URL:', page.url());

    const pageText = await page.evaluate(() => document.body.innerText);
    console.log('agentrouter page text:', pageText.substring(0, 300));

    if (pageText.includes('Access Verification') || pageText.includes('verification')) {
      console.log('agentrouter: still blocked by verification');
    }

    const hasGitHubBtn = await page.evaluate(() => !!document.querySelector('[aria-label="github_logo"]'));
    console.log('agentrouter: has GitHub button:', hasGitHubBtn);

    if (hasGitHubBtn) {
      await page.evaluate(() => {
        const svg = document.querySelector('[aria-label="github_logo"]');
        if (svg) {
          const btn = svg.closest('button') || svg.parentElement?.closest('button');
          if (btn) btn.click();
        }
      });
      await sleep(3000);
      console.log('agentrouter after click, URL:', page.url());

      if (page.url().includes('github.com/login') && GH_USER && GH_PASS) {
        console.log('agentrouter: on GitHub login page');
        await page.locator('input[name="login"]').first().fill(GH_USER);
        await page.locator('input[name="password"]').first().fill(GH_PASS);
        await page.locator('input[type="submit"]').first().click();
        await sleep(2000);
        if (page.url().includes('github.com/login')) {
          console.log('agentrouter: 2FA required');
          await browser.close();
          return { success: false, error: '2fa_required' };
        }
      }

      try {
        await page.waitForURL(u => u.toString().includes('authorize'), { timeout: 15000 });
        console.log('agentrouter: on authorize page');
        const authBtn = page.locator('button[type="submit"], .btn-primary, text=Authorize').first();
        if (await authBtn.count() > 0) {
          await authBtn.click({ force: true });
          console.log('agentrouter: clicked Authorize');
        }
      } catch (e) {
        console.log('agentrouter: did not reach authorize, URL:', page.url());
      }

      await sleep(5000);
      console.log('agentrouter: final URL:', page.url());
    }

    if (!page.url().includes('login')) {
      console.log('agentrouter: logged in!');
      try {
        const cookies = await ctx.cookies(BASE);
        const cookieStr = cookies.map(c => c.name + '=' + c.value).join('; ');
        const resp = await page.request.post(BASE + '/api/user/checkin', {
          headers: { 'Cookie': cookieStr, 'Accept': 'application/json' }
        });
        console.log('agentrouter checkin status:', resp.status());
      } catch(e) {}
    } else {
      console.log('agentrouter: still on login page');
    }

    const cookies = await ctx.cookies(BASE);
    if (cookies.length > 0) {
      const all = await loadCookies();
      all.agentrouter = cookies;
      await saveCookies(all);
      console.log('agentrouter cookies saved:', cookies.length);
    }

    await browser.close();
    console.log('agentrouter done');
    return { success: true };
  } catch (e) {
    console.error('agentrouter error:', e.message);
    await browser.close();
    return { success: false, error: e.message };
  }
}

module.exports = { run };
