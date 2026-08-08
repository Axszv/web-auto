// sites/anyrouter.js — 优先直接访问，代理备用
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
  const BASE = 'https://anyrouter.top';

  // 先尝试直接访问
  console.log('anyrouter: trying direct access...');
  try {
    const browser = await firefox.launch({ headless: false, args: ['--no-sandbox'] });
    const ctx = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 800 }, locale: 'en-US'
    });
    await ctx.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
      Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
    });
    await ctx.clearCookies();
    const page = await ctx.newPage();
    page.on('console', msg => console.log('[PAGE]', msg.text().substring(0, 200)));
    page.on('pageerror', err => console.log('[PAGE ERROR]', err.message));

    try {
      await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 60000 });
      await sleep(8000);
      console.log('anyrouter after main:', page.url());

      let loggedIn = false;
      let checkinSuccess = false;

      console.log('anyrouter: navigating to /login...');
      await page.goto(BASE + '/login', { waitUntil: 'domcontentloaded', timeout: 60000 });
      await sleep(5000);
      console.log('anyrouter login page URL:', page.url());

      loggedIn = await handleLogin(page, ctx, BASE, browser);
      checkinSuccess = loggedIn ? await doCheckin(page, ctx, BASE) : false;
      await saveCtxCookies(ctx, BASE);
      await browser.close();
      console.log('anyrouter done, checkinSuccess:', checkinSuccess);
      return { success: true, checkinSuccess };
    } catch (e) {
      console.log('anyrouter direct failed:', e.message);
      await browser.close();
      throw e;
    }
  } catch (e) {
    console.log('anyrouter: direct failed, trying proxy...');
    return await runWithProxy(config);
  }
}

async function runWithProxy(config) {
  const GH_USER = config.GH_USER || process.env.GH_USER || '';
  const GH_PASS = config.GH_PASS || process.env.GH_PASS || '';
  const BASE = 'https://anyrouter.top';
  const PROXY = { server: 'http://127.0.0.1:1080' };

  const browser = await firefox.launch({ headless: false, args: ['--no-sandbox'], proxy: PROXY });
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 }, locale: 'en-US'
  });
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
  });
  await ctx.clearCookies();
  const page = await ctx.newPage();
  page.on('console', msg => console.log('[PAGE]', msg.text().substring(0, 200)));
  page.on('pageerror', err => console.log('[PAGE ERROR]', err.message));

  try {
    console.log('anyrouter (proxy): starting via proxy...');
    await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(8000);
    console.log('anyrouter (proxy) after main:', page.url());

    let loggedIn = false;
    let checkinSuccess = false;

    console.log('anyrouter (proxy): navigating to /login...');
    await page.goto(BASE + '/login', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(5000);
    console.log('anyrouter (proxy) login page URL:', page.url());

    loggedIn = await handleLogin(page, ctx, BASE, browser);
    checkinSuccess = loggedIn ? await doCheckin(page, ctx, BASE) : false;
    await saveCtxCookies(ctx, BASE);
    await browser.close();
    console.log('anyrouter (proxy) done, checkinSuccess:', checkinSuccess);
    return { success: true, checkinSuccess };
  } catch (e) {
    console.error('anyrouter (proxy) error:', e.message);
    await browser.close();
    return { success: false, error: e.message };
  }
}

async function handleLogin(page, ctx, BASE, browser) {
  let loggedIn = false;

  // 查找 GitHub 按钮
  let githubBtn = page.locator('[aria-label="github_logo"]');
  if (await githubBtn.count() === 0) githubBtn = page.locator('text=Continue with GitHub');
  if (await githubBtn.count() === 0) githubBtn = page.locator('.semi-icon-github_logo');

  console.log('anyrouter: found GitHub button:', await githubBtn.count());

  if (await githubBtn.count() > 0) {
    console.log('anyrouter: clicking GitHub OAuth button...');

    // 先尝试通过 API 获取 OAuth URL
    console.log('anyrouter: trying to get OAuth URL via API...');
    const authUrl = await page.evaluate(async () => {
      try {
        // 尝试 /api/auth/github
        const resp1 = await fetch('/api/auth/github', { method: 'GET', credentials: 'include' });
        if (resp1.ok) {
          const data = await resp1.json();
          if (data.url || data.redirect) return data.url || data.redirect;
        }
      } catch(e) {}
      try {
        // 尝试 /api/github/login
        const resp2 = await fetch('/api/github/login', { method: 'GET', credentials: 'include' });
        if (resp2.ok) {
          const data = await resp2.json();
          if (data.url || data.redirect) return data.url || data.redirect;
        }
      } catch(e) {}
      try {
        // 尝试 /api/authorize/github
        const resp3 = await fetch('/api/authorize/github', { method: 'GET', credentials: 'include' });
        if (resp3.ok) {
          const data = await resp3.json();
          if (data.url || data.redirect) return data.url || data.redirect;
        }
      } catch(e) {}
      return null;
    });

    if (authUrl) {
      console.log('anyrouter: got OAuth URL from API:', authUrl);
      await page.goto(authUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await sleep(3000);
    } else {
      // 尝试获取按钮的 href
      const btnHref = await page.evaluate(() => {
        const btn = document.querySelector('[aria-label="github_logo"]') ||
                    document.querySelector('.semi-icon-github_logo');
        if (!btn) return null;
        let a = btn.closest('a');
        if (a && a.href && a.href !== 'about:blank') return a.href;
        return null;
      });

      if (btnHref && btnHref.includes('github')) {
        console.log('anyrouter: navigating to:', btnHref);
        await page.goto(btnHref, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await sleep(3000);
      } else {
        // 点击按钮
        await githubBtn.first().click({ force: true });
        await sleep(2000);
        if (!page.url().includes('github.com')) {
          console.log('anyrouter: click did not navigate, trying JS click...');
          await page.evaluate(() => {
            const btn = document.querySelector('[aria-label="github_logo"]') ||
                        document.querySelector('.semi-icon-github_logo');
            if (btn) {
              btn.click();
            }
          });
          await sleep(3000);
        }
      }
    }

    console.log('anyrouter after click, URL:', page.url());

    if (page.url().includes('github.com')) {
      console.log('anyrouter: on GitHub page');
      if (page.url().includes('/login')) {
        console.log('anyrouter: on GitHub login page');
        await page.locator('input[name="login"]').first().fill(process.env.GH_USER || '');
        await page.locator('input[name="password"]').first().fill(process.env.GH_PASS || '');
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
      console.log('anyrouter: final URL:', page.url());
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
    // 通过 page.evaluate + fetch 执行所有 API 调用
    const result = await page.evaluate(async () => {
      const results = {};

      // Get before balance
      try {
        const resp1 = await fetch('/api/user/info', { method: 'GET', credentials: 'include' });
        const text1 = await resp1.text();
        try { results.before = JSON.parse(text1); }
        catch(e) { results.beforeText = text1.substring(0, 300); }
        results.beforeStatus = resp1.status;
      } catch(e) { results.beforeError = e.message; }

      // Checkin
      try {
        const resp2 = await fetch('/api/user/checkin', { method: 'POST', credentials: 'include' });
        const text2 = await resp2.text();
        try { results.checkin = JSON.parse(text2); }
        catch(e) { results.checkinText = text2.substring(0, 300); }
        results.checkinStatus = resp2.status;
      } catch(e) { results.checkinError = e.message; }

      // Get after balance
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

    // 提取余额
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

    // 判断签到成功
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

    // 如果 API 返回 HTML，检查是否有成功标志
    if (!checkinSuccess) {
      const checkinText = result.checkinText || '';
      const beforeText = result.beforeText || '';
      const afterText = result.afterText || '';
      console.log('anyrouter: checkin text:', checkinText.substring(0, 200));
      console.log('anyrouter: before text:', beforeText.substring(0, 200));
      console.log('anyrouter: after text:', afterText.substring(0, 200));

      if (checkinText.includes('签到成功') || checkinText.includes('success') ||
          beforeText.includes('签到成功') || afterText.includes('签到成功')) {
        checkinSuccess = true;
      }
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
