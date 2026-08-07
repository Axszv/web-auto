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
  const GITHUB_USER = config.github_user || process.env.GITHUB_USER || '';
  const GITHUB_PASS = config.github_pass || process.env.GITHUB_PASS || '';
  const BASE = 'https://anyrouter.top';

  const profileDir = path.join(__dirname, '..', '.cache', 'anyrouter_profile');
  if (!fs.existsSync(profileDir)) fs.mkdirSync(profileDir, { recursive: true });

  const browser = await chromium.launchPersistentContext(profileDir, {
    headless: false,
    channel: 'msedge',
    args: ['--disable-blink-features=AutomationControlled'],
    viewport: { width: 1280, height: 800 }
  });

  const page = browser.pages()[0] || await browser.newPage();

  try {
    const saved = await loadCookies();
    if (saved.anyrouter && saved.anyrouter.length > 0) {
      await browser.addCookies(saved.anyrouter);
      console.log('anyrouter: loaded saved cookies');
    }

    // Bypass Cloudflare first
    console.log('anyrouter: bypassing Cloudflare...');
    await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(15000);
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

      // Click GitHub button
      const clicked = await page.evaluate(() => {
        const svg = document.querySelector('[aria-label="github_logo"]');
        if (svg) {
          const btn = svg.closest('button') || svg.parentElement?.closest('button');
          if (btn) { btn.click(); return true; }
        }
        return false;
      });
      console.log('anyrouter GitHub button clicked:', clicked);

      await sleep(3000);
      console.log('anyrouter after click, URL:', page.url());

      // On GitHub login?
      if (page.url().includes('github.com/login')) {
        console.log('anyrouter: on GitHub login page');
        await page.locator('input[name="login"]').first().fill(GITHUB_USER);
        await page.locator('input[name="password"]').first().fill(GITHUB_PASS);
        await page.locator('input[type="submit"]').first().click();
        await sleep(2000);
        if (page.url().includes('github.com/login')) {
          console.log('anyrouter: 2FA required');
          return { success: false, error: '2fa_required' };
        }
      }

      // On authorize page?
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

    // Save cookies
    const cookies = await browser.cookies(BASE);
    if (cookies.length > 0) {
      const all = await loadCookies();
      all.anyrouter = cookies;
      await saveCookies(all);
      console.log('anyrouter cookies saved:', cookies.length);
    }

    console.log('anyrouter done');
    return { success: true };
  } catch (e) {
    console.error('anyrouter error:', e.message);
    return { success: false, error: e.message };
  } finally {
    await browser.close();
  }
}

module.exports = { run };
