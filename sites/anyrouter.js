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
  // GitHub 账号登录
  const GH_USER = config.GH_USER || process.env.GH_USER || '504740633@qq.com';
  const GH_PASS = config.GH_PASS || process.env.GH_PASS || 'Lz37265981^';
  const BASE = 'https://anyrouter.top';
  const PROXY = { server: 'http://127.0.0.1:1080' };

  console.log('anyrouter: launching chromium via proxy...');
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
    proxy: PROXY
  });

  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
    locale: 'en-US'
  });

  const existingCookies = await loadCookies();
  if (existingCookies.anyrouter && existingCookies.anyrouter.length > 0) {
    await ctx.addCookies(existingCookies.anyrouter);
    console.log('anyrouter: restored existing cookies');
  }

  const page = await ctx.newPage();
  page.on('console', msg => console.log('[PAGE]', msg.text().substring(0, 200)));
  page.on('pageerror', err => console.log('[PAGE ERROR]', err.message));
  page.on('response', async resp => {
    if (resp.url().includes('api/') || resp.url().includes('oauth')) {
      console.log(`[API] ${resp.url()} -> ${resp.status()}`);
    }
  });

  try {
    console.log('anyrouter: Step 1 - navigating to homepage...');
    await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(3000);
    console.log('URL:', page.url());

    // Step 2: 关闭弹窗
    console.log('anyrouter: Step 2 - closing popup...');
    try {
      const closeBtn = page.locator('button[aria-label="close"]').first();
      if (await closeBtn.count() > 0) {
        await closeBtn.click();
        await sleep(1000);
        console.log('Popup closed');
      }
    } catch(e) {
      console.log('No popup to close');
    }

    // Step 3: 点击登录按钮
    console.log('anyrouter: Step 3 - clicking login button...');
    const loginBtn = page.locator('button:has-text("登录")').first();
    console.log('Login button count:', await loginBtn.count());
    if (await loginBtn.count() > 0) {
      await loginBtn.click();
      await sleep(2000);
      console.log('After login click, URL:', page.url());
    }

    // 检查是否已登录
    let isLoggedIn = await page.evaluate(() => window.location.href.indexOf('login') < 0);
    if (isLoggedIn) {
      console.log('anyrouter: already logged in');
    } else {
      // Step 4: 点击【使用 GitHub 继续】
      console.log('anyrouter: Step 4 - clicking GitHub button...');
      const githubBtn = page.locator('button').filter({ hasText: 'GitHub' }).first();
      console.log('GitHub button count:', await githubBtn.count());
      if (await githubBtn.count() > 0) {
        await githubBtn.click({ force: true });
        await sleep(3000);
        console.log('After GitHub click, URL:', page.url());
      }

      // Step 5: GitHub 自动登录
      if (page.url().includes('github.com/login')) {
        console.log('anyrouter: Step 5 - GitHub auto-login...');
        await page.locator('input[name="login"]').first().fill(GH_USER);
        await page.locator('input[name="password"]').first().fill(GH_PASS);
        await page.locator('input[type="submit"]').first().click();
        await sleep(3000);
        console.log('After GitHub login, URL:', page.url());

        // 如果需要 authorize
        if (page.url().includes('authorize')) {
          const authBtn = page.locator('button[type="submit"], .btn-primary, text=Authorize').first();
          if (await authBtn.count() > 0) {
            await authBtn.click({ force: true });
            await sleep(3000);
          }
        }
      }

      // 等待 OAuth 回调
      console.log('anyrouter: waiting for OAuth callback...');
      isLoggedIn = false;
      for (let i = 0; i < 30; i++) {
        await sleep(2000);
        const url = page.url();
        if (!url.includes('github.com') && !url.includes('oauth') && !url.includes('authorize')) {
          console.log('anyrouter: OAuth callback detected! URL:', url);
          isLoggedIn = true;
          break;
        }
      }
    }

    if (isLoggedIn) {
      console.log('anyrouter: logged in!');
      const checkinSuccess = await doCheckin(page, ctx, BASE);
      await saveCtxCookies(ctx, BASE);
      await browser.close();
      console.log('anyrouter done, checkinSuccess:', checkinSuccess);
      return { success: true, checkinSuccess };
    }

    await saveCtxCookies(ctx, BASE);
    await browser.close();
    console.log('anyrouter done, checkinSuccess: false');
    return { success: true, checkinSuccess: false };
  } catch (e) {
    console.error('anyrouter error:', e.message);
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

    console.log('anyrouter: checkin result:', JSON.stringify(result).substring(0, 600));

    let beforeBalance = result.before?.data?.balance || result.before?.balance;
    let afterBalance = result.after?.data?.balance || result.after?.balance;
    console.log('anyrouter: balance before:', beforeBalance, 'after:', afterBalance);

    if (result.checkin && (result.checkin.code === 200 || result.checkin.success)) {
      checkinSuccess = true;
    }
    if (beforeBalance !== null && afterBalance !== null && afterBalance - beforeBalance >= 25) {
      checkinSuccess = true;
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
