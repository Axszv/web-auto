const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function randomReason() {
  const reasons = [
    'Daily automation check-in for coding tool testing and usage verification',
    'Automated daily verification for developer productivity platform access',
    'Routine daily authentication verification and account status confirmation'
  ];
  return reasons[Math.floor(Math.random() * reasons.length)];
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
  const email = config.email || process.env.SHAREDCHAT_EMAIL || '504740633@qq.com';
  const password = config.password || process.env.SHAREDCHAT_PASSWORD || 'LZ37265981^';
  const BASE = 'https://new.sharedchat.cc';

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  });

  const saved = await loadCookies();
  if (saved.sharedchat && saved.sharedchat.length > 0) await ctx.addCookies(saved.sharedchat);

  const page = await ctx.newPage();

  try {
    // Go to dashboard directly to see if logged in
    console.log('sharedchat: loading dashboard...');
    await page.goto(BASE + '/list/#/vibe-code/dashboard?activeMenu=dashboard&service=codex', {
      waitUntil: 'domcontentloaded', timeout: 30000
    });
    await sleep(2000);
    let url = page.url();
    console.log('sharedchat URL:', url);

    // If redirected to login, we need to log in
    if (url.includes('login') || url.includes('sign')) {
      console.log('sharedchat: need to log in');
      await page.goto(BASE + '/list/', { waitUntil: 'domcontentloaded', timeout: 30000 });
      await sleep(2000);
      url = page.url();
      console.log('sharedchat login page URL:', url);

      // Check page content to find login form
      const pageText = await page.evaluate(() => document.body.innerText);
      console.log('sharedchat page text:', pageText.substring(0, 200));

      // Try different selectors for the login button
      let loginBtn = null;
      const loginSelectors = [
        'span:has-text("用户登录")',
        'button:has-text("用户登录")',
        'text=用户登录',
        '[class*="login"]'
      ];
      for (const sel of loginSelectors) {
        try {
          const el = page.locator(sel).first();
          if (await el.count() > 0) {
            loginBtn = el;
            console.log('sharedchat: found login via', sel);
            break;
          }
        } catch (e) { /* try next */ }
      }

      if (loginBtn) {
        await loginBtn.click();
        await sleep(1000);
        const inputs = await page.locator('input').all();
        if (inputs.length >= 2) {
          await inputs[0].fill(email);
          await inputs[1].fill(password);
          // Submit
          await page.evaluate(() => {
            const btn = Array.from(document.querySelectorAll('button')).find(b => b.textContent && b.textContent.includes('登录'));
            if (btn) btn.click();
          });
        }
      } else {
        // Maybe already on login form, try filling inputs directly
        console.log('sharedchat: no login button found, trying direct fill');
        const inputs = await page.locator('input[type="text"], input[type="email"], input').all();
        if (inputs.length >= 2) {
          await inputs[0].fill(email);
          await inputs[1].fill(password);
          await page.evaluate(() => {
            const btn = Array.from(document.querySelectorAll('button')).find(b => b.textContent && b.textContent.includes('登录'));
            if (btn) btn.click();
          });
        }
      }
      await sleep(3000);
      url = page.url();
      console.log('sharedchat after login:', url);

      // If still on login page, login failed
      if (url.includes('login') || url.includes('sign')) {
        console.log('sharedchat: login failed or session expired');
        return { success: false, error: 'login_failed' };
      }
    }

    // Now on dashboard, try to find and click claim button
    console.log('sharedchat: looking for claim button...');
    let claimed = false;

    // Try clicking the claim button
    const claimBtn = page.locator('text=领取Codex权益').or(page.locator('text=领取 Codex 权益')).or(page.locator('text=领取'));
    if (await claimBtn.count() > 0) {
      console.log('sharedchat: clicking claim button');
      await claimBtn.click({ force: true });
      await sleep(3000);
      console.log('sharedchat: after claim click, URL:', page.url());
      claimed = true;
    } else {
      console.log('sharedchat: claim button not found, checking page state');
      // Check if already claimed by looking at page text
      const pageText = await page.evaluate(() => document.body.innerText);
      if (pageText.includes('已达上限') || pageText.includes('已领取')) {
        console.log('sharedchat: already claimed today');
        claimed = true;
      }
    }

    // Save cookies
    const cookies = await ctx.cookies(BASE);
    if (cookies.length > 0) {
      const all = await loadCookies();
      all.sharedchat = cookies;
      await saveCookies(all);
      console.log('sharedchat cookies saved:', cookies.length);
    }

    console.log('All done for sharedchat.cc');
    return { success: true };
  } catch (e) {
    console.error('sharedchat Error:', e.message);
    return { success: false, error: e.message };
  } finally {
    await page.close();
    await browser.close();
  }
}

module.exports = { run };
