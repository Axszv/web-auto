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
    // 使用较短超时，因为页面可能已经加载
    await page.goto(githubOAuthUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(async (e) => {
      console.log('agentrouter: initial navigation timeout, trying again...');
      await page.goto(githubOAuthUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    });
    await sleep(2000);
    console.log('agentrouter GitHub OAuth URL:', page.url());

    let isLoggedIn = false;

    // 如果在 GitHub 登录页，自动登录
    if (page.url().includes('github.com/login')) {
      console.log('agentrouter: on GitHub login page, auto-login...');
      await page.locator('input[name="login"]').fill(GH_USER);
      await page.locator('input[name="password"]').fill(GH_PASS);
      await page.locator('input[type="submit"]').click();
      console.log('agentrouter: submitted login form, waiting for redirect...');
      // 等待页面跳转
      await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
      await sleep(3000);
      console.log('agentrouter after GitHub login:', page.url());
    }

    // 如果在 /session 页面，直接导航回 OAuth authorize 页面
    // 因为登录已成功，GitHub 应该会自动授权
    if (page.url().includes('github.com/session')) {
      console.log('agentrouter: on GitHub session page, navigating back to OAuth authorize...');
      await sleep(2000);
      const oauthUrl = `https://github.com/login/oauth/authorize?client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(BASE + '/oauth/github')}&scope=user:email`;
      await page.goto(oauthUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await sleep(3000);
      console.log('agentrouter after re-navigate:', page.url());
    }

    // 如果到了 authorize 页面，等待加载后点击授权
    if (page.url().includes('authorize')) {
      console.log('agentrouter: on authorize page, waiting for load...');
      await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
      await sleep(2000);
      console.log('agentrouter: clicking Authorize...');
      // 尝试多种方式点击授权按钮
      let authorized = false;
      // 方式 1: 使用 Playwright 点击
      const authBtn = page.locator('input[type="submit"], button[type="submit"]').first();
      if (await authBtn.count() > 0) {
        try {
          await authBtn.click();
          authorized = true;
          console.log('agentrouter: clicked Authorize via Playwright');
        } catch(e) {
          console.log('agentrouter: Playwright click failed:', e.message);
        }
      }
      // 方式 2: 使用 JavaScript 点击
      if (!authorized) {
        try {
          await page.evaluate(() => {
            const btn = document.querySelector('input[type="submit"], button[type="submit"]');
            if (btn) btn.click();
          });
          authorized = true;
          console.log('agentrouter: clicked Authorize via JavaScript');
        } catch(e) {
          console.log('agentrouter: JavaScript click failed:', e.message);
        }
      }
      if (authorized) {
        console.log('agentrouter: clicked Authorize, waiting for redirect...');
        // 等待页面跳转（带超时）
        let navCompleted = false;
        for (let i = 0; i < 20; i++) {
          await sleep(2000);
          const currentUrl = page.url();
          console.log('agentrouter waiting for redirect, current URL:', currentUrl);
          if (!currentUrl.includes('github.com') && !currentUrl.includes('oauth') && !currentUrl.includes('authorize')) {
            console.log('agentrouter: redirected successfully!');
            navCompleted = true;
            break;
          }
          // 如果回到了 authorize 页面，尝试重新点击
          if (currentUrl.includes('authorize') && i > 5) {
            console.log('agentrouter: still on authorize page, retrying...');
            try {
              await page.evaluate(() => {
                const btn = document.querySelector('input[type="submit"], button[type="submit"]');
                if (btn) btn.click();
              });
              await sleep(3000);
            } catch(e) {
              console.log('agentrouter: retry click failed:', e.message);
            }
          }
        }
        if (!navCompleted) {
          console.log('agentrouter: redirect timeout, current URL:', page.url());
        }
        await sleep(3000);
        console.log('agentrouter after Authorize click:', page.url());
      } else {
        console.log('agentrouter: no authorize button found, current URL:', page.url());
      }
    }

    // 等待 OAuth 回调（增加超时时间）
    console.log('agentrouter: waiting for OAuth callback...');
    for (let i = 0; i < 60; i++) {
      await sleep(2000);
      const url = page.url();
      console.log('agentrouter current URL:', url);
      if (!url.includes('github.com') && !url.includes('oauth') && !url.includes('authorize')) {
        console.log('agentrouter: OAuth callback detected! URL:', url);
        isLoggedIn = true;
        break;
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
