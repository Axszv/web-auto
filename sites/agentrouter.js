// sites/agentrouter.js — 使用 sing-box VLESS 代理绕过 Cloudflare
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

  // 先尝试直接访问（无需代理）
  console.log('agentrouter: trying direct access...');
  try {
    const browser = await firefox.launch({
      headless: false,
      args: ['--no-sandbox']
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

    console.log('agentrouter: clearing old cookies...');
    await ctx.clearCookies();

    const page = await ctx.newPage();
    page.on('console', msg => console.log('[PAGE]', msg.text().substring(0, 200)));
    page.on('pageerror', err => console.log('[PAGE ERROR]', err.message));

    try {
      await page.goto(BASE + '/login', { waitUntil: 'domcontentloaded', timeout: 60000 });
      await sleep(5000);
      console.log('agentrouter direct URL:', page.url());
      const loggedIn = await handleLogin(page, ctx, BASE, GH_USER, GH_PASS, browser);
      const checkinSuccess = loggedIn ? await doCheckin(page, ctx, BASE, browser) : false;

      const cookies = await ctx.cookies(BASE);
      if (cookies.length > 0) {
        const all = await loadCookies();
        all.agentrouter = cookies;
        await saveCookies(all);
        console.log('agentrouter cookies saved:', cookies.length);
      }

      await browser.close();
      console.log('agentrouter done, checkinSuccess:', checkinSuccess);
      return { success: true, checkinSuccess };
    } catch (e) {
      console.log('agentrouter: direct access failed:', e.message);
      await browser.close();
      throw e;
    }
  } catch (e) {
    console.log('agentrouter: direct failed, trying proxy...');
    return await runWithProxy(config);
  }
}

async function runWithProxy(config) {
  const GH_USER = config.GH_USER || process.env.GH_USER || '';
  const GH_PASS = config.GH_PASS || process.env.GH_PASS || '';
  const BASE = 'https://agentrouter.org';
  const PROXY = { server: 'http://127.0.0.1:1080' };

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

  console.log('agentrouter (proxy): clearing old cookies...');
  await ctx.clearCookies();

  const page = await ctx.newPage();
  page.on('console', msg => console.log('[PAGE]', msg.text().substring(0, 200)));
  page.on('pageerror', err => console.log('[PAGE ERROR]', err.message));

  try {
    console.log('agentrouter (proxy): navigating via proxy...');
    await page.goto(BASE + '/login', { waitUntil: 'domcontentloaded', timeout: 90000 });
    await sleep(5000);
    console.log('agentrouter (proxy) URL:', page.url());

    const loggedIn = await handleLogin(page, ctx, BASE, GH_USER, GH_PASS, browser);
    const checkinSuccess = loggedIn ? await doCheckin(page, ctx, BASE, browser) : false;

    const cookies = await ctx.cookies(BASE);
    if (cookies.length > 0) {
      const all = await loadCookies();
      all.agentrouter = cookies;
      await saveCookies(all);
      console.log('agentrouter (proxy) cookies saved:', cookies.length);
    }

    await browser.close();
    console.log('agentrouter (proxy) done, checkinSuccess:', checkinSuccess);
    return { success: true, checkinSuccess };
  } catch (e) {
    console.error('agentrouter (proxy) error:', e.message);
    await browser.close();
    return { success: false, error: e.message };
  }
}

async function handleLogin(page, ctx, BASE, GH_USER, GH_PASS, browser) {
  let loggedIn = false;

  // 查找 GitHub 按钮
  let githubBtn = page.locator('[aria-label="github_logo"]');
  if (await githubBtn.count() === 0) {
    githubBtn = page.locator('text=Continue with GitHub');
  }
  if (await githubBtn.count() === 0) {
    githubBtn = page.locator('.semi-icon-github_logo');
  }

  console.log('agentrouter: found GitHub button:', await githubBtn.count());

  if (await githubBtn.count() > 0) {
    console.log('agentrouter: clicking GitHub OAuth button...');
    await githubBtn.first().click({ force: true });
    await sleep(5000);
    console.log('agentrouter after click, URL:', page.url());

    if (page.url().includes('github.com')) {
      console.log('agentrouter: on GitHub page');

      if (page.url().includes('/login')) {
        console.log('agentrouter: on GitHub login page');
        await page.locator('input[name="login"]').first().fill(GH_USER);
        await page.locator('input[name="password"]').first().fill(GH_PASS);
        await page.locator('input[type="submit"]').first().click();
        await sleep(2000);
        if (page.url().includes('/login')) {
          console.log('agentrouter: 2FA required');
          await browser.close();
          return false;
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
      loggedIn = !page.url().includes('login');
    } else {
      console.log('agentrouter: click did not navigate to GitHub');
    }
  } else {
    console.log('agentrouter: no GitHub button found, trying console page...');
    await page.goto(BASE + '/console', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(3000);
    loggedIn = !page.url().includes('login');
    console.log('agentrouter: logged in status:', loggedIn);
  }

  return loggedIn;
}

async function doCheckin(page, ctx, BASE, browser) {
  let checkinSuccess = false;
  try {
    const cookies = await ctx.cookies(BASE);
    const cookieStr = cookies.map(c => c.name + '=' + c.value).join('; ');

    let beforeBalance = null;
    try {
      const infoResp = await page.request.get(BASE + '/api/user/info', {
        headers: { 'Cookie': cookieStr, 'Accept': 'application/json' }
      });
      if (infoResp.ok()) {
        const info = await infoResp.json();
        beforeBalance = info.data?.balance || info.data?.credits || info.balance || info.credits;
        console.log('agentrouter: balance before checkin:', beforeBalance);
      }
    } catch(e) { console.log('agentrouter: failed to get before balance'); }

    const resp = await page.request.post(BASE + '/api/user/checkin', {
      headers: { 'Cookie': cookieStr, 'Accept': 'application/json' }
    });
    console.log('agentrouter checkin status:', resp.status());

    let checkinResult = null;
    if (resp.ok()) {
      try {
        checkinResult = await resp.json();
        console.log('agentrouter checkin result:', JSON.stringify(checkinResult));
      } catch(e) {
        const text = await resp.text();
        console.log('agentrouter checkin response (not JSON):', text.substring(0, 200));
      }
    }

    let afterBalance = null;
    try {
      const infoResp2 = await page.request.get(BASE + '/api/user/info', {
        headers: { 'Cookie': cookieStr, 'Accept': 'application/json' }
      });
      if (infoResp2.ok()) {
        const info2 = await infoResp2.json();
        afterBalance = info2.data?.balance || info2.data?.credits || info2.balance || info2.credits;
        console.log('agentrouter: balance after checkin:', afterBalance);
      }
    } catch(e) { console.log('agentrouter: failed to get after balance'); }

    if (checkinResult) {
      if (checkinResult.code === 200 || checkinResult.success === true) {
        checkinSuccess = true;
        console.log('agentrouter: checkin successful (API returned success)');
      }
    }
    if (beforeBalance !== null && afterBalance !== null) {
      const diff = afterBalance - beforeBalance;
      console.log('agentrouter: balance change:', diff);
      if (diff >= 25) {
        checkinSuccess = true;
        console.log('agentrouter: balance increased by', diff, '-> checkin successful!');
      }
    }
  } catch(e) { console.log('agentrouter checkin error:', e.message); }

  return checkinSuccess;
}

module.exports = { run };
