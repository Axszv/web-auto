// sites/anyrouter.js — 使用 sing-box VLESS 代理绕过 Cloudflare
const { firefox } = require('playwright');
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
  const GH_USER = config.GH_USER || process.env.GH_USER || '';
  const GH_PASS = config.GH_PASS || process.env.GH_PASS || '';
  const BASE = 'https://anyrouter.top';

  // 使用 sing-box 本地 HTTP 代理 (port 1080)
  const PROXY = { server: 'http://127.0.0.1:1080' };

  const browser = await firefox.launch({
    headless: false,
    args: ['--no-sandbox'],
    proxy: PROXY
  });

  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
    locale: 'en-US'
  });

  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
  });

  // 清除旧 cookies，强制重新登录
  console.log('anyrouter: clearing old cookies...');
  await ctx.clearCookies();

  const page = await ctx.newPage();
  page.on('console', msg => console.log('[PAGE]', msg.text().substring(0, 200)));
  page.on('pageerror', err => console.log('[PAGE ERROR]', err.message));

  try {
    console.log('anyrouter: starting via sing-box proxy...');
    await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(5000);
    console.log('anyrouter after main:', page.url());

    await page.goto(BASE + '/console/personal', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(3000);
    let url = page.url();
    console.log('anyrouter URL:', url);

    let checkinSuccess = false;
    let loggedIn = false;

    if (url.includes('login') || url.includes('oauth')) {
      console.log('anyrouter: not logged in, navigating to login...');
      await page.goto(BASE + '/login', { waitUntil: 'domcontentloaded', timeout: 30000 });
      await sleep(3000);
      console.log('anyrouter login page URL:', page.url());

      // 检查是否有 GitHub OAuth 按钮
      const hasGitHubBtn = await page.evaluate(() => {
        const svg = document.querySelector('[aria-label="github_logo"]');
        return !!svg;
      });
      console.log('anyrouter: has GitHub button:', hasGitHubBtn);

      if (hasGitHubBtn) {
        console.log('anyrouter: clicking GitHub OAuth button...');
        // 使用 page.click 而不是 evaluate 来确保点击事件正确触发
        await page.locator('[aria-label="github_logo"]').first().click();
        await sleep(3000);
        console.log('anyrouter after click, URL:', page.url());

        if (page.url().includes('github.com/login') && GH_USER && GH_PASS) {
          console.log('anyrouter: on GitHub login page');
          await page.locator('input[name="login"]').first().fill(GH_USER);
          await page.locator('input[name="password"]').first().fill(GH_PASS);
          await page.locator('input[type="submit"]').first().click();
          await sleep(2000);
          if (page.url().includes('github.com/login')) {
            console.log('anyrouter: 2FA required');
            await browser.close();
            return { success: false, error: '2fa_required' };
          }
        }

        try {
          await page.waitForURL(u => u.toString().includes('authorize'), { timeout: 15000 });
          console.log('anyrouter: on authorize page');
          const authBtn = page.locator('button[type="submit"], .btn-primary, text=Authorize').first();
          if (await authBtn.count() > 0) {
            await authBtn.click({ force: true });
            console.log('anyrouter: clicked Authorize');
          }
        } catch (e) {
          console.log('anyrouter: did not reach authorize, URL:', page.url());
        }

        await sleep(5000);
        console.log('anyrouter: final URL:', page.url());
        loggedIn = !page.url().includes('login');
      }
    } else {
      loggedIn = true;
    }

    if (loggedIn) {
      console.log('anyrouter: logged in!');
      try {
        const cookies = await ctx.cookies(BASE);
        const cookieStr = cookies.map(c => c.name + '=' + c.value).join('; ');

        // 先获取签到前余额
        let beforeBalance = null;
        try {
          const infoResp = await page.request.get(BASE + '/api/user/info', {
            headers: { 'Cookie': cookieStr, 'Accept': 'application/json' }
          });
          if (infoResp.ok()) {
            const info = await infoResp.json();
            beforeBalance = info.data?.balance || info.data?.credits || info.balance || info.credits;
            console.log('anyrouter: balance before checkin:', beforeBalance);
          }
        } catch(e) {}

        // 签到
        const cr = await page.evaluate(async () => {
          try { const r = await fetch('/api/user/checkin', { method: 'POST' }); return await r.json(); }
          catch(e) { return { error: e.message }; }
        });
        console.log('anyrouter checkin:', JSON.stringify(cr));

        // 获取签到后余额
        let afterBalance = null;
        try {
          const infoResp2 = await page.request.get(BASE + '/api/user/info', {
            headers: { 'Cookie': cookieStr, 'Accept': 'application/json' }
          });
          if (infoResp2.ok()) {
            const info2 = await infoResp2.json();
            afterBalance = info2.data?.balance || info2.data?.credits || info2.balance || info2.credits;
            console.log('anyrouter: balance after checkin:', afterBalance);
          }
        } catch(e) {}

        // 判断签到是否成功
        if (cr && (cr.code === 200 || cr.success === true || cr.message?.includes('成功'))) {
          checkinSuccess = true;
          console.log('anyrouter: checkin successful (API returned success)');
        }
        if (beforeBalance !== null && afterBalance !== null) {
          const diff = afterBalance - beforeBalance;
          console.log('anyrouter: balance change:', diff);
          if (diff >= 25) {
            checkinSuccess = true;
            console.log('anyrouter: balance increased by', diff, '-> checkin successful!');
          }
        }
      } catch(e) {
        console.log('anyrouter checkin error:', e.message);
      }
    } else {
      console.log('anyrouter: still on login page');
    }

    const cookies = await ctx.cookies(BASE);
    if (cookies.length > 0) {
      const all = await loadCookies();
      all.anyrouter = cookies;
      await saveCookies(all);
      console.log('anyrouter cookies saved:', cookies.length);
    }

    await browser.close();
    console.log('anyrouter done, checkinSuccess:', checkinSuccess);
    return { success: true, checkinSuccess };
  } catch (e) {
    console.error('anyrouter error:', e.message);
    await browser.close();
    return { success: false, error: e.message };
  }
}

module.exports = { run };
