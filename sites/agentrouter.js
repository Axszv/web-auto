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
  const isHeadless = !process.env.DISPLAY;
  console.log('agentrouter: headless mode:', isHeadless);
  const browser = await chromium.launch({
    headless: isHeadless,
    args: [
      '--no-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-dev-shm-usage',
      '--disable-extensions',
      '--disable-gpu',
      '--no-first-run',
      '--no-zygote',
      '--single-process'
    ],
    proxy: PROXY
  });

  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 },
    locale: 'en-US',
    timezoneId: 'America/New_York',
    permissions: ['geolocation'],
    deviceScaleFactor: 1,
    hasTouch: false,
    isMobile: false
  });

  // 注入脚本隐藏 automation 特征
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    window.chrome = { runtime: {} };
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    window.navigator.connection = { effectiveType: '4g', rtt: 50, downlink: 10 };
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
    // agentrouter 尝试使用现有 cookies
    console.log('agentrouter: trying with existing cookies...');
    await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
    await sleep(2000);
    const currentUrl = page.url();
    console.log('agentrouter current URL:', currentUrl);

    // 检查是否已登录 - 不仅检查 URL，还要检查 API 是否可访问
    let isLoggedIn = !currentUrl.includes('login') && !currentUrl.includes('github.com');
    console.log('agentrouter logged in with cookies:', isLoggedIn, 'URL:', currentUrl);

    // 验证 cookies 是否有效
    if (isLoggedIn) {
      const apiCheck = await page.evaluate(async () => {
        try {
          const r = await fetch('/api/user/info', { credentials: 'include' });
          return { status: r.status, ok: r.ok };
        } catch(e) {
          return { error: e.message };
        }
      });
      console.log('agentrouter API check:', JSON.stringify(apiCheck));
      if (apiCheck.status === 401 || !apiCheck.ok) {
        isLoggedIn = false;
        console.log('agentrouter: cookies expired (status=' + apiCheck.status + '), will try OAuth');
      }
    }

    if (!isLoggedIn) {
      console.log('agentrouter: cookies invalid, attempting OAuth...');
      // OAuth 流程保持不变，但最多尝试 2 次
      let oauthSuccess = false;

      for (let attempt = 1; attempt <= 2 && !oauthSuccess; attempt++) {
        console.log(`agentrouter: OAuth attempt ${attempt}`);
        const githubOAuthUrl = `https://github.com/login/oauth/authorize?client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(BASE + '/oauth/github')}&scope=user:email`;

        try {
          // 先尝试加载 GitHub 持久化 cookies
          const existingGitHubCookies = await loadCookies();
          if (existingGitHubCookies.github && existingGitHubCookies.github.length > 0) {
            await ctx.addCookies(existingGitHubCookies.github);
            console.log('agentrouter: restored GitHub session cookies');
          }

          await page.goto(githubOAuthUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
          await sleep(2000);

          if (page.url().includes('github.com/login') && !page.url().includes('oauth')) {
            console.log('agentrouter: on GitHub login page...');
            await page.locator('input[name="login"]').fill(GH_USER).catch(() => {});
            await page.locator('input[name="password"]').fill(GH_PASS).catch(() => {});
            await page.locator('input[type="submit"]').first().click().catch(() => {
              page.locator('input[name="password"]').press('Enter');
            });
            await sleep(3000);
          }

          // 如果在 /session 页面，等待并重定向到 authorize
          if (page.url().includes('github.com/session')) {
            console.log('agentrouter: on GitHub session page, waiting...');
            await sleep(3000);
            for (let i = 0; i < 10; i++) {
              await sleep(1000);
              const url = page.url();
              if (!url.includes('github.com/session')) {
                console.log('agentrouter: redirected from session:', url);
                break;
              }
            }
            if (page.url().includes('github.com/session')) {
              console.log('agentrouter: navigating back to authorize...');
              await sleep(2000);
              await page.goto(githubOAuthUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
              await sleep(3000);
            }
          }

          // 如果在 /u2f/login_fragment 页面，显示提示并返回
          if (page.url().includes('github.com/u2f')) {
            console.log('agentrouter: on GitHub U2F page - needs physical device interaction');
            console.log('agentrouter: U2F login cannot be automated, please use a persistent GitHub session');
            await saveGitHubCookies(ctx);
            return { success: true, checkinSuccess: false, needsU2F: true };
          }

          if (page.url().includes('authorize')) {
            console.log('agentrouter: on authorize page, clicking...');
            await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
            await sleep(1000);
            await page.evaluate(() => {
              // 查找包含 Authorize 文本的按钮
              const allBtns = document.querySelectorAll('input[type="submit"], button');
              for (const btn of allBtns) {
                const text = btn.textContent || btn.value;
                if (text && text.includes('Authorize')) {
                  btn.click();
                  return;
                }
              }
              // 如果没有找到，点击第一个 submit 按钮
              const firstSubmit = document.querySelector('input[type="submit"]');
              if (firstSubmit) firstSubmit.click();
            }).catch(() => {});
            // 等待回调
            for (let i = 0; i < 15; i++) {
              await sleep(1000);
              const url = page.url();
              if (!url.includes('github.com') && !url.includes('authorize')) {
                console.log('agentrouter: callback detected!', url);
                isLoggedIn = true;
                oauthSuccess = true;
                break;
              }
              // 如果回到登录页，重新登录
              if (url.includes('github.com/login') && !url.includes('oauth')) {
                console.log('agentrouter: redirected to login, re-authenticating...');
                await page.locator('input[name="login"]').fill(GH_USER).catch(() => {});
                await page.locator('input[name="password"]').fill(GH_PASS).catch(() => {});
                await page.locator('input[type="submit"]').first().click().catch(() => {});
                await sleep(3000);
                break;
              }
            }
          }
        } catch(e) {
          console.log('agentrouter: OAuth failed:', e.message);
        }
      }

      if (!oauthSuccess) {
        console.log('agentrouter: OAuth failed after 2 attempts');
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

async function saveGitHubCookies(ctx) {
  try {
    const cookies = await ctx.cookies('https://github.com');
    if (cookies.length > 0) {
      const all = await loadCookies();
      all.github = cookies;
      await saveCookies(all);
      console.log('GitHub cookies saved:', cookies.length, '(for persistent sessions)');
    }
  } catch(e) {
    console.log('Failed to save GitHub cookies:', e.message);
  }
}

module.exports = { run };
