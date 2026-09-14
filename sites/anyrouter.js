// sites/anyrouter.js — GitHub OAuth 登录 + 签到 (含 Cloudflare 处理)
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { totp } = require('../lib/totp');

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

// 读取当前额度（quota）。new-api 的 /api/user/self 需要 New-Api-User 头
async function getQuota(page) {
  return await page.evaluate(async () => {
    try {
      const uid = JSON.parse(localStorage.getItem('user') || 'null')?.id || '';
      const headers = uid ? { 'New-Api-User': String(uid) } : {};
      const resp = await fetch('/api/user/self', { credentials: 'include', headers });
      const j = await resp.json().catch(() => null);
      if (j && j.success && j.data && typeof j.data.quota === 'number') return j.data.quota;
      return null;
    } catch (e) { return null; }
  });
}

// 上次运行持久化的 quota（存在加密的 cookies.json 里，key=_<SITE>_quota）
async function loadPrevQuota() {
  const all = await loadCookies();
  const v = all['_' + SITE + '_quota'];
  return typeof v === 'number' ? v : null;
}

async function savePrevQuota(q) {
  const all = await loadCookies();
  all['_' + SITE + '_quota'] = q;
  await saveCookies(all);
}

async function checkLogin(page) {
  try {
    const r = await page.evaluate(async () => {
      try {
        // new-api 前端把用户存在 localStorage，API 需要 New-Api-User 头
        const uid = JSON.parse(localStorage.getItem('user') || 'null')?.id || '';
        const headers = uid ? { 'New-Api-User': String(uid) } : {};
        const resp = await fetch('/api/user/self', { credentials: 'include', headers });
        const body = await resp.text();
        let ok = false;
        try { const j = JSON.parse(body); ok = resp.status === 200 && j.success === true; } catch {}
        return { status: resp.status, ok, body: body.slice(0, 120) };
      } catch (e) { return { status: 0, ok: false, body: 'ERR:' + e.message }; }
    });
    if (!r.ok) console.log(SITE + ': checkLogin: ' + r.status + ':' + r.body);
    return r.ok === true;
  } catch { return false; }
}

// 签到成功 = 余额相比上次运行实际增加。
// .top 前端在 OAuth 回调时自动 POST /api/user/sign_in 发放每日额度；这里再显式补调一次兜底，
// 然后用当前 quota 与上次持久化值比较判定是否真的到账。
async function doCheckin(page) {
  try {
    const signin = await page.evaluate(async () => {
      try {
        const uid = JSON.parse(localStorage.getItem('user') || 'null')?.id || '';
        const headers = uid ? { 'New-Api-User': String(uid) } : {};
        const resp = await fetch('/api/user/sign_in', { method: 'POST', credentials: 'include', headers });
        const body = await resp.text();
        return { status: resp.status, body: body.slice(0, 200) };
      } catch (e) { return { status: 0, err: e.message }; }
    });
    console.log(SITE + ': sign_in: ' + JSON.stringify(signin));

    const cur = await getQuota(page);
    const prev = await loadPrevQuota();
    console.log(SITE + ': quota prev=' + prev + ' cur=' + cur);
    if (cur == null) return false;
    let checkinSuccess;
    if (prev == null) {
      console.log(SITE + ': no baseline quota, establishing');
      checkinSuccess = cur > 0;
    } else {
      checkinSuccess = cur > prev;
    }
    await savePrevQuota(cur);
    return checkinSuccess;
  } catch (e) {
    console.log(SITE + ': checkin error: ' + e.message);
    return false;
  }
}

// 等待 Cloudflare challenge 完成
async function waitForCloudflare(page) {
  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    let content = '';
    try { content = await page.content(); } catch { continue; } // 页面导航中取内容会抛异常，跳过本轮
    if (!content.includes('challenge-platform') && !content.includes('cf-browser-verification')) {
      console.log(SITE + ': Cloudflare challenge passed');
      return true;
    }
  }
  console.log(SITE + ': Cloudflare challenge timeout');
  return false;
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
          const cnt = await page.locator(sel).count().catch(() => 0);
          if (cnt > 0) {
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
  // 兜底2：模拟前端 OAuth 流程（GET /api/oauth/state?mode=login + window.open）
  try {
    const oauthData = await page.evaluate(async () => {
      try {
        const r = await fetch('/api/oauth/state?mode=login', { credentials: 'include' });
        const txt = await r.text();
        if (r.status !== 200) return 'HTTP' + r.status + ':' + txt.slice(0, 150);
        const j = JSON.parse(txt);
        if (!j.success) return 'APIFAIL:' + (j.message || '').slice(0, 100);
        const st = await fetch('/api/status', { credentials: 'include' }).then(r2 => r2.json()).catch(() => null);
        const cid = st && st.data ? (st.data.github_client_id || '') : '';
        return JSON.stringify({ state: j.data, cid });
      } catch (e) { return 'ERR:' + e.message; }
    });
    console.log(SITE + ': state api: ' + String(oauthData).slice(0, 200));
    let state = null, cid = null;
    try {
      const j = JSON.parse(oauthData);
      state = j.state; cid = j.cid;
    } catch {}
    if (state && cid) {
      const authUrl = 'https://github.com/login/oauth/authorize?client_id=' + cid + '&state=' + encodeURIComponent(state) + '&scope=user:email';
      console.log(SITE + ': state fallback goto github (cid=' + cid + ')');
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
  const GH_USER = process.env.GH_USER;
  if (!GH_USER) throw new Error('GH_USER env required');
  const GH_PASS = process.env.GH_PASS;
  if (!GH_PASS) throw new Error('GH_PASS env required');
  const GH_TOTP_SECRET = process.env.GH_TOTP_SECRET || '';
  const isHeadless = !process.env.DISPLAY;

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
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 }
  });

  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  const page = await ctx.newPage();
  // 记录 OAuth 期间所有 API 请求，定位签到触发接口
  const apiLog = [];
  page.on('request', req => {
    const u = req.url();
    if (u.includes('/api/') && !u.includes('challenge-platform')) {
      apiLog.push(req.method() + ' ' + u.replace(BASE, '').slice(0, 100));
    }
  });


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


    if (apiLog.length) console.log(SITE + ': api requests during flow: ' + JSON.stringify(apiLog));

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
