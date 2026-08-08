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

  // 先尝试直接访问
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

  // 查找 GitHub 按钮
  let githubBtn = page.locator('[aria-label="github_logo"]');
  if (await githubBtn.count() === 0) githubBtn = page.locator('text=Continue with GitHub');
  if (await githubBtn.count() === 0) githubBtn = page.locator('.semi-icon-github_logo');

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
    // 获取 cookies 和 headers
    const cookies = await ctx.cookies(BASE);
    const cookieStr = cookies.map(c => c.name + '=' + c.value).join('; ');
    console.log('agentrouter: cookie count:', cookies.length);
    console.log('agentrouter: cookie names:', cookies.map(c => c.name).join(', '));

    // 方法1: 通过 page.evaluate + fetch
    let beforeBalance = null;
    try {
      const result = await page.evaluate(async () => {
        try {
          const resp = await fetch('/api/user/info', { method: 'GET', credentials: 'include' });
          const text = await resp.text();
          try { return { ok: resp.ok, status: resp.status, data: JSON.parse(text) }; }
          catch(e) { return { ok: resp.ok, status: resp.status, text: text.substring(0, 200) }; }
        } catch(e) { return { error: e.message }; }
      });
      console.log('agentrouter info (eval):', JSON.stringify(result).substring(0, 300));
      if (result.data) {
        beforeBalance = result.data?.balance || result.data?.credits || result.balance || result.credits;
        console.log('agentrouter: balance before checkin:', beforeBalance);
      }
    } catch(e) { console.log('agentrouter: failed to get before balance via eval:', e.message); }

    // 执行签到
    const checkinResult = await page.evaluate(async () => {
      try {
        const r = await fetch('/api/user/checkin', { method: 'POST', credentials: 'include' });
        const text = await r.text();
        try { return { status: r.status, ok: r.ok, data: JSON.parse(text) }; }
        catch(e) { return { status: r.status, ok: r.ok, text: text.substring(0, 200) }; }
      } catch(e) { return { error: e.message }; }
    });
    console.log('agentrouter checkin (eval):', JSON.stringify(checkinResult).substring(0, 300));

    // 方法2: 通过 page.request
    try {
      const resp = await page.request.post(BASE + '/api/user/checkin', {
        headers: { 'Cookie': cookieStr, 'Accept': 'application/json' }
      });
      console.log('agentrouter checkin status:', resp.status());
      if (resp.ok()) {
        const text = await resp.text();
        try {
          const json = JSON.parse(text);
          console.log('agentrouter checkin result:', JSON.stringify(json));
        } catch(e) {
          console.log('agentrouter checkin response (not JSON):', text.substring(0, 200));
        }
      }
    } catch(e) { console.log('agentrouter checkin request error:', e.message); }

    // 获取签到后余额
    let afterBalance = null;
    try {
      const result2 = await page.evaluate(async () => {
        try {
          const resp = await fetch('/api/user/info', { method: 'GET', credentials: 'include' });
          const text = await resp.text();
          try { return { ok: resp.ok, data: JSON.parse(text) }; }
          catch(e) { return { ok: resp.ok, text: text.substring(0, 200) }; }
        } catch(e) { return { error: e.message }; }
      });
      console.log('agentrouter info after (eval):', JSON.stringify(result2).substring(0, 300));
      if (result2.data) {
        afterBalance = result2.data?.balance || result2.data?.credits || result2.balance || result2.credits;
        console.log('agentrouter: balance after checkin:', afterBalance);
      }
    } catch(e) { console.log('agentrouter: failed to get after balance:', e.message); }

    // 判断签到成功
    if (checkinResult && checkinResult.data) {
      if (checkinResult.data.code === 200 || checkinResult.data.success === true) {
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
