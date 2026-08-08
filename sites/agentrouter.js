// sites/agentrouter.js — 尝试多种方式获取 OAuth URL
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
  const BASE = 'https://agentrouter.org';
  const PROXY = { server: 'http://127.0.0.1:1080' };

  console.log('agentrouter: launching chromium via proxy...');
  const browser = await chromium.launch({
    headless: false,
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
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

  const existingCookies = await loadCookies();
  if (existingCookies.agentrouter && existingCookies.agentrouter.length > 0) {
    await ctx.addCookies(existingCookies.agentrouter);
    console.log('agentrouter: restored existing cookies');
  }

  const page = await ctx.newPage();
  page.on('console', msg => console.log('[PAGE]', msg.text().substring(0, 200)));
  page.on('pageerror', err => console.log('[PAGE ERROR]', err.message));
  page.on('response', async resp => {
    if (resp.url().includes('api/') || resp.url().includes('oauth')) {
      console.log(`[API] ${resp.url()} -> ${resp.status()} (${resp.headers()['content-type'] || 'unknown'})`);
    }
  });

  try {
    console.log('agentrouter: navigating to /login via proxy...');
    await page.goto(BASE + '/login', { waitUntil: 'domcontentloaded', timeout: 90000 });
    await sleep(5000);
    console.log('agentrouter URL:', page.url());

    // 尝试多种方式获取 OAuth URL
    console.log('agentrouter: trying to get OAuth URL...');
    const oauthInfo = await page.evaluate(async () => {
      const results = {};

      // 方法1: 获取按钮信息
      const btn = document.querySelector('[aria-label="github_logo"]') ||
                  document.querySelector('.semi-icon-github_logo') ||
                  document.querySelector('text=Continue with GitHub');
      if (btn) {
        results.foundBtn = true;
        results.btnClassName = btn.className;
        results.btnTagName = btn.tagName;
        // 检查所有父级 a 标签
        let parent = btn.parentElement;
        while (parent) {
          if (parent.tagName === 'A' && parent.href && parent.href !== 'about:blank') {
            results.href = parent.href;
            break;
          }
          parent = parent.parentElement;
        }
        // 检查 onclick
        results.onclick = btn.getAttribute('onclick');
      }

      // 方法2: 尝试 API
      try {
        const resp = await fetch('/api/oauth/state?mode=login', { credentials: 'include' });
        if (resp.ok) {
          const data = await resp.json();
          results.oauthState = data;
        }
      } catch(e) {}

      return results;
    });

    console.log('agentrouter: oauth info:', JSON.stringify(oauthInfo).substring(0, 500));

    let loggedIn = false;

    if (oauthInfo.href && oauthInfo.href.includes('github')) {
      console.log('agentrouter: navigating to:', oauthInfo.href);
      await page.goto(oauthInfo.href, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await sleep(3000);
    } else if (oauthInfo.oauthState && oauthInfo.oauthState.state) {
      // 构造 GitHub OAuth URL
      const githubUrl = `https://github.com/login/oauth/authorize?client_id=Ov23liwqF4o0LXkK2yGg&state=${oauthInfo.oauthState.state}`;
      console.log('agentrouter: navigating to GitHub OAuth:', githubUrl);
      await page.goto(githubUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await sleep(3000);
    }

    if (page.url().includes('github.com')) {
      console.log('agentrouter: on GitHub page');
      if (page.url().includes('/login')) {
        await page.locator('input[name="login"]').first().fill(GH_USER);
        await page.locator('input[name="password"]').first().fill(GH_PASS);
        await page.locator('input[type="submit"]').first().click();
        await sleep(2000);
        if (!page.url().includes('/login')) {
          try {
            await page.waitForURL(u => u.toString().includes('authorize'), { timeout: 15000 });
            const authBtn = page.locator('button[type="submit"], .btn-primary, text=Authorize').first();
            if (await authBtn.count() > 0) await authBtn.click({ force: true });
          } catch(e) {}
          await sleep(5000);
          loggedIn = !page.url().includes('login');
        }
      }
    }

    if (!loggedIn && oauthInfo.foundBtn) {
      console.log('agentrouter: clicking button via JS...');
      await page.evaluate(() => {
        const btn = document.querySelector('[aria-label="github_logo"]') ||
                    document.querySelector('.semi-icon-github_logo');
        if (btn) btn.click();
      });
      await sleep(5000);
      console.log('agentrouter: after JS click, URL:', page.url());
      if (page.url().includes('github.com')) {
        loggedIn = true;
      }
    }

    if (loggedIn || page.url().includes('github.com')) {
      if (page.url().includes('github.com') && page.url().includes('authorize')) {
        const authBtn = page.locator('button[type="submit"], .btn-primary, text=Authorize').first();
        if (await authBtn.count() > 0) await authBtn.click({ force: true });
        await sleep(5000);
        loggedIn = !page.url().includes('login');
      }
    }

    if (loggedIn) {
      console.log('agentrouter: logged in!');
      const checkinSuccess = await doCheckin(page, ctx, BASE);
      await saveCtxCookies(ctx, BASE);
      await browser.close();
      console.log('agentrouter done, checkinSuccess:', checkinSuccess);
      return { success: true, checkinSuccess };
    }

    await saveCtxCookies(ctx, BASE);
    await browser.close();
    console.log('agentrouter done, checkinSuccess: false');
    return { success: true, checkinSuccess: false };
  } catch (e) {
    console.error('agentrouter error:', e.message);
    await browser.close();
    return { success: false, error: e.message };
  }
}

async function doCheckin(page, ctx, BASE) {
  let checkinSuccess = false;
  try {
    const result = await page.evaluate(async () => {
      const results = {};
      try {
        const r1 = await fetch('/api/user/info', { credentials: 'include' });
        const t1 = await r1.text();
        try { results.before = JSON.parse(t1); } catch(e) { results.beforeText = t1.substring(0, 200); }
        results.beforeStatus = r1.status;
      } catch(e) { results.beforeError = e.message; }
      try {
        const r2 = await fetch('/api/user/checkin', { method: 'POST', credentials: 'include' });
        const t2 = await r2.text();
        try { results.checkin = JSON.parse(t2); } catch(e) { results.checkinText = t2.substring(0, 200); }
        results.checkinStatus = r2.status;
      } catch(e) { results.checkinError = e.message; }
      try {
        const r3 = await fetch('/api/user/info', { credentials: 'include' });
        const t3 = await r3.text();
        try { results.after = JSON.parse(t3); } catch(e) { results.afterText = t3.substring(0, 200); }
        results.afterStatus = r3.status;
      } catch(e) { results.afterError = e.message; }
      return results;
    });

    console.log('agentrouter: checkin result:', JSON.stringify(result).substring(0, 600));

    let beforeBalance = result.before?.data?.balance || result.before?.balance;
    let afterBalance = result.after?.data?.balance || result.after?.balance;
    console.log('agentrouter: balance before:', beforeBalance, 'after:', afterBalance);

    if (result.checkin && (result.checkin.code === 200 || result.checkin.success)) {
      checkinSuccess = true;
    }
    if (beforeBalance !== null && afterBalance !== null && afterBalance - beforeBalance >= 25) {
      checkinSuccess = true;
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
