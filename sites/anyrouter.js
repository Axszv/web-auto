// sites/anyrouter.js — GitHub OAuth 登录 + 签到 (含 Cloudflare 处理)
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const SITE = 'anyrouter';
const BASE = 'https://anyrouter.top';
const STATE_DIR = path.join(__dirname, '..', '.playwright-state', SITE);
const COOKIE_FILE = path.join(__dirname, '..', 'cookies.json');

async function loadCookies() {
  try { return JSON.parse(fs.readFileSync(COOKIE_FILE, 'utf8')); } catch { return {}; }
}

async function saveCookies(all) {
  fs.writeFileSync(COOKIE_FILE, JSON.stringify(all, null, 2), 'utf8');
}

async function saveSiteCookies(ctx) {
  const cookies = await ctx.cookies(BASE);
  if (cookies.length > 0) {
    const all = await loadCookies();
    all[SITE] = cookies;
    await saveCookies(all);
    console.log(SITE + ': site cookies saved (' + cookies.length + ')');
  }
}

async function saveGitHubCookies(ctx) {
  const cookies = await ctx.cookies('https://github.com');
  if (cookies.length > 0) {
    const all = await loadCookies();
    all.github = cookies;
    await saveCookies(all);
    console.log(SITE + ': GitHub cookies saved (' + cookies.length + ')');
  }
}

async function checkLogin(page) {
  try {
    const r = await page.evaluate(async () => {
      const resp = await fetch('/api/user/info', { credentials: 'include' });
      return { status: resp.status, ok: resp.ok };
    });
    return r.ok && r.status !== 401;
  } catch { return false; }
}

async function doCheckin(page) {
  try {
    const result = await page.evaluate(async () => {
      try {
        const r = await fetch('/checkin', { method: 'POST', credentials: 'include' });
        return await r.json();
      } catch (e) { return { error: e.message }; }
    });
    console.log(SITE + ': checkin:', JSON.stringify(result).substring(0, 300));
    return result.code === 200 || result.success === true;
  } catch (e) {
    console.log(SITE + ': checkin error:', e.message);
    return false;
  }
}

// 等待 Cloudflare challenge 完成
async function waitForCloudflare(page) {
  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    const content = await page.content();
    // CF challenge 页面通常包含这些标记
    if (!content.includes('challenge-platform') && !content.includes('cf-browser-verification')) {
      console.log(SITE + ': Cloudflare challenge passed');
      return true;
    }
  }
  console.log(SITE + ': Cloudflare challenge timeout');
  return false;
}

async function handleGitHubLogin(page, GH_USER, GH_PASS) {
  let url = page.url();
  console.log(SITE + ': GitHub page: ' + url);

  // 登录页面
  if (url.includes('github.com/login') && !url.includes('oauth/authorize')) {
    console.log(SITE + ': filling GitHub credentials...');
    await page.locator('input[name="login"]').fill(GH_USER);
    await page.locator('input[name="password"]').fill(GH_PASS);
    await page.locator('input[type="submit"], button[type="submit"]').first().click();
    await sleep(4000);
    url = page.url();
    console.log(SITE + ': after login: ' + url);
  }

  // U2F / 2FA
  if (url.includes('github.com/u2f') || url.includes('github.com/sessions/two-factor') || url.includes('github.com/two-factor')) {
    console.log(SITE + ': 2FA detected, cannot proceed automatically');
    return 'needs2fa';
  }

  // 授权页面
  if (url.includes('/login/oauth/authorize')) {
    console.log(SITE + ': clicking authorize...');
    await page.evaluate(() => {
      const btn = document.querySelector('button[type="submit"], input[value="Authorize"]');
      if (btn) btn.click();
    });
    await sleep(3000);
  }

  return 'ok';
}

// 点击 GitHub 登录按钮：semi-portal 弹层可能拦截指针事件，先 force 点击，失败再用 JS 点击
async function clickGitHubButton(page) {
  const loc = page.locator('a[href*="github"], button:has-text("GitHub"), a:has-text("GitHub")').first();
  if (await loc.count() === 0) {
    console.log(SITE + ': no GitHub button found');
    return false;
  }
  try {
    await loc.click({ force: true, timeout: 5000 });
  } catch {
    await loc.evaluate(el => el.click());
  }
  // 等待跳转到 github.com（点击成功会发起 OAuth 跳转）
  for (let i = 0; i < 15; i++) {
    await sleep(1000);
    if (page.url().includes('github.com')) {
      console.log(SITE + ': GitHub page: ' + page.url());
      return true;
    }
  }
  console.log(SITE + ': click did not navigate to github.com');
  return false;
}

async function waitForCallback(page, maxSeconds) {
  // 必须先确认在 github.com 上，再等离开
  for (let i = 0; i < 10; i++) {
    if (page.url().includes('github.com')) break;
    await sleep(1000);
  }
  for (let i = 0; i < maxSeconds; i++) {
    await sleep(1000);
    const url = page.url();
    if (!url.includes('github.com') && !url.includes('authorize')) {
      console.log(SITE + ': callback: ' + url);
      return true;
    }
  }
  return false;
}

async function run(config) {
  const GH_USER = process.env.GH_USER || 'REDACTED';
  const GH_PASS = process.env.GH_PASS || 'REDACTED';
  const isHeadless = !process.env.DISPLAY;
  const PROXY = { server: 'http://127.0.0.1:1080' };

  console.log(SITE + ': start (headless=' + isHeadless + ')');
  if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true });

  const ctx = await chromium.launchPersistentContext(STATE_DIR, {
    headless: isHeadless,
    args: [
      '--no-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-first-run',
      '--single-process'
    ],
    proxy: PROXY,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 }
  });

  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  const page = await ctx.newPage();

  try {
    // 1. 访问首页，可能有 Cloudflare challenge
    console.log(SITE + ': loading ' + BASE);
    await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    await waitForCloudflare(page);
    await sleep(2000);

    // 2. 检查登录状态
    let loggedIn = await checkLogin(page);
    console.log(SITE + ': logged in = ' + loggedIn);

    // 3. 未登录则走 OAuth
    if (!loggedIn) {
      console.log(SITE + ': starting OAuth...');

      // GitHub 按钮可能在首页或 /login 页
      const hasBtn = await page.locator('a[href*="github"], button:has-text("GitHub"), a:has-text("GitHub")').first().count();
      if (hasBtn === 0) {
        await page.goto(BASE + '/login', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
        await waitForCloudflare(page);
        await sleep(2000);
      }

      const clicked = await clickGitHubButton(page);
      if (!clicked) {
        console.log(SITE + ': OAuth skipped (button not found or no navigation)');
      } else {
        // 处理 GitHub 页面
        const ghResult = await handleGitHubLogin(page, GH_USER, GH_PASS);
        if (ghResult === 'needs2fa') {
          await saveGitHubCookies(ctx);
          return { success: true, checkinSuccess: false, needsU2F: true };
        }

        // 等待回调
        const gotCallback = await waitForCallback(page, 30);
        if (!gotCallback) {
          console.log(SITE + ': callback timeout');
          // 回调超时可能是因为 CF challenge，再等一下
          await waitForCloudflare(page);
        }

        await sleep(2000);
      }

      // 验证登录
      loggedIn = await checkLogin(page);
      console.log(SITE + ': login result = ' + loggedIn);
    }

    // 4. 签到
    let checkinSuccess = false;
    if (loggedIn) {
      checkinSuccess = await doCheckin(page);
    }

    // 5. 保存 cookies
    await saveSiteCookies(ctx);
    await saveGitHubCookies(ctx);

    return { success: true, checkinSuccess };
  } catch (e) {
    console.error(SITE + ': error:', e.message);
    return { success: false, error: e.message };
  } finally {
    await ctx.close();
  }
}

module.exports = { run };
