// sites/agentrouter.js — 使用 Chromium，通过 page.request 发送 API 请求
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
  const GH_USER = config.GH_USER || process.env.GH_USER || '';
  const GH_PASS = config.GH_PASS || process.env.GH_PASS || '';
  const BASE = 'https://agentrouter.org';

  console.log('agentrouter: launching chromium...');
  const browser = await chromium.launch({
    headless: false,
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled']
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
    Object.defineProperty(navigator, 'platform', { get: () => 'Win32' });
    Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });
    Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 });
  });

  // 恢复 session cookie
  const existingCookies = await loadCookies();
  if (existingCookies.agentrouter) {
    const sessionCookies = existingCookies.agentrouter.filter(c => c.name === 'session');
    if (sessionCookies.length > 0) {
      await ctx.addCookies(sessionCookies);
      console.log('agentrouter: restored session cookie');
    }
  }

  const page = await ctx.newPage();
  page.on('console', msg => console.log('[PAGE]', msg.text().substring(0, 200)));
  page.on('pageerror', err => console.log('[PAGE ERROR]', err.message));

  try {
    console.log('agentrouter: navigating to console...');
    await page.goto(BASE + '/console', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(3000);
    console.log('agentrouter URL:', page.url());

    const loggedIn = !page.url().includes('login');
    console.log('agentrouter: logged in status:', loggedIn);

    if (loggedIn) {
      const checkinSuccess = await doCheckin(page, ctx, BASE);
      await saveCtxCookies(ctx, BASE);
      await browser.close();
      console.log('agentrouter done, checkinSuccess:', checkinSuccess);
      return { success: true, checkinSuccess };
    }

    // 尝试 GitHub OAuth
    let githubBtn = page.locator('[aria-label="github_logo"]');
    if (await githubBtn.count() === 0) githubBtn = page.locator('text=Continue with GitHub');
    if (await githubBtn.count() === 0) githubBtn = page.locator('.semi-icon-github_logo');

    if (await githubBtn.count() > 0) {
      await githubBtn.first().click({ force: true });
      await sleep(5000);
      if (page.url().includes('github.com')) {
        if (page.url().includes('/login')) {
          await page.locator('input[name="login"]').first().fill(GH_USER);
          await page.locator('input[name="password"]').first().fill(GH_PASS);
          await page.locator('input[type="submit"]').first().click();
          await sleep(2000);
          if (!page.url().includes('/login')) {
            try {
              await page.waitForURL(u => u.toString().includes('authorize'), { timeout: 15000 });
              const authBtn = page.locator('button[type="submit"], .btn-primary, text=Authorize').first();
              if (await authBtn.count() > 0) await authBtn.click({ force: true });
            } catch(e) {}
            await sleep(5000);
            loggedIn = !page.url().includes('login');
          }
        }
      }
    }

    if (loggedIn) {
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
    // 使用 page.request 发送请求（使用浏览器的 cookie）
    const cookies = await ctx.cookies(BASE);
    const cookieStr = cookies.map(c => c.name + '=' + c.value).join('; ');
    console.log('agentrouter: cookie count:', cookies.length);
    console.log('agentrouter: cookie names:', cookies.map(c => c.name).join(', '));

    // 获取 before balance
    let beforeBalance = null;
    try {
      const infoResp = await page.request.get(BASE + '/api/user/info', {
        headers: { 'Cookie': cookieStr, 'Accept': 'application/json' }
      });
      console.log('agentrouter: info status:', infoResp.status());
      const text = await infoResp.text();
      if (infoResp.headers()['content-type']?.includes('json')) {
        const info = JSON.parse(text);
        beforeBalance = info.data?.balance || info.data?.credits || info.balance || info.credits;
        console.log('agentrouter: balance before:', beforeBalance);
      } else {
        console.log('agentrouter: info response (not JSON):', text.substring(0, 200));
      }
    } catch(e) { console.log('agentrouter: failed to get before balance:', e.message); }

    // 执行签到
    let checkinResult = null;
    try {
      const checkinResp = await page.request.post(BASE + '/api/user/checkin', {
        headers: { 'Cookie': cookieStr, 'Accept': 'application/json' }
      });
      console.log('agentrouter: checkin status:', checkinResp.status());
      const text = await checkinResp.text();
      if (checkinResp.headers()['content-type']?.includes('json')) {
        checkinResult = JSON.parse(text);
        console.log('agentrouter: checkin result:', JSON.stringify(checkinResult));
      } else {
        console.log('agentrouter: checkin response (not JSON):', text.substring(0, 200));
      }
    } catch(e) { console.log('agentrouter: checkin error:', e.message); }

    // 获取 after balance
    let afterBalance = null;
    try {
      const infoResp2 = await page.request.get(BASE + '/api/user/info', {
        headers: { 'Cookie': cookieStr, 'Accept': 'application/json' }
      });
      console.log('agentrouter: info2 status:', infoResp2.status());
      const text2 = await infoResp2.text();
      if (infoResp2.headers()['content-type']?.includes('json')) {
        const info2 = JSON.parse(text2);
        afterBalance = info2.data?.balance || info2.data?.credits || info2.balance || info2.credits;
        console.log('agentrouter: balance after:', afterBalance);
      } else {
        console.log('agentrouter: info2 response (not JSON):', text2.substring(0, 200));
      }
    } catch(e) { console.log('agentrouter: failed to get after balance:', e.message); }

    // 判断签到成功
    if (checkinResult) {
      if (checkinResult.code === 200 || checkinResult.success === true ||
          (checkinResult.message && checkinResult.message.includes('成功'))) {
        checkinSuccess = true;
        console.log('agentrouter: checkin successful');
      }
    }
    if (beforeBalance !== null && afterBalance !== null) {
      const diff = afterBalance - beforeBalance;
      console.log('agentrouter: balance change:', diff);
      if (diff >= 25) {
        checkinSuccess = true;
        console.log('agentrouter: balance increased by', diff, '-> success!');
      }
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

module.exports = { run };
