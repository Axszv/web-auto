// sites/agentrouter.js — GitHub OAuth 登录 (反检测优化版)
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

async function sleep(ms) { return new Promise(r => setTimeout(r, ms + Math.random() * 500)); }

async function randomDelay(min, max) {
  await sleep(min + Math.random() * (max - min));
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
      '--single-process',
      '--disable-web-security',
      '--disable-features=IsolateOrigins,site-per-process'
    ],
    proxy: PROXY
  });

  // 使用更真实的浏览器配置
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 },
    locale: 'en-US',
    timezoneId: 'America/New_York',
    permissions: ['geolocation'],
    deviceScaleFactor: 1,
    hasTouch: false,
    isMobile: false,
    colorScheme: 'light',
    reducedMotion: 'no-preference',
    reducedTransparency: 'no-preference'
  });

  // 更强的反检测脚本
  await ctx.addInitScript(() => {
    // 隐藏 webdriver 特征
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });

    // 模拟真实 Chrome
    window.chrome = {
      runtime: {},
      loadTimes: function() {},
      csi: function() {},
      app: {}
    };

    // 设置真实的语言列表
    Object.defineProperty(navigator, 'languages', {
      get: () => ['en-US', 'en', 'zh-CN', 'zh']
    });

    // 模拟真实的 plugins
    Object.defineProperty(navigator, 'plugins', {
      get: () => {
        return {
          length: 4,
          [Symbol.iterator]: function* () {
            yield { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer' };
            yield { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai' };
            yield { name: 'Native Client', filename: 'internal-nacl-plugin' };
            yield { name: 'PDF Viewer', filename: 'pdf Viewer' };
          }
        };
      }
    });

    // 模拟真实的 webgl renderer
    const getParameter = WebGLRenderingContext.prototype.getParameter;
    WebGLRenderingContext.prototype.getParameter = function(parameter) {
      if (parameter === 37445) return 'Google Inc. (AMD)';
      if (parameter === 37446) return 'ANGLE (AMD, AMD Radeon RX 5700 Series Direct3D11 vs_5_0 ps_5_0)';
      return getParameter.call(this, parameter);
    };

    // 模拟真实的连接信息
    window.navigator.connection = {
      effectiveType: '4g',
      rtt: 50,
      downlink: 10,
      saveData: false,
      onchange: null
    };

    // 移除 automation 相关属性
    delete navigator.__proto__.webdriver;
  });

  const existingCookies = await loadCookies();
  if (existingCookies.agentrouter && existingCookies.agentrouter.length > 0) {
    await ctx.addCookies(existingCookies.agentrouter);
    console.log('agentrouter: restored existing cookies');
  }

  const page = await ctx.newPage();

  // 添加鼠标移动模拟
  await page.mouse.move(100, 100);
  await randomDelay(100, 300);

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
    await page.goto(BASE, { waitUntil: 'networkidle', timeout: 20000 }).catch(async () => {
      await page.goto(BASE, { waitUntil: 'networkidle', timeout: 20000 });
    });
    await randomDelay(1000, 2000);
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
      let u2fCount = 0; // 追踪 U2F 触发次数

      for (let attempt = 1; attempt <= 3 && !oauthSuccess; attempt++) {
        console.log(`agentrouter: OAuth attempt ${attempt}`);
        const githubOAuthUrl = `https://github.com/login/oauth/authorize?client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(BASE + '/oauth/github')}&scope=user:email`;

        try {
          // 先加载 GitHub cookies
          const savedCookies = await loadCookies();
          if (savedCookies.github && savedCookies.github.length > 0) {
            await ctx.addCookies(savedCookies.github);
            console.log('agentrouter: restored GitHub cookies');
            await randomDelay(500, 1000);
          }

          await page.goto(githubOAuthUrl, { waitUntil: 'networkidle', timeout: 30000 });
          await randomDelay(1500, 2500);

          const url = page.url();
          console.log('agentrouter: current URL:', url);

          // 检测 U2F - 尝试重新导航
          if (url.includes('u2f')) {
            u2fCount++;
            console.log(`agentrouter: U2F detected (attempt ${u2fCount}), retrying...`);
            await saveGitHubCookies(ctx);

            // 如果是第一次遇到 U2F，尝试重新导航
            if (u2fCount <= 2) {
              await randomDelay(2000, 3000);
              await page.goto(githubOAuthUrl, { waitUntil: 'networkidle', timeout: 30000 });
              await randomDelay(2000, 3000);
              const newUrl = page.url();
              console.log('agentrouter: after retry URL:', newUrl);

              // 如果重新导航后还是 U2F，放弃
              if (newUrl.includes('u2f')) {
                console.log('agentrouter: still on U2F page after retry, cannot automate');
                return { success: true, checkinSuccess: false, needsU2F: true };
              }
              // 如果到了授权页面，继续流程
              if (newUrl.includes('/login/oauth/authorize')) {
                continue; // 继续到授权逻辑
              }
            } else {
              console.log('agentrouter: too many U2F attempts, giving up');
              return { success: true, checkinSuccess: false, needsU2F: true };
            }
          }

          // 检测登录页
          if (url.includes('github.com/login') && !url.includes('oauth')) {
            console.log('agentrouter: on GitHub login page...');
            await randomDelay(500, 1000);

            // 模拟真实用户输入
            const loginInput = page.locator('input[name="login"]');
            await loginInput.waitFor({ timeout: 5000 }).catch(() => {});
            await loginInput.fill(GH_USER);
            await randomDelay(200, 500);
            await loginInput.press('Tab');
            await randomDelay(200, 500);

            const passInput = page.locator('input[name="password"]');
            await passInput.waitFor({ timeout: 5000 }).catch(() => {});
            await passInput.fill(GH_PASS);
            await randomDelay(300, 800);

            // 模拟真实点击
            const submitBtn = page.locator('input[type="submit"]');
            await submitBtn.click();
            await randomDelay(2000, 4000);
          }

          // 检查是否到授权页面
          const afterLoginUrl = page.url();
          console.log('agentrouter: after login URL:', afterLoginUrl);

          if (afterLoginUrl.includes('u2f')) {
            console.log('agentrouter: U2F after login, aborting...');
            await saveGitHubCookies(ctx);
            return { success: true, checkinSuccess: false, needsU2F: true };
          }

          if (afterLoginUrl.includes('/login/oauth/authorize')) {
            console.log('agentrouter: on authorize page, clicking...');
            await randomDelay(1000, 2000);

            // 寻找并点击 Authorize 按钮
            const authBtn = page.locator('input[type="submit"][value="Authorize"], button:has-text("Authorize")');
            if (await authBtn.count() > 0) {
              await authBtn.hover();
              await randomDelay(200, 500);
              await authBtn.click();
              console.log('agentrouter: clicked Authorize');
            } else {
              // 备用方案
              await page.evaluate(() => {
                const btns = document.querySelectorAll('input[type="submit"], button');
                for (const btn of btns) {
                  if (btn.textContent?.includes('Authorize')) {
                    btn.click();
                    return;
                  }
                }
              });
            }

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
              if (current.includes('u2f')) {
                console.log('agentrouter: U2F during callback, aborting...');
                await saveGitHubCookies(ctx);
                break;
              }
            }
          }
        } catch(e) {
          console.log('agentrouter: OAuth attempt failed:', e.message);
        }
      }

      if (!oauthSuccess) {
        console.log('agentrouter: OAuth failed');
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
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
    await randomDelay(500, 1000);

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
