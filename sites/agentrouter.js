// sites/agentrouter.js — 优先直接访问，代理备用
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

  console.log('agentrouter: trying direct access...');
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
      await page.goto(BASE + '/login', { waitUntil: 'domcontentloaded', timeout: 60000 });
      await sleep(5000);
      console.log('agentrouter direct URL:', page.url());
      const loggedIn = await handleLogin(page, ctx, BASE, browser);
      const checkinSuccess = loggedIn ? await doCheckin(page, ctx, BASE) : false;
      await saveCtxCookies(ctx, BASE);
      await browser.close();
      console.log('agentrouter done, checkinSuccess:', checkinSuccess);
      return { success: true, checkinSuccess };
    } catch (e) {
      console.log('agentrouter direct failed:', e.message);
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
    console.log('agentrouter (proxy): navigating...');
    await page.goto(BASE + '/login', { waitUntil: 'domcontentloaded', timeout: 90000 });
    await sleep(5000);
    console.log('agentrouter (proxy) URL:', page.url());
    const loggedIn = await handleLogin(page, ctx, BASE, browser);
    const checkinSuccess = loggedIn ? await doCheckin(page, ctx, BASE) : false;
    await saveCtxCookies(ctx, BASE);
    await browser.close();
    console.log('agentrouter (proxy) done, checkinSuccess:', checkinSuccess);
    return { success: true, checkinSuccess };
  } catch (e) {
    console.error('agentrouter (proxy) error:', e.message);
    await browser.close();
    return { success: false, error: e.message };
  }
}

async function handleLogin(page, ctx, BASE, browser) {
  let loggedIn = false;

  // 获取页面完整信息
  const pageInfo = await page.evaluate(() => {
    const body = document.body.innerText;
    const buttons = Array.from(document.querySelectorAll('button, a, [role="button"]'))
      .map(el => ({
        text: el.innerText?.substring(0, 50),
        href: el.href,
        onclick: el.getAttribute('onclick'),
        className: el.className,
        ariaLabel: el.getAttribute('aria-label')
      }))
      .filter(b => b.text || b.href || b.onclick);

    const githubBtn = document.querySelector('[aria-label="github_logo"]') ||
                      document.querySelector('.semi-icon-github_logo') ||
                      document.querySelector('text=Continue with GitHub');

    return {
      bodyLength: body.length,
      bodyPreview: body.substring(0, 500),
      buttons: buttons.slice(0, 20),
      hasGithubBtn: !!githubBtn
    };
  });

  console.log('agentrouter: page body preview:', pageInfo.bodyPreview.substring(0, 200));
  console.log('agentrouter: has GitHub button:', pageInfo.hasGithubBtn);
  console.log('agentrouter: buttons:', JSON.stringify(pageInfo.buttons).substring(0, 500));

  // 查找 GitHub 按钮
  let githubBtn = page.locator('[aria-label="github_logo"]');
  if (await githubBtn.count() === 0) githubBtn = page.locator('text=Continue with GitHub');
  if (await githubBtn.count() === 0) githubBtn = page.locator('.semi-icon-github_logo');

  console.log('agentrouter: found GitHub button:', await githubBtn.count());

  if (await githubBtn.count() > 0) {
    console.log('agentrouter: clicking GitHub OAuth button...');

    // 尝试多种方式获取导航 URL
    const navUrl = await page.evaluate(() => {
      const btn = document.querySelector('[aria-label="github_logo"]') ||
                  document.querySelector('.semi-icon-github_logo');
      if (!btn) return null;

      // 检查所有父级 a 标签
      let parent = btn.parentElement;
      while (parent) {
        if (parent.tagName === 'A' && parent.href && parent.href !== 'about:blank') {
          return parent.href;
        }
        parent = parent.parentElement;
      }

      // 检查 onclick
      const onclick = btn.getAttribute('onclick') || btn.closest('[onclick]')?.getAttribute('onclick');
      if (onclick) return { onclick, type: 'onclick' };

      // 检查所有事件
      const all = getEventListeners ? getEventListeners(btn) : null;
      return { hasOnclick: !!onclick, className: btn.className };
    });

    console.log('agentrouter: nav URL info:', JSON.stringify(navUrl).substring(0, 300));

    if (navUrl && navUrl.href && navUrl.href.includes('github')) {
      console.log('agentrouter: navigating to:', navUrl.href);
      await page.goto(navUrl.href, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await sleep(3000);
    } else if (navUrl && navUrl.onclick) {
      console.log('agentrouter: onclick handler:', navUrl.onclick.substring(0, 200));
      // 执行 onclick
      await page.evaluate((onclick) => {
        const btn = document.querySelector('[aria-label="github_logo"]') ||
                    document.querySelector('.semi-icon-github_logo');
        if (btn) btn.onclick();
      }, navUrl.onclick);
      await sleep(3000);
    } else {
      await githubBtn.first().click({ force: true });
      await sleep(3000);
    }

    console.log('agentrouter after click, URL:', page.url());

    if (page.url().includes('github.com')) {
      console.log('agentrouter: on GitHub page');
      if (page.url().includes('/login')) {
        console.log('agentrouter: on GitHub login page');
        await page.locator('input[name="login"]').first().fill(process.env.GH_USER || '');
        await page.locator('input[name="password"]').first().fill(process.env.GH_PASS || '');
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
        if (await authBtn.count() > 0) await authBtn.click({ force: true });
      } catch (e) { console.log('agentrouter: did not reach authorize, URL:', page.url()); }
      await sleep(5000);
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

async function doCheckin(page, ctx, BASE) {
  let checkinSuccess = false;
  try {
    const cookies = await ctx.cookies(BASE);
    console.log('agentrouter: cookie count:', cookies.length);
    console.log('agentrouter: cookie names:', cookies.map(c => c.name).join(', '));

    // 通过 page.evaluate + fetch 执行所有 API 调用
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

    console.log('agentrouter result:', JSON.stringify(result).substring(0, 800));

    let beforeBalance = null;
    let afterBalance = null;

    if (result.before) {
      beforeBalance = result.before.data?.balance || result.before.data?.credits ||
                      result.before.balance || result.before.credits;
    }
    console.log('agentrouter: balance before checkin:', beforeBalance);

    if (result.after) {
      afterBalance = result.after.data?.balance || result.after.data?.credits ||
                     result.after.balance || result.after.credits;
    }
    console.log('agentrouter: balance after checkin:', afterBalance);

    if (result.checkin) {
      if (result.checkin.code === 200 || result.checkin.success === true ||
          (result.checkin.message && result.checkin.message.includes('成功'))) {
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

    if (!checkinSuccess) {
      const checkinText = result.checkinText || '';
      const beforeText = result.beforeText || '';
      const afterText = result.afterText || '';
      console.log('agentrouter: checkin text:', checkinText.substring(0, 200));
      console.log('agentrouter: before text:', beforeText.substring(0, 200));
      console.log('agentrouter: after text:', afterText.substring(0, 200));
      console.log('agentrouter: before status:', result.beforeStatus, 'checkin status:', result.checkinStatus, 'after status:', result.afterStatus);
    }
  } catch(e) { console.log('agentrouter checkin error:', e.message); }

  return checkinSuccess;
}

async function saveCtxCookies(ctx, BASE) {
  const cookies = await ctx.cookies(BASE);
  if (cookies.length > 0) {
    const all = await loadCookies();
    all.agentrouter = cookies;
    await saveCookies(all);
    console.log('agentrouter cookies saved:', cookies.length);
  }
}

module.exports = { run };
