// sites/agentrouter.js — GitHub OAuth 登录 + 签到
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { totp } = require('../lib/totp');

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const SITE = 'agentrouter';
const BASE = 'https://agentrouter.org';
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

// 在 GitHub 页面上循环处理各状态，直到离开 github.com（回调成功）或超时
async function handleGitHubLogin(page, GH_USER, GH_PASS, GH_TOTP_SECRET) {
  let filled = false;
  for (let i = 0; i < 60; i++) {
    await sleep(1000);
    const url = page.url();
    if (!url.includes('github.com')) {
      console.log(SITE + ': callback: ' + url);
      return 'done';
    }

    if (i % 10 === 0) {
      const title = await page.title().catch(() => '?');
      console.log(SITE + ': gh state: ' + url.slice(0, 90) + ' | ' + title.slice(0, 40));
    }

    // 2FA / 设备验证
    if (url.includes('/u2f') || url.includes('/two-factor') || url.includes('/verified-device')) {
      if (GH_TOTP_SECRET && !url.includes('/verified-device')) {
        // TOTP 验证码页：自动填入当前验证码
        const hasTotpField = await page.locator('#otp, input[name="otp"], input[autocomplete="one-time-code"]').count().catch(() => 0);
        if (hasTotpField > 0) {
          // 取整分钟边界附近的码避免临近过期，若剩余 <5s 用下一个时间窗
          const now = Math.floor(Date.now() / 1000);
          const remain = 30 - (now % 30);
          const code = totp(GH_TOTP_SECRET, remain < 5 ? now + 30 : now);
          console.log(SITE + ': filling TOTP code');
          await page.locator('#otp, input[name="otp"], input[autocomplete="one-time-code"]').first().fill(code);
          await page.locator('button[type="submit"], input[type="submit"]').first().click().catch(() => {});
          filled = false; // 2FA 提交后可能回登录页，允许重新填账号
          continue;
        }
      }
      console.log(SITE + ': 2FA/device verification required');
      return 'needs2fa';
    }

    // 授权页
    if (url.includes('/login/oauth/authorize')) {
      await page.evaluate(() => {
        const btn = document.querySelector('#js-oauth-authorize-btn') ||
                    document.querySelector('button[name="authorize"]') ||
                    document.querySelector('button[type="submit"]') ||
                    document.querySelector('input[value="Authorize"]');
        if (btn) btn.click();
      }).catch(() => {});
      continue;
    }

    // 登录页 / 登录失败页（POST /session 失败时 URL 停在 /session）
    const hasForm = await page.locator('input[name="login"]').count().catch(() => 0);
    if (hasForm > 0 && !filled) {
      console.log(SITE + ': filling GitHub credentials...');
      await page.locator('input[name="login"]').fill(GH_USER);
      await page.locator('input[name="password"]').fill(GH_PASS);
      await page.locator('input[type="submit"], button[type="submit"]').first().click();
      filled = true;
      continue;
    }

    // 错误提示
    const err = await page.evaluate(() => {
      const e = document.querySelector('.flash-error, .js-flash-error, [role="alert"]');
      return e ? e.textContent.trim().slice(0, 150) : null;
    }).catch(() => null);
    if (err) {
      console.log(SITE + ': GitHub error: ' + err);
      return 'login_failed';
    }
  }
  console.log(SITE + ': github flow timeout, url: ' + page.url());
  return 'timeout';
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

async function run(config) {
  const GH_USER = process.env.GH_USER || 'REDACTED';
  const GH_PASS = process.env.GH_PASS || 'REDACTED';
  const GH_TOTP_SECRET = process.env.GH_TOTP_SECRET || 'REDACTED';
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
    // 1. 检查登录状态
    await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await sleep(2000);

    let loggedIn = await checkLogin(page);
    console.log(SITE + ': logged in = ' + loggedIn);

    // 2. 未登录则走 OAuth
    if (!loggedIn) {
      console.log(SITE + ': starting OAuth...');
      await page.goto(BASE + '/login', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
      await sleep(2000);
      console.log(SITE + ': login page: ' + page.url());

      const oauthPage = await startOAuth(page, ctx);
      if (!oauthPage) {
        console.log(SITE + ': OAuth skipped');
      } else {
        const ghResult = await handleGitHubLogin(oauthPage, GH_USER, GH_PASS, GH_TOTP_SECRET);
        console.log(SITE + ': github flow: ' + ghResult);
        if (ghResult === 'needs2fa') {
          await saveGitHubCookies(ctx);
          return { success: true, checkinSuccess: false, needsU2F: true };
        }
      }

      // 验证登录
      loggedIn = await checkLogin(page);
      console.log(SITE + ': login result = ' + loggedIn);
    }

    // 3. 签到
    let checkinSuccess = false;
    if (loggedIn) {
      checkinSuccess = await doCheckin(page);
    }

    // 4. 保存 cookies
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
