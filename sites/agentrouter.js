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
  const BASE = 'https://agentrouter.org';

  // Non-headless: use a persistent profile so cookies survive
  const profileDir = path.join(__dirname, '..', '.cache', 'agentrouter_profile');
  if (!fs.existsSync(profileDir)) fs.mkdirSync(profileDir, { recursive: true });

  const browser = await chromium.launchPersistentContext(profileDir, {
    headless: false,
    channel: 'msedge',
    args: ['--disable-blink-features=AutomationControlled'],
    viewport: { width: 1280, height: 800 }
  });

  const page = browser.pages()[0] || await browser.newPage();

  try {
    // Check if already logged in via existing cookies
    const saved = await loadCookies();
    if (saved.agentrouter && saved.agentrouter.length > 0) {
      await browser.addCookies(saved.agentrouter);
      console.log('agentrouter: loaded saved cookies');
    }

    await page.goto(BASE + '/console/personal', { waitUntil: 'networkidle', timeout: 30000 });
    await sleep(3000);
    let url = page.url();
    console.log('agentrouter URL:', url);

    if (url.includes('login')) {
      console.log('agentrouter: not logged in, need to login');
      await page.goto(BASE + '/login', { waitUntil: 'domcontentloaded', timeout: 30000 });
      await sleep(3000);
      console.log('agentrouter login page URL:', page.url());

      // Click GitHub login button
      const clicked = await page.evaluate(() => {
        const svg = document.querySelector('[aria-label="github_logo"]');
        if (svg) {
          const btn = svg.closest('button') || svg.parentElement?.closest('button');
          if (btn) { btn.click(); return true; }
        }
        return false;
      });
      console.log('agentrouter GitHub button clicked:', clicked);

      if (!clicked) {
        console.log('agentrouter: GitHub button not found, trying alternative selectors');
        // Try all buttons
        const allBtns = await page.locator('button').all();
        for (const btn of allBtns) {
          const text = await btn.textContent().catch(() => '');
          if (text.includes('GitHub')) {
            await btn.click();
            console.log('agentrouter: clicked button with GitHub text');
            break;
          }
        }
      }

      await sleep(3000);
      console.log('agentrouter after click, URL:', page.url());

      // Wait for GitHub page or stay on login
      if (!page.url().includes('github.com')) {
        console.log('agentrouter: still on login page after click, checking page state');
        const pageText = await page.evaluate(() => document.body.innerText);
        console.log('agentrouter page text:', pageText.substring(0, 300));
        // If GitHub button didn't work, try username/password login
        if (GITHUB_USER && GITHUB_PASS) {
          console.log('agentrouter: trying username/password login with GitHub credentials');
          const inputs = await page.locator('input').all();
          if (inputs.length >= 2) {
            await inputs[0].fill(GITHUB_USER);
            await inputs[1].fill(GITHUB_PASS);
            await page.locator('button:has-text("继续"), button:has-text("登录")').first().click();
            await sleep(3000);
            console.log('agentrouter after credentials submit, URL:', page.url());
          }
        }
      }

      // If on GitHub login page, fill credentials
      if (page.url().includes('github.com/login')) {
        console.log('agentrouter: on GitHub login page');
        await page.locator('input[name="login"]').first().fill(GITHUB_USER);
        await page.locator('input[name="password"]').first().fill(GITHUB_PASS);
        await page.locator('input[type="submit"]').first().click();
        await sleep(2000);

        // Check for 2FA
        if (page.url().includes('github.com/login')) {
          console.log('agentrouter: 2FA required, cannot proceed automatically');
          return { success: false, error: '2fa_required' };
        }
      }

      // Wait for GitHub authorize page
      console.log('agentrouter: waiting for authorize page...');
      try {
        await page.waitForURL(u => u.toString().includes('authorize'), { timeout: 15000 });
        console.log('agentrouter: on authorize page, URL:', page.url());

        // Click Authorize
        const authBtn = page.locator('button[type="submit"], .btn-primary, text=Authorize').first();
        if (await authBtn.count() > 0) {
          console.log('agentrouter: clicking Authorize');
          await authBtn.click({ force: true });
        }
      } catch (e) {
        console.log('agentrouter: did not reach authorize page, current URL:', page.url());
      }

      await sleep(5000);
      console.log('agentrouter: final URL:', page.url());
    }

    // Check if logged in
    if (!page.url().includes('login')) {
      console.log('agentrouter: logged in!');
      // Try checkin
      try {
        const cookies = await browser.cookies(BASE);
        const cookieStr = cookies.map(c => c.name + '=' + c.value).join('; ');
        const resp = await page.request.post(BASE + '/api/user/checkin', {
          headers: { 'Cookie': cookieStr, 'Accept': 'application/json' }
        });
        console.log('agentrouter checkin status:', resp.status());
      } catch(e) {
        console.log('agentrouter checkin error:', e.message);
      }
    } else {
      console.log('agentrouter: still on login page');
    }

    // Save cookies
    const cookies = await browser.cookies(BASE);
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
    await browser.close();
  }
}

module.exports = { run };
