// sites/anyrouter.js — GitHub OAuth 登录
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
  const GH_USER = config.GH_USER || process.env.GH_USER || '504740633@qq.com';
  const GH_PASS = config.GH_PASS || process.env.GH_PASS || 'Lz37265981^';
  const BASE = 'https://anyrouter.top';
  const PROXY = { server: 'http://127.0.0.1:1080' };
  const CLIENT_ID = 'Ov23liwqF4o0LXkK2yGg';

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
    // 先用现有 cookies 尝试访问
    console.log('anyrouter: trying with existing cookies first...');
    await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(async (e) => {
      console.log('anyrouter: initial navigation timeout, trying again...');
      await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 20000 });
    });
    await sleep(2000);
    const currentUrl = page.url();
    console.log('anyrouter current URL:', currentUrl);

    // 检查是否已登录（不在登录页）
    let isLoggedIn = !currentUrl.includes('login') && !currentUrl.includes('github.com');
    console.log('anyrouter logged in with cookies:', isLoggedIn);

    // 如果 cookies 无效，进行 OAuth 登录
    if (!isLoggedIn) {
      console.log('anyrouter: cookies invalid, starting OAuth flow...');
      const githubOAuthUrl = `https://github.com/login/oauth/authorize?client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(BASE + '/oauth/github')}&scope=user:email`;
      await page.goto(githubOAuthUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await sleep(2000);
      console.log('anyrouter GitHub OAuth URL:', page.url());

      // 如果在 GitHub 登录页，自动登录
      if (page.url().includes('github.com/login')) {
        console.log('anyrouter: on GitHub login page, auto-login...');
        await page.locator('input[name="login"]').fill(GH_USER);
        await page.locator('input[name="password"]').fill(GH_PASS);
        await page.locator('input[type="submit"]').click();
        await sleep(5000);
        console.log('anyrouter after GitHub login:', page.url());
      }

      // 如果在 /session 页面，直接导航回 OAuth authorize 页面
      // 因为登录已成功，GitHub 应该会自动授权
      if (page.url().includes('github.com/session')) {
        console.log('anyrouter: on GitHub session page, navigating back to OAuth authorize...');
        await sleep(2000);
        const oauthUrl = `https://github.com/login/oauth/authorize?client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(BASE + '/oauth/github')}&scope=user:email`;
        await page.goto(oauthUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await sleep(3000);
        console.log('anyrouter after re-navigate:', page.url());
      }

      // 如果到了 authorize 页面，点击授权
      if (page.url().includes('authorize')) {
        console.log('anyrouter: on authorize page, clicking Authorize...');
        await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
        await sleep(2000);

        // 监听页面导航事件，捕获 OAuth 回调
        let oauthCallbackUrl = null;
        page.once('url', (url) => {
          if (url.includes('anyrouter.top')) {
            oauthCallbackUrl = url;
            console.log('anyrouter: OAuth callback intercepted!', url);
          }
        });

        // 使用 JavaScript 点击授权按钮
        try {
          await page.evaluate(() => {
            const selectors = [
              'input[value="Authorize"]',
              'input[type="submit"][value*="Authorize"]',
              'button:has-text("Authorize")',
              'button[type="submit"]'
            ];
            for (const sel of selectors) {
              const btn = document.querySelector(sel);
              if (btn) {
                btn.click();
                return;
              }
            }
            const allBtns = document.querySelectorAll('input[type="submit"], button[type="submit"]');
            if (allBtns.length > 0) allBtns[0].click();
          });
          console.log('anyrouter: clicked Authorize via JavaScript');
        } catch(e) {
          console.log('anyrouter: JS click failed:', e.message);
          const authBtn = page.locator('input[type="submit"], button[type="submit"]').first();
          if (await authBtn.count() > 0) {
            await authBtn.click();
          }
        }

        // 等待 OAuth 回调（最多 60 秒）
        console.log('anyrouter: waiting for OAuth callback...');
        for (let i = 0; i < 60; i++) {
          await sleep(1000);
          const url = page.url();
          if (oauthCallbackUrl) {
            console.log('anyrouter: OAuth callback detected via listener!');
            oauthLoggedIn = true;
            isLoggedIn = true;
            break;
          }
          if (!url.includes('github.com') && !url.includes('oauth') && !url.includes('authorize')) {
            console.log('anyrouter: OAuth callback detected! URL:', url);
            oauthLoggedIn = true;
            isLoggedIn = true;
            break;
          }
          if (i % 10 === 0) {
            console.log('anyrouter: still waiting... URL:', url.substring(0, 80));
          }
        }
      }

      // 等待 OAuth 回调（增加超时时间）
      console.log('anyrouter: waiting for OAuth callback...');
      for (let i = 0; i < 60; i++) {
        await sleep(2000);
        const url = page.url();
        console.log('anyrouter current URL:', url);
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
        const r2 = await fetch('/checkin', { method: 'POST', credentials: 'include' });
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
