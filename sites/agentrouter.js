// sites/agentrouter.js — GitHub OAuth 登录
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
  const BASE = 'https://agentrouter.org';
  const PROXY = { server: 'http://127.0.0.1:1080' };
  const CLIENT_ID = 'Ov23lidtiR4LeVZvVRNL';

  console.log('agentrouter: launching chromium via proxy...');
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

  const page = await ctx.newPage();
  page.on('console', msg => console.log('[PAGE]', msg.text().substring(0, 200)));
  page.on('pageerror', err => console.log('[PAGE ERROR]', err.message));
  page.on('response', async resp => {
    if (resp.url().includes('api/') || resp.url().includes('oauth')) {
      console.log(`[API] ${resp.url()} -> ${resp.status()}`);
    }
  });

  try {
    // agentrouter 始终使用 GitHub OAuth 登录
    console.log('agentrouter: starting GitHub OAuth flow...');
    const githubOAuthUrl = `https://github.com/login/oauth/authorize?client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(BASE + '/oauth/github')}&scope=user:email`;
    await page.goto(githubOAuthUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(async (e) => {
      console.log('agentrouter: initial navigation timeout, trying again...');
      await page.goto(githubOAuthUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    });
    await sleep(2000);
    console.log('agentrouter GitHub OAuth URL:', page.url());

    let isLoggedIn = false;
    let loginAttempts = 0;
    const maxAttempts = 3;

    // 尝试最多 3 次登录
    while (loginAttempts < maxAttempts && !isLoggedIn) {
      loginAttempts++;
      console.log(`agentrouter: login attempt ${loginAttempts}/${maxAttempts}`);

      // 如果在 GitHub 登录页，自动登录
      if (page.url().includes('github.com/login') && !page.url().includes('oauth')) {
        console.log('agentrouter: on GitHub login page, auto-login...');
        await page.locator('input[name="login"]').fill(GH_USER).catch(() => {
          console.log('agentrouter: login field not found, trying email field...');
          page.locator('input[type="email"], input[name="username"]').first().fill(GH_USER);
        });
        await page.locator('input[name="password"]').fill(GH_PASS).catch(() => {
          console.log('agentrouter: password field not found');
        });
        await page.locator('input[type="submit"], button[type="submit"]').first().click().catch(() => {
          console.log('agentrouter: submit button not found, trying enter...');
          page.locator('input[name="password"]').press('Enter');
        });
        console.log('agentrouter: submitted login form, waiting for redirect...');
        await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
        await sleep(3000);
        console.log('agentrouter after GitHub login:', page.url());
      }

      // 如果在 /session 页面，直接导航回 OAuth authorize 页面
      if (page.url().includes('github.com/session')) {
        console.log('agentrouter: on GitHub session page, navigating back to OAuth authorize...');
        await sleep(2000);
        const oauthUrl = `https://github.com/login/oauth/authorize?client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(BASE + '/oauth/github')}&scope=user:email`;
        await page.goto(oauthUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await sleep(3000);
        console.log('agentrouter after re-navigate:', page.url());
      }

      // 如果到了 authorize 页面，点击授权
      if (page.url().includes('authorize')) {
        console.log('agentrouter: on authorize page, clicking Authorize...');
        await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
        await sleep(2000);

        // 使用 JavaScript 点击授权按钮
        try {
          await page.evaluate(() => {
            const btn = document.querySelector('input[value="Authorize"], input[type="submit"][value*="Authorize"], button:has-text("Authorize")');
            if (btn) btn.click();
          });
          console.log('agentrouter: clicked Authorize via JavaScript');
        } catch(e) {
          console.log('agentrouter: JS click failed, trying Playwright...');
          const authBtn = page.locator('input[type="submit"], button[type="submit"]').first();
          if (await authBtn.count() > 0) {
            await authBtn.click();
          }
        }

        // 等待 OAuth 回调
        console.log('agentrouter: waiting for OAuth callback...');
        for (let i = 0; i < 30; i++) {
          await sleep(2000);
          const url = page.url();
          console.log('agentrouter current URL:', url);
          if (!url.includes('github.com') && !url.includes('oauth') && !url.includes('authorize')) {
            console.log('agentrouter: OAuth callback detected! URL:', url);
            isLoggedIn = true;
            break;
          }
        }
      }

      // 如果还没有登录成功，重新导航到 OAuth URL
      if (!isLoggedIn && page.url().includes('github.com')) {
        console.log('agentrouter: not logged in yet, refreshing OAuth page...');
        await page.goto(githubOAuthUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await sleep(2000);
      }
    }

    if (isLoggedIn) {
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
