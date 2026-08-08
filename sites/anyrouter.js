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

  // 获取页面完整信息
  const pageInfo = await page.evaluate(() => {
    const githubBtn = document.querySelector('[aria-label="github_logo"]') ||
                      document.querySelector('.semi-icon-github_logo');
    if (!githubBtn) return { found: false };

    // 检查所有父级 a 标签
    let parent = githubBtn.parentElement;
    let href = null;
    while (parent) {
      if (parent.tagName === 'A' && parent.href && parent.href !== 'about:blank') {
        href = parent.href;
        break;
      }
      parent = parent.parentElement;
    }

    return {
      found: true,
      href,
      onclick: githubBtn.getAttribute('onclick'),
      className: githubBtn.className,
      tagName: githubBtn.tagName
    };
  });

  console.log('anyrouter: page info:', JSON.stringify(pageInfo).substring(0, 300));

  // 查找 GitHub 按钮
  let githubBtn = page.locator('[aria-label="github_logo"]');
  if (await githubBtn.count() === 0) githubBtn = page.locator('text=Continue with GitHub');
  if (await githubBtn.count() === 0) githubBtn = page.locator('.semi-icon-github_logo');

  console.log('anyrouter: found GitHub button:', await githubBtn.count());

  if (await githubBtn.count() > 0) {
    console.log('anyrouter: clicking GitHub OAuth button...');

    if (pageInfo.href && pageInfo.href.includes('github')) {
      console.log('anyrouter: navigating to:', pageInfo.href);
      await page.goto(pageInfo.href, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await sleep(3000);
    } else if (pageInfo.onclick) {
      console.log('anyrouter: executing onclick:', pageInfo.onclick.substring(0, 200));
      await page.evaluate((onclick) => {
        const btn = document.querySelector('[aria-label="github_logo"]') ||
                    document.querySelector('.semi-icon-github_logo');
        if (btn && btn.onclick) btn.onclick();
      }, pageInfo.onclick);
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
      console.log('anyrouter: checkin text:', (result.checkinText || '').substring(0, 200));
      console.log('anyrouter: before text:', (result.beforeText || '').substring(0, 200));
      console.log('anyrouter: after text:', (result.afterText || '').substring(0, 200));
      console.log('anyrouter: before status:', result.beforeStatus, 'checkin status:', result.checkinStatus, 'after status:', result.afterStatus);
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
