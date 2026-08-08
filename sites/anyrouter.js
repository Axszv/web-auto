// sites/anyrouter.js — 使用 Chromium 尝试 GitHub OAuth
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
  const GH_USER = config.GH_USER || process.env.GH_USER || '';
  const GH_PASS = config.GH_PASS || process.env.GH_PASS || '';
  const BASE = 'https://anyrouter.top';

  console.log('anyrouter: launching chromium...');
  const browser = await chromium.launch({
    headless: false,
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled']
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
    Object.defineProperty(navigator, 'platform', { get: () => 'Win32' });
    Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });
    Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 });
  });

  // 尝试加载现有 session cookie
  const existingCookies = await loadCookies();
  if (existingCookies.anyrouter) {
    const sessionCookies = existingCookies.anyrouter.filter(c => c.name === 'session');
    if (sessionCookies.length > 0) {
      console.log('anyrouter: restoring existing session cookie...');
      await ctx.addCookies(sessionCookies);
    }
  }

  await ctx.clearCookies();
  if (existingCookies.anyrouter) {
    const sessionCookies = existingCookies.anyrouter.filter(c => c.name === 'session');
    if (sessionCookies.length > 0) {
      await ctx.addCookies(sessionCookies);
      console.log('anyrouter: restored session cookie');
    }
  }

  const page = await ctx.newPage();
  page.on('console', msg => console.log('[PAGE]', msg.text().substring(0, 200)));
  page.on('pageerror', err => console.log('[PAGE ERROR]', err.message));
  page.on('response', async resp => {
    if (resp.url().includes('api/user') || resp.url().includes('checkin')) {
      const status = resp.status();
      const contentType = resp.headers()['content-type'] || '';
      console.log(`[API] ${resp.url()} -> ${status} (${contentType.substring(0, 50)})`);
    }
  });

  try {
    console.log('anyrouter: navigating to main...');
    await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(8000);
    console.log('anyrouter after main:', page.url());

    let loggedIn = false;
    let checkinSuccess = false;

    console.log('anyrouter: navigating to /login...');
    await page.goto(BASE + '/login', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(5000);
    console.log('anyrouter login page URL:', page.url());

    loggedIn = await handleLogin(page, ctx, BASE, GH_USER, GH_PASS, browser);
    checkinSuccess = loggedIn ? await doCheckin(page, ctx, BASE) : false;
    await saveCtxCookies(ctx, BASE);
    await browser.close();
    console.log('anyrouter done, checkinSuccess:', checkinSuccess);
    return { success: true, checkinSuccess };
  } catch (e) {
    console.error('anyrouter error:', e.message);
    await browser.close();
    return { success: false, error: e.message };
  }
}

async function handleLogin(page, ctx, BASE, GH_USER, GH_PASS, browser) {
  let loggedIn = false;

  // 检查是否已有 session cookie
  const existingCookies = await ctx.cookies(BASE);
  const hasSession = existingCookies.some(c => c.name === 'session');
  console.log('anyrouter: has session cookie:', hasSession);

  if (hasSession) {
    console.log('anyrouter: session exists, trying console directly...');
    await page.goto(BASE + '/console', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(3000);
    loggedIn = !page.url().includes('login');
    console.log('anyrouter: logged in status:', loggedIn);
    if (loggedIn) return true;
  }

  // 查找 GitHub 按钮
  let githubBtn = page.locator('[aria-label="github_logo"]');
  if (await githubBtn.count() === 0) githubBtn = page.locator('text=Continue with GitHub');
  if (await githubBtn.count() === 0) githubBtn = page.locator('.semi-icon-github_logo');

  console.log('anyrouter: found GitHub button:', await githubBtn.count());

  if (await githubBtn.count() > 0) {
    console.log('anyrouter: clicking GitHub OAuth button...');

    // 尝试获取按钮的 href
    const btnInfo = await page.evaluate(() => {
      const btn = document.querySelector('[aria-label="github_logo"]') ||
                  document.querySelector('.semi-icon-github_logo');
      if (!btn) return null;

      let parent = btn.parentElement;
      while (parent) {
        if (parent.tagName === 'A' && parent.href && parent.href !== 'about:blank') {
          return { href: parent.href, type: 'link' };
        }
        parent = parent.parentElement;
      }

      return {
        onclick: btn.getAttribute('onclick'),
        className: btn.className,
        tagName: btn.tagName
      };
    });

    console.log('anyrouter: button info:', JSON.stringify(btnInfo).substring(0, 200));

    if (btnInfo && btnInfo.href && btnInfo.href.includes('github')) {
      console.log('anyrouter: navigating to:', btnInfo.href);
      await page.goto(btnInfo.href, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await sleep(3000);
    } else {
      await githubBtn.first().click({ force: true });
      await sleep(2000);
      if (!page.url().includes('github.com')) {
        console.log('anyrouter: click did not navigate, trying JS click...');
        await page.evaluate(() => {
          const btn = document.querySelector('[aria-label="github_logo"]') ||
                      document.querySelector('.semi-icon-github_logo');
          if (btn) btn.click();
        });
        await sleep(3000);
      }
    }

    console.log('anyrouter after click, URL:', page.url());

    if (page.url().includes('github.com')) {
      console.log('anyrouter: on GitHub page');
      if (page.url().includes('/login')) {
        console.log('anyrouter: on GitHub login page');
        await page.locator('input[name="login"]').first().fill(GH_USER);
        await page.locator('input[name="password"]').first().fill(GH_PASS);
        await page.locator('input[type="submit"]').first().click();
        await sleep(2000);
        if (page.url().includes('/login')) {
          console.log('anyrouter: 2FA required');
          await browser.close();
          return false;
        }
      }
      try {
        await page.waitForURL(u => u.toString().includes('authorize'), { timeout: 15000 });
        console.log('anyrouter: on authorize page');
        const authBtn = page.locator('button[type="submit"], .btn-primary, text=Authorize').first();
        if (await authBtn.count() > 0) await authBtn.click({ force: true });
      } catch (e) { console.log('anyrouter: did not reach authorize, URL:', page.url()); }
      await sleep(5000);
      loggedIn = !page.url().includes('login');
    } else {
      console.log('anyrouter: click did not navigate to GitHub');
    }
  } else {
    console.log('anyrouter: no GitHub button found, trying console page...');
    await page.goto(BASE + '/console', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(5000);
    loggedIn = !page.url().includes('login');
    console.log('anyrouter: logged in status:', loggedIn);
  }

  return loggedIn;
}

async function doCheckin(page, ctx, BASE) {
  let checkinSuccess = false;
  try {
    const result = await page.evaluate(async () => {
      const results = {};

      try {
        const resp1 = await fetch('/api/user/info', { method: 'GET', credentials: 'include' });
        const text1 = await resp1.text();
        try { results.before = JSON.parse(text1); }
        catch(e) { results.beforeText = text1.substring(0, 300); }
        results.beforeStatus = resp1.status;
      } catch(e) { results.beforeError = e.message; }

      try {
        const resp2 = await fetch('/api/user/checkin', { method: 'POST', credentials: 'include' });
        const text2 = await resp2.text();
        try { results.checkin = JSON.parse(text2); }
        catch(e) { results.checkinText = text2.substring(0, 300); }
        results.checkinStatus = resp2.status;
      } catch(e) { results.checkinError = e.message; }

      try {
        const resp3 = await fetch('/api/user/info', { method: 'GET', credentials: 'include' });
        const text3 = await resp3.text();
        try { results.after = JSON.parse(text3); }
        catch(e) { results.afterText = text3.substring(0, 300); }
        results.afterStatus = resp3.status;
      } catch(e) { results.afterError = e.message; }

      return results;
    });

    console.log('anyrouter result:', JSON.stringify(result).substring(0, 800));

    let beforeBalance = null;
    let afterBalance = null;

    if (result.before) {
      beforeBalance = result.before.data?.balance || result.before.data?.credits ||
                      result.before.balance || result.before.credits;
    }
    console.log('anyrouter: balance before checkin:', beforeBalance);

    if (result.after) {
      afterBalance = result.after.data?.balance || result.after.data?.credits ||
                     result.after.balance || result.after.credits;
    }
    console.log('anyrouter: balance after checkin:', afterBalance);

    if (result.checkin) {
      if (result.checkin.code === 200 || result.checkin.success === true ||
          (result.checkin.message && result.checkin.message.includes('成功'))) {
        checkinSuccess = true;
        console.log('anyrouter: checkin successful (API returned success)');
      }
    }
    if (beforeBalance !== null && afterBalance !== null) {
      const diff = afterBalance - beforeBalance;
      console.log('anyrouter: balance change:', diff);
      if (diff >= 25) {
        checkinSuccess = true;
        console.log('anyrouter: balance increased by', diff, '-> checkin successful!');
      }
    }

    if (!checkinSuccess) {
      console.log('anyrouter: before status:', result.beforeStatus, 'checkin status:', result.checkinStatus, 'after status:', result.afterStatus);
      console.log('anyrouter: checkin text:', (result.checkinText || '').substring(0, 200));
    }
  } catch(e) { console.log('anyrouter checkin error:', e.message); }

  return checkinSuccess;
}

async function saveCtxCookies(ctx, BASE) {
  const cookies = await ctx.cookies(BASE);
  if (cookies.length > 0) {
    const all = await loadCookies();
    all.anyrouter = cookies;
    await saveCookies(all);
    console.log('anyrouter cookies saved:', cookies.length);
  }
}

module.exports = { run };
