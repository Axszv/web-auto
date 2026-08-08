// sites/agentrouter.js — 使用 sing-box VLESS 代理绕过 Cloudflare
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
  const BASE = 'https://agentrouter.org';

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
  console.log('agentrouter: clearing old cookies...');
  await ctx.clearCookies();

  const page = await ctx.newPage();
  page.on('console', msg => console.log('[PAGE]', msg.text().substring(0, 200)));
  page.on('pageerror', err => console.log('[PAGE ERROR]', err.message));

  try {
    console.log('agentrouter: navigating via sing-box proxy...');
    await page.goto(BASE + '/login', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(5000);
    console.log('agentrouter URL:', page.url());

    const pageText = await page.evaluate(() => document.body.innerText);
    console.log('agentrouter page text:', pageText.substring(0, 400));

    let loggedIn = false;

    // 尝试多种方式查找 GitHub 按钮
    let githubBtn = null;

    // 方式1: 通过 aria-label
    githubBtn = page.locator('[aria-label="github_logo"]');
    if (await githubBtn.count() === 0) {
      // 方式2: 通过文本 "Continue with GitHub"
      githubBtn = page.locator('text=Continue with GitHub');
      if (await githubBtn.count() === 0) {
        // 方式3: 通过 SVG 包含 github 字样
        githubBtn = page.locator('svg:has-text("github")');
        if (await githubBtn.count() === 0) {
          // 方式4: 通过类名
          githubBtn = page.locator('.github-logo, [class*="github"]');
        }
      }
    }

    console.log('agentrouter: found GitHub button:', await githubBtn.count());

    if (await githubBtn.count() > 0) {
      console.log('agentrouter: clicking GitHub OAuth button...');
      await githubBtn.first().click();
      await sleep(5000);
      console.log('agentrouter after click, URL:', page.url());

      // 检查是否跳转到 GitHub
      if (page.url().includes('github.com')) {
        console.log('agentrouter: on GitHub page');

        // 如果是登录页，填写凭据
        if (page.url().includes('/login')) {
          console.log('agentrouter: on GitHub login page');
          await page.locator('input[name="login"]').first().fill(GH_USER);
          await page.locator('input[name="password"]').first().fill(GH_PASS);
          await page.locator('input[type="submit"]').first().click();
          await sleep(2000);
          if (page.url().includes('/login')) {
            console.log('agentrouter: 2FA required');
            await browser.close();
            return { success: false, error: '2fa_required' };
          }
        }

        // 等待授权页面
        try {
          await page.waitForURL(u => u.toString().includes('authorize'), { timeout: 15000 });
          console.log('agentrouter: on authorize page');
          const authBtn = page.locator('button[type="submit"], .btn-primary, text=Authorize').first();
          if (await authBtn.count() > 0) {
            await authBtn.click({ force: true });
            console.log('agentrouter: clicked Authorize');
          }
        } catch (e) {
          console.log('agentrouter: did not reach authorize, URL:', page.url());
        }

        await sleep(5000);
        console.log('agentrouter: final URL:', page.url());
        loggedIn = !page.url().includes('login');
      } else {
        console.log('agentrouter: click did not navigate to GitHub, URL:', page.url());
      }
    } else {
      console.log('agentrouter: no GitHub button found, checking if already logged in...');
      // 尝试直接访问控制台
      await page.goto(BASE + '/console', { waitUntil: 'domcontentloaded', timeout: 30000 });
      await sleep(3000);
      loggedIn = !page.url().includes('login');
      console.log('agentrouter: logged in status:', loggedIn, 'URL:', page.url());
    }

    let checkinSuccess = false;
    if (loggedIn) {
      console.log('agentrouter: logged in!');
      try {
        const cookies = await ctx.cookies(BASE);
        const cookieStr = cookies.map(c => c.name + '=' + c.value).join('; ');

        // 获取签到前余额
        let beforeBalance = null;
        try {
          const infoResp = await page.request.get(BASE + '/api/user/info', {
            headers: { 'Cookie': cookieStr, 'Accept': 'application/json' }
          });
          if (infoResp.ok()) {
            const info = await infoResp.json();
            beforeBalance = info.data?.balance || info.data?.credits || info.balance || info.credits;
            console.log('agentrouter: balance before checkin:', beforeBalance);
          }
        } catch(e) {
          console.log('agentrouter: failed to get before balance');
        }

        // 签到
        const resp = await page.request.post(BASE + '/api/user/checkin', {
          headers: { 'Cookie': cookieStr, 'Accept': 'application/json' }
        });
        console.log('agentrouter checkin status:', resp.status());

        let checkinResult = null;
        if (resp.ok()) {
          checkinResult = await resp.json();
          console.log('agentrouter checkin result:', JSON.stringify(checkinResult));
        }

        // 获取签到后余额
        let afterBalance = null;
        try {
          const infoResp2 = await page.request.get(BASE + '/api/user/info', {
            headers: { 'Cookie': cookieStr, 'Accept': 'application/json' }
          });
          if (infoResp2.ok()) {
            const info2 = await infoResp2.json();
            afterBalance = info2.data?.balance || info2.data?.credits || info2.balance || info2.credits;
            console.log('agentrouter: balance after checkin:', afterBalance);
          }
        } catch(e) {
          console.log('agentrouter: failed to get after balance');
        }

        // 判断签到是否成功
        if (checkinResult) {
          if (checkinResult.code === 200 || checkinResult.success === true) {
            checkinSuccess = true;
            console.log('agentrouter: checkin successful (API returned success)');
          }
        }
        if (beforeBalance !== null && afterBalance !== null) {
          const diff = afterBalance - beforeBalance;
          console.log('agentrouter: balance change:', diff);
          if (diff >= 25) {
            checkinSuccess = true;
            console.log('agentrouter: balance increased by', diff, '-> checkin successful!');
          }
        }
      } catch(e) {
        console.log('agentrouter checkin error:', e.message);
      }
    } else {
      console.log('agentrouter: still on login page');
    }

    const cookies = await ctx.cookies(BASE);
    if (cookies.length > 0) {
      const all = await loadCookies();
      all.agentrouter = cookies;
      await saveCookies(all);
      console.log('agentrouter cookies saved:', cookies.length);
    }

    await browser.close();
    console.log('agentrouter done, checkinSuccess:', checkinSuccess);
    return { success: true, checkinSuccess };
  } catch (e) {
    console.error('agentrouter error:', e.message);
    await browser.close();
    return { success: false, error: e.message };
  }
}

module.exports = { run };
