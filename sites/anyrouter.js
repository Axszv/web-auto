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
      const out = {};
      try {
        const r1 = await fetch('/api/user/checkin', { method: 'POST', credentials: 'include' });
        out.api = { status: r1.status, body: await r1.text() };
      } catch (e) { out.apiError = e.message; }
      if (out.api && out.api.status !== 404) return out;
      try {
        const r2 = await fetch('/checkin', { method: 'POST', credentials: 'include' });
        out.legacy = { status: r2.status, body: await r2.text() };
      } catch (e) { out.legacyError = e.message; }
      return out;
    });
    console.log(SITE + ': checkin:', JSON.stringify(result).substring(0, 400));
    const bodies = [result.api, result.legacy].filter(Boolean);
    for (const b of bodies) {
      try {
        const j = JSON.parse(b.body);
        if (j.code === 200 || j.success === true) return true;
      } catch {}
    }
    return false;
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
    if (url.includes('github.com/login') && !url.includes('oauth')) {
      const err = await page.evaluate(() => {
        const e = document.querySelector('.js-flash-error, #login .flash-error');
        return e ? e.textContent.trim().slice(0, 120) : null;
      }).catch(() => null);
      if (err) console.log(SITE + ': GitHub login error: ' + err);
    }
  }

  // 2FA
  if (url.includes('github.com/u2f') || url.includes('github.com/sessions/two-factor') || url.includes('github.com/two-factor')) {
    console.log(SITE + ': 2FA detected, cannot proceed automatically');
    return 'needs2fa';
  }

  // 授权页面
  if (url.includes('/login/oauth/authorize')) {
    console.log(SITE + ': clicking authorize...');
    await sleep(1000);
    await page.evaluate(() => {
      const btn = document.querySelector('#js-oauth-authorize-btn') ||
                  document.querySelector('button[name="authorize"]') ||
                  document.querySelector('button[type="submit"]') ||
                  document.querySelector('input[value="Authorize"]');
      if (btn) btn.click();
    }).catch(() => {});
    await sleep(3000);
  }

  return 'ok';
}

// 点击 GitHub 登录按钮；站点可能用 window.open 在新标签页打开 OAuth，必须捕获 popup
async function startOAuth(page, ctx) {
  // 诊断：列出候选元素
  const candidates = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('a, button'))
      .filter(el => /github/i.test((el.getAttribute('href') || '') + ' ' + (el.textContent || '')))
      .map(el => ({
        tag: el.tagName,
        href: el.getAttribute('href'),
        target: el.getAttribute('target'),
        text: (el.textContent || '').trim().slice(0, 40)
      }));
  });
  console.log(SITE + ': GitHub candidates: ' + JSON.stringify(candidates));

  const loc = page.locator('a[href*="github"], button:has-text("GitHub"), a:has-text("GitHub")').first();
  if (await loc.count() === 0) {
    console.log(SITE + ': no GitHub button found');
    return null;
  }

  const popupPromise = ctx.waitForEvent('page', { timeout: 20000 }).catch(() => null);
  try {
    await loc.click({ force: true, timeout: 5000 });
    console.log(SITE + ': clicked GitHub button (force)');
  } catch {
    await loc.evaluate(el => el.click()).catch(() => {});
    console.log(SITE + ': clicked GitHub button (JS)');
  }

  const popup = await popupPromise;
  if (popup) {
    await popup.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
    console.log(SITE + ': popup opened: ' + popup.url());
    if (popup.url().includes('github.com')) return popup;
  }
  if (page.url().includes('github.com')) {
    console.log(SITE + ': same-tab navigation: ' + page.url());
    return page;
  }

  // 兜底：直接跳转按钮的 github href
  const href = candidates.find(c => c.href && c.href.includes('github.com'));
  if (href) {
    console.log(SITE + ': navigating directly to ' + href.href);
    await page.goto(href.href, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    if (page.url().includes('github.com')) return page;
  }
  console.log(SITE + ': no navigation to github.com detected');
  return null;
}

async function waitForCallback(oauthPage, maxSeconds) {
  for (let i = 0; i < maxSeconds; i++) {
    await sleep(1000);
    const url = oauthPage.url();
    if (!url.includes('github.com')) {
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
      '--no-first-run'
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
      let oauthPage = await startOAuth(page, ctx);
      if (!oauthPage) {
        await page.goto(BASE + '/login', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
        await waitForCloudflare(page);
        await sleep(2000);
        oauthPage = await startOAuth(page, ctx);
      }

      if (!oauthPage) {
        console.log(SITE + ': OAuth skipped');
      } else {
        const ghResult = await handleGitHubLogin(oauthPage, GH_USER, GH_PASS);
        if (ghResult === 'needs2fa') {
          await saveGitHubCookies(ctx);
          return { success: true, checkinSuccess: false, needsU2F: true };
        }
        const back = await waitForCallback(oauthPage, 40);
        if (!back) console.log(SITE + ': callback timeout, url: ' + oauthPage.url());
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
