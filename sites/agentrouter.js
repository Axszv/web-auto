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
      const out = {};
      for (const ep of ['/api/user/self', '/api/user/info']) {
        try {
          const resp = await fetch(ep, { credentials: 'include' });
          const body = await resp.text();
          out[ep] = resp.status + ':' + body.slice(0, 100);
          if (resp.ok) return { ok: true, status: resp.status, ep, body: body.slice(0, 100) };
        } catch (e) { out[ep] = 'ERR:' + e.message; }
      }
      return { ok: false, detail: out };
    });
    console.log(SITE + ': checkLogin: ' + JSON.stringify(r).substring(0, 260));
    return r.ok === true;
  } catch { return false; }
}

async function doCheckin(page) {
  try {
    const result = await page.evaluate(async () => {
      const out = {};
      for (const ep of ['/api/user/check_in', '/api/user/checkin', '/api/checkin', '/checkin']) {
        try {
          const r = await fetch(ep, { method: 'POST', credentials: 'include' });
          const body = await r.text();
          out[ep] = r.status + ':' + body.slice(0, 150);
          if (r.status !== 404 && r.status !== 405) break;
        } catch (e) { out[ep] = 'ERR:' + e.message; }
      }
      return out;
    });
    console.log(SITE + ': checkin: ' + JSON.stringify(result).substring(0, 500));
    const text = JSON.stringify(result);
    if (text.includes('已经') || text.includes('already') || text.includes('"code":200') || text.includes('"success":true')) return true;
    return false;
  } catch (e) {
    console.log(SITE + ': checkin error: ' + e.message);
    return false;
  }
}

// 在 GitHub 页面上循环处理各状态，直到离开 github.com（回调成功）或超时
async function handleGitHubLogin(page, GH_USER, GH_PASS, GH_TOTP_SECRET) {
  let filled = false;
  let totpTried = false;
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
      if (url.includes('/verified-device')) {
        console.log(SITE + ': device verification (email code) required: ' + url);
        return 'needs2fa';
      }
      // TOTP 验证码页：等待输入框渲染后自动填入当前验证码
      if (GH_TOTP_SECRET && !totpTried) {
        totpTried = true;
        // GitHub 新旧版 2FA 页选择器兼容
        const sel = '#otp, #totp, input[name="otp"], input[name="totp"], input[autocomplete="one-time-code"], input[inputmode="numeric"]';
        let filledOtp = false;
        for (let w = 0; w < 20; w++) {
          const n = await page.locator(sel).count().catch(() => 0);
          if (n > 0) {
            // 取整分钟边界附近的码避免临近过期，若剩余 <5s 用下一个时间窗
            const now = Math.floor(Date.now() / 1000);
            const remain = 30 - (now % 30);
            const code = totp(GH_TOTP_SECRET, remain < 5 ? now + 30 : now);
            console.log(SITE + ': filling TOTP code');
            await page.locator(sel).first().fill(code).catch(() => {});
            await page.locator('button[type="submit"], input[type="submit"]').first().click().catch(() => {});
            filledOtp = true;
            break;
          }
          await sleep(1000);
        }
        if (!filledOtp) {
          // 诊断：列出页面上所有输入框和按钮
          const inputs = await page.evaluate(() =>
            Array.from(document.querySelectorAll('input, button[type="submit"]'))
              .map(el => ({ tag: el.tagName, type: el.type, id: el.id, name: el.name, ac: el.getAttribute('autocomplete'), im: el.getAttribute('inputmode') }))
          ).catch(() => []);
          console.log(SITE + ': TOTP field NOT found. inputs: ' + JSON.stringify(inputs));
          return 'needs2fa';
        }
        continue;
      }
      console.log(SITE + ': 2FA required but no TOTP secret');
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
  // 兜底2：通过后端 state 接口构造 OAuth URL（按钮 JS 未生效时）
  try {
    const state = await page.evaluate(async () => {
      const r = await fetch('/api/oauth/github/state', { credentials: 'include' });
      const j = await r.json();
      return j.data || j.state || null;
    });
    if (state) {
      const authUrl = 'https://github.com/login/oauth/authorize?client_id=' + 'Ov23lidtiR4LeVZvVRNL' + '&scope=user:email&state=' + encodeURIComponent(state);
      console.log(SITE + ': state fallback goto github');
      await page.goto(authUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
      if (page.url().includes('github.com')) return page;
    }
  } catch (e) {
    console.log(SITE + ': state fallback failed: ' + e.message);
  }
  console.log(SITE + ': no navigation to github.com detected');
  return null;
}

async function run(config) {
  const GH_USER = process.env.GH_USER || 'Axszv';
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

      // 回调后打开控制台页让 session 生效，再验证登录
      await page.goto(BASE + '/console', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
      await sleep(3000);
      for (let v = 0; v < 5 && !loggedIn; v++) {
        await sleep(2000);
        loggedIn = await checkLogin(page);
      }
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
