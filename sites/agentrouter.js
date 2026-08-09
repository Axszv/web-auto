// sites/agentrouter.js — GitHub OAuth 登录 (持久化浏览器上下文)
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const STATE_DIR = path.join(__dirname, '..', '.playwright-state');
const STATE_FILE = path.join(STATE_DIR, 'state.json');

async function loadState() {
  if (fs.existsSync(STATE_FILE)) {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  }
  return null;
}

async function saveState(state) {
  if (!fs.existsSync(STATE_DIR)) {
    fs.mkdirSync(STATE_DIR, { recursive: true });
  }
  fs.writeFileSync(STATE_FILE, JSON.stringify(state), 'utf8');
}

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

  console.log('agentrouter: launching chromium...');
  const isHeadless = !process.env.DISPLAY;
  console.log('agentrouter: headless mode:', isHeadless);

  // 检查是否有持久化状态
  const existingState = await loadState();

  let browser;
  let ctx;

  if (existingState) {
    console.log('agentrouter: restoring persistent browser state...');
    browser = await chromium.launchPersistentContext(STATE_DIR, {
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
    ctx = browser;
  } else {
    browser = await chromium.launch({
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
    ctx = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      viewport: { width: 1920, height: 1080 },
      locale: 'en-US',
      timezoneId: 'America/New_York',
      permissions: ['geolocation'],
      deviceScaleFactor: 1,
      hasTouch: false,
      isMobile: false
    });
  }

  // 注入反检测脚本
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
      console.log(`[API] ${resp.url().substring(0, 80)} -> ${resp.status()}`);
    }
  });

  try {
    // 尝试使用现有 cookies
    console.log('agentrouter: trying with existing cookies...');
    const existingCookies = await loadCookies();
    if (existingCookies.agentrouter && existingCookies.agentrouter.length > 0) {
      await ctx.addCookies(existingCookies.agentrouter);
      console.log('agentrouter: restored existing cookies');
    }

    await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
    await sleep(2000);
    const currentUrl = page.url();
    console.log('agentrouter current URL:', currentUrl);

    let isLoggedIn = !currentUrl.includes('login') && !currentUrl.includes('github.com');
    console.log('agentrouter logged in with cookies:', isLoggedIn, 'URL:', currentUrl);

    // 验证 cookies
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
        console.log('agentrouter: cookies expired, will try OAuth');
      }
    }

    if (!isLoggedIn) {
      console.log('agentrouter: cookies invalid, trying OAuth...');
      let oauthSuccess = false;

      for (let attempt = 1; attempt <= 2 && !oauthSuccess; attempt++) {
        console.log(`agentrouter: OAuth attempt ${attempt}`);
        const githubOAuthUrl = `https://github.com/login/oauth/authorize?client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(BASE + '/oauth/github')}&scope=user:email`;

        try {
          // 先加载 GitHub cookies
          const savedCookies = await loadCookies();
          if (savedCookies.github && savedCookies.github.length > 0) {
            await ctx.addCookies(savedCookies.github);
            console.log('agentrouter: restored GitHub cookies');
          }

          await page.goto(githubOAuthUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
          await sleep(3000);

          const url = page.url();
          console.log('agentrouter: current URL:', url);

          // 检测 U2F - 保存到持久化状态后退出
          if (url.includes('github.com/u2f')) {
            console.log('agentrouter: U2F page detected, saving browser state...');
            await saveGitHubCookies(ctx);
            // 保存持久化状态
            const state = await ctx.storageState();
            await saveState({ browserType: 'chromium', state: state });
            console.log('agentrouter: browser state saved for next attempt');
            return { success: true, checkinSuccess: false, needsU2F: true };
          }

          // 检测登录页
          if (url.includes('github.com/login') && !url.includes('oauth')) {
            console.log('agentrouter: on GitHub login page...');
            await page.locator('input[name="login"]').fill(GH_USER).catch(() => {});
            await page.locator('input[name="password"]').fill(GH_PASS).catch(() => {});
            await page.locator('input[type="submit"]').first().click().catch(() => {});
            await sleep(3000);
          }

          // 再次检查 U2F
          const afterLoginUrl = page.url();
          if (afterLoginUrl.includes('github.com/u2f')) {
            console.log('agentrouter: U2F after login, saving state...');
            await saveGitHubCookies(ctx);
            const state = await ctx.storageState();
            await saveState({ browserType: 'chromium', state: state });
            return { success: true, checkinSuccess: false, needsU2F: true };
          }

          // 检测授权页面
          if (afterLoginUrl.includes('/login/oauth/authorize')) {
            console.log('agentrouter: on authorize page, clicking...');
            await sleep(1000);
            await page.evaluate(() => {
              const btns = document.querySelectorAll('input[type="submit"], button');
              for (const btn of btns) {
                if (btn.textContent?.includes('Authorize')) {
                  btn.click();
                  return;
                }
              }
              const firstSubmit = document.querySelector('input[type="submit"]');
              if (firstSubmit) firstSubmit.click();
            }).catch(() => {});

            // 等待回调
            console.log('agentrouter: waiting for callback...');
            for (let i = 0; i < 20; i++) {
              await sleep(1000);
              const current = page.url();
              if (!current.includes('github.com') && !current.includes('authorize')) {
                console.log('agentrouter: callback detected!', current);
                oauthSuccess = true;
                isLoggedIn = true;
                break;
              }
            }
          }
        } catch(e) {
          console.log('agentrouter: OAuth attempt failed:', e.message);
        }
      }

      if (!oauthSuccess) {
        console.log('agentrouter: OAuth failed after 2 attempts');
      }
    }

    // 每次运行都保存浏览器状态
    try {
      const state = await ctx.storageState();
      await saveState({ browserType: 'chromium', state: state });
      console.log('agentrouter: browser state saved');
    } catch(e) {
      console.log('agentrouter: failed to save state:', e.message);
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
      console.log('GitHub cookies saved:', cookies.length);
    }
  } catch(e) {
    console.log('Failed to save GitHub cookies:', e.message);
  }
}

module.exports = { run };
