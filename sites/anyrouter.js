// sites/anyrouter.js — GitHub OAuth 登录
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
  const BASE = 'https://anyrouter.top';
  const PROXY = { server: 'http://127.0.0.1:1080' };
  const CLIENT_ID = 'Ov23liwqF4o0LXkK2yGg';

  console.log('anyrouter: launching chromium via proxy...');
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
    await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(2000);
    const currentUrl = page.url();
    console.log('anyrouter current URL:', currentUrl);

    // 检查是否已登录（不在登录页）
    let isLoggedIn = !currentUrl.includes('login') && !currentUrl.includes('github.com');
    console.log('anyrouter logged in with cookies:', isLoggedIn);

    // 如果 cookies 无效，进行 OAuth 登录
    if (!isLoggedIn) {
      console.log('anyrouter: cookies invalid, starting OAuth flow...');
      const githubOAuthUrl = `https://github.com/login/oauth/authorize?client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(BASE + '/oauth/github')}&scope=user:email`;
      await page.goto(githubOAuthUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await sleep(2000);
      console.log('anyrouter GitHub OAuth URL:', page.url());

      // 如果在 GitHub 登录页，自动登录
      if (page.url().includes('github.com/login')) {
        console.log('anyrouter: on GitHub login page, auto-login...');
        await page.locator('input[name="login"]').fill(GH_USER);
        await page.locator('input[name="password"]').fill(GH_PASS);
        await page.locator('input[type="submit"]').click();
        await sleep(5000);
        console.log('anyrouter after GitHub login:', page.url());
      }

      // 如果在 /session 页面，找到并点击授权按钮
      if (page.url().includes('github.com/session')) {
        console.log('anyrouter: on GitHub session page, looking for authorize button...');
        await sleep(3000);
        // GitHub /session 页面有明确的授权按钮
        // 尝试多种选择器
        const selectors = [
          'input[value="Authorize"]',
          'input[value*="Authorize"]',
          'button:has-text("Authorize")',
          'button:has-text("授权")',
          'input[type="submit"][value*="Authorize"]',
        ];
        let clicked = false;
        for (const selector of selectors) {
          const btn = page.locator(selector).first();
          const count = await btn.count();
          if (count > 0) {
            const text = await btn.textContent().catch(() => '') || await btn.inputValue().catch(() => '');
            console.log(`anyrouter: found button "${text}" with selector ${selector}`);
            try {
              await btn.click({ timeout: 5000 });
              clicked = true;
              console.log('anyrouter: clicked authorize button');
              await sleep(5000);
              break;
            } catch(e) {
              console.log('anyrouter: click failed:', e.message);
            }
          }
        }
        // 如果没找到，尝试查找所有可见按钮并跳过特定类型
        if (!clicked) {
          const allButtons = await page.locator('button, input[type="submit"]').all();
          console.log(`anyrouter: found ${allButtons.length} total buttons`);
          for (const btn of allButtons) {
            try {
              const text = await btn.textContent();
              const classes = await btn.getAttribute('class') || '';
              const type = await btn.getAttribute('type') || '';
              // 跳过关闭按钮、第三方登录按钮
              if (classes.includes('flash-close') || classes.includes('js-flash-close')) continue;
              if (text && (text.includes('Google') || text.includes('Facebook') || text.includes('Apple'))) continue;
              if (text && text.includes('Continue with')) continue;
              // 查找包含 Authorize 或类似文本的按钮
              if (text && (text.includes('Authorize') || text.includes('授权') || text.includes('Allow') || text.trim().length > 3)) {
                console.log(`anyrouter: clicking button: "${text?.substring(0, 50)}"`);
                await btn.click({ timeout: 5000 });
                clicked = true;
                await sleep(5000);
                break;
              }
            } catch(e) {
              // 忽略错误
            }
          }
        }
        if (!clicked) {
          console.log('anyrouter: no authorize button found, checking URL...');
        }
        console.log('anyrouter after session handling:', page.url());
      }

      // 如果到了 authorize 页面，点击授权
      if (page.url().includes('authorize')) {
        console.log('anyrouter: clicking Authorize...');
        const authBtn = page.locator('input[type="submit"], button[type="submit"]').first();
        if (await authBtn.count() > 0) {
          await authBtn.click();
          await sleep(5000);
        }
      }

      // 等待 OAuth 回调
      console.log('anyrouter: waiting for OAuth callback...');
      for (let i = 0; i < 30; i++) {
        await sleep(2000);
        const url = page.url();
        if (!url.includes('github.com') && !url.includes('oauth') && !url.includes('authorize')) {
          console.log('anyrouter: OAuth callback detected! URL:', url);
          isLoggedIn = true;
          break;
        }
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

module.exports = { run };
