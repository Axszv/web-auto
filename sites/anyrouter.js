// sites/anyrouter.js — GitHub OAuth/API 登录
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
  const GH_TOKEN = config.GH_TOKEN || process.env.GH_TOKEN || '';
  const BASE = 'https://anyrouter.top';
  const PROXY = { server: 'http://127.0.0.1:1080' };
  const CLIENT_ID = 'Ov23liwqF4o0LXkK2yGg';

  console.log('anyrouter: launching chromium via proxy...');
  const isHeadless = !process.env.DISPLAY;
  console.log('anyrouter: headless mode:', isHeadless);
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

    // 检查是否已登录
    let isLoggedIn = !currentUrl.includes('login') && !currentUrl.includes('github.com');
    console.log('anyrouter logged in with cookies:', isLoggedIn, 'URL:', currentUrl);

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
      console.log('anyrouter API check:', JSON.stringify(apiCheck));
      if (apiCheck.status === 401 || !apiCheck.ok) {
        isLoggedIn = false;
        console.log('anyrouter: cookies expired (status=' + apiCheck.status + '), will try login');
      }
    }

    // 如果 cookies 无效，尝试登录
    if (!isLoggedIn) {
      console.log('anyrouter: cookies invalid, attempting login...');

      // 优先使用 GitHub Token (如果提供)
      if (GH_TOKEN) {
        console.log('anyrouter: using GitHub token for API login...');
        isLoggedIn = await tryTokenLogin(page, BASE, GH_TOKEN);
      }

      // 备用：OAuth 流程
      if (!isLoggedIn) {
        console.log('anyrouter: token login failed or not available, trying OAuth...');
        isLoggedIn = await tryOAuthLogin(page, ctx, BASE, CLIENT_ID, GH_USER, GH_PASS);
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

// 使用 GitHub Token 直接 API 登录
async function tryTokenLogin(page, BASE, token) {
  try {
    console.log('anyrouter: trying token-based login...');

    // 尝试通过 GitHub API 获取用户信息
    const userInfo = await page.evaluate(async (token) => {
      try {
        const r = await fetch('https://api.github.com/user', {
          headers: {
            'Authorization': `token ${token}`,
            'Accept': 'application/json'
          }
        });
        if (r.ok) {
          const data = await r.json();
          return { ok: true, login: data.login, email: data.email };
        }
        return { ok: false, status: r.status };
      } catch(e) {
        return { error: e.message };
      }
    }, token);

    console.log('anyrouter: GitHub API response:', JSON.stringify(userInfo));

    if (userInfo.ok) {
      // 尝试使用 token 作为 Bearer 登录 anyrouter
      const apiCheck = await page.evaluate(async (token) => {
        try {
          const r = await fetch('/api/user/info', {
            headers: {
              'Authorization': `Bearer ${token}`
            }
          });
          return { status: r.status, ok: r.ok };
        } catch(e) {
          return { error: e.message };
        }
      }, token);

      console.log('anyrouter: API check with token:', JSON.stringify(apiCheck));

      if (apiCheck.ok) {
        console.log('anyrouter: token login successful!');
        return true;
      }
    }

    console.log('anyrouter: token login not supported, falling back to OAuth');
    return false;
  } catch(e) {
    console.log('anyrouter: token login error:', e.message);
    return false;
  }
}

// OAuth 登录流程
async function tryOAuthLogin(page, ctx, BASE, CLIENT_ID, GH_USER, GH_PASS) {
  let oauthSuccess = false;

  for (let attempt = 1; attempt <= 2 && !oauthSuccess; attempt++) {
    console.log(`anyrouter: OAuth attempt ${attempt}`);
    const githubOAuthUrl = `https://github.com/login/oauth/authorize?client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(BASE + '/oauth/github')}&scope=user:email`;

    try {
      // 先尝试加载 GitHub 持久化 cookies
      const existingGitHubCookies = await loadCookies();
      if (existingGitHubCookies.github && existingGitHubCookies.github.length > 0) {
        await ctx.addCookies(existingGitHubCookies.github);
        console.log('anyrouter: restored GitHub session cookies');
      }

      await page.goto(githubOAuthUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await sleep(3000);

      const currentUrl = page.url();
      console.log('anyrouter: current URL:', currentUrl);

      // 检查是否已经被重定向到授权页面（已有 GitHub session）
      if (currentUrl.includes('authorize')) {
        console.log('anyrouter: already on authorize page (GitHub session exists)');
        await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
        await sleep(2000);

        try {
          await page.evaluate(() => {
            const allBtns = document.querySelectorAll('input[type="submit"], button');
            for (const btn of allBtns) {
              const text = btn.textContent || btn.value;
              if (text && text.includes('Authorize')) {
                btn.click();
                return;
              }
            }
            const firstSubmit = document.querySelector('input[type="submit"]');
            if (firstSubmit) firstSubmit.click();
          });
          console.log('anyrouter: clicked Authorize');
        } catch(e) {
          console.log('anyrouter: JS click failed:', e.message);
        }

        // 等待回调
        console.log('anyrouter: waiting for callback...');
        for (let i = 0; i < 30; i++) {
          await sleep(1000);
          const url = page.url();
          if (!url.includes('github.com') && !url.includes('authorize')) {
            console.log('anyrouter: callback detected!', url);
            oauthSuccess = true;
            isLoggedIn = true;
            break;
          }
        }
      } else if (currentUrl.includes('github.com/login')) {
        console.log('anyrouter: on GitHub login page, entering credentials...');
        await page.locator('input[name="login"]').fill(GH_USER).catch(() => {});
        await page.locator('input[name="password"]').fill(GH_PASS).catch(() => {});
        await page.locator('input[type="submit"]').first().click().catch(() => {});
        await sleep(3000);
      } else if (currentUrl.includes('github.com/u2f')) {
        console.log('anyrouter: U2F page detected - cannot automate');
        await saveGitHubCookies(ctx);
        return false;
      } else if (currentUrl.includes('github.com/session')) {
        console.log('anyrouter: session page detected, waiting...');
        await sleep(5000);
        const newUrl = page.url();
        if (!newUrl.includes('github.com/session')) {
          console.log('anyrouter: redirected from session:', newUrl);
        }
      }
    } catch(e) {
      console.log('anyrouter: OAuth attempt failed:', e.message);
    }
  }

  if (!oauthSuccess) {
    console.log('anyrouter: OAuth failed after 2 attempts');
  }

  return oauthSuccess;
}

async function doCheckin(page, ctx, BASE) {
  let checkinSuccess = false;
  try {
    // 等待页面稳定
    await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
    await sleep(2000);

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

async function saveGitHubCookies(ctx) {
  try {
    const cookies = await ctx.cookies('https://github.com');
    if (cookies.length > 0) {
      const all = await loadCookies();
      all.github = cookies;
      await saveCookies(all);
      console.log('GitHub cookies saved:', cookies.length);
    }
  } catch(e) {
    console.log('Failed to save GitHub cookies:', e.message);
  }
}

module.exports = { run };
