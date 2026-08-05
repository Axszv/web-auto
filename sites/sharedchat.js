// sites/sharedchat.js
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

async function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

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

  // Try msedge first, fall back to built-in chromium
  let browser;
  try {
    browser = await chromium.launch({ headless: true, channel: 'msedge', args: [process.env.HTTP_PROXY ? "--proxy-server=" + process.env.HTTP_PROXY : ""] });
    console.log('sharedchat: using msedge channel');
  } catch (e) {
    console.log('sharedchat: msedge not available, using built-in chromium');
    browser = await chromium.launch({ headless: true, args: ['--disable-blink-features=AutomationControlled'] });
  }

  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  });

  // Clear old cookies to avoid CF blocking from expired sessions
  const saved = await loadCookies();
  if (saved.sharedchat && saved.sharedchat.length > 0) {
    console.log('sharedchat: clearing old cookies...');
    await ctx.clearCookies();
  }

  const page = await ctx.newPage();

  try {
    // Step 1: Visit main page without cookies to pass Cloudflare
    console.log('sharedchat: visiting main page...');
    await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 120000 });
    await sleep(10000);
    console.log('sharedchat: main URL:', page.url());

    // Step 2: Navigate to list page
    await page.goto(BASE + '/list/', { waitUntil: 'domcontentloaded', timeout: 120000 });
    await sleep(8000);
    var url = page.url();
    console.log('sharedchat: list URL:', url);

    // Check if on Cloudflare page
    const onCF = await page.evaluate(() => document.title.includes('Cloudflare'));
    if (onCF) {
      console.log('sharedchat: Cloudflare challenge detected');
      const btn = page.locator('#cf-footer-ip-reveal');
      if (await btn.count() > 0) {
        await btn.click();
        await sleep(8000);
        console.log('sharedchat: after CF click, URL:', page.url());
      }
      if (page.url().includes('Cloudflare') || page.url().includes('checking')) {
        console.log('sharedchat: CF block persists, need manual login');
        return { success: false, error: 'cloudflare_block' };
      }
    }

    // Step 3: Check if logged in
    url = page.url();
    if (url.includes('login') || url.includes('sign')) {
      console.log('sharedchat: need login');
      // Wait for form
      await page.waitForSelector('input[type=\"email\"], input[type=\"text\"], input[type=\"password\"]', { timeout: 15000 }).catch(() => {});
      await sleep(1000);
      var inputs = await page.locator('input').all();
      if (inputs.length >= 2) {
        await inputs[0].fill(email);
        await inputs[1].fill(password);
        var loginBtn = page.locator('button.el-button');
        if (await loginBtn.count() > 0) await loginBtn.first().click();
        await sleep(6000);
        console.log('sharedchat: login URL:', page.url());
      }
    } else {
      console.log('sharedchat: already logged in (cookie reused)');
    }

    // Step 4: Click claim button
    console.log('sharedchat: looking for claim button...');
    var claimResult = await page.evaluate(function() {
      var btns = Array.from(document.querySelectorAll('button'));
      var claimBtn = btns.find(function(b) { return (b.textContent || '').trim() === '领取 Codex 权益'; });
      if (!claimBtn) return { error: 'claim button not found' };
      claimBtn.click();
      return { clicked: true };
    });
    console.log('sharedchat claim click:', JSON.stringify(claimResult));

    await sleep(3000);

    // Step 5: Fill reason and submit
    console.log('sharedchat: filling reason...');
    var modalResult = await page.evaluate(function() {
      var ta = Array.from(document.querySelectorAll('textarea'));
      for (var i = 0; i < ta.length; i++) {
        if (ta[i].offsetParent !== null) {
          var today = new Date().toISOString().slice(0, 10);
          var reason = today + '-UseCodexDaily-' + Math.floor(Math.random() * 99999);
          ta[i].value = reason;
          ta[i].dispatchEvent(new Event('input', { bubbles: true }));
          ta[i].dispatchEvent(new Event('change', { bubbles: true }));
          var btns = Array.from(document.querySelectorAll('button'));
          for (var j = 0; j < btns.length; j++) {
            var t = (btns[j].textContent || '').trim();
            if ((t === '领取' || t === '确认') && btns[j].offsetParent !== null) {
              var rect = btns[j].getBoundingClientRect();
              if (rect.top < 900) { btns[j].click(); return { reason: reason, submitted: true }; }
            }
          }
          return { reason: reason, submitted: false, error: 'no submit button in modal' };
        }
      }
      return { error: 'no textarea found' };
    });
    console.log('sharedchat modal result:', JSON.stringify(modalResult));
    await sleep(6000);

    // Step 6: Check result
    var body = await page.locator('body').innerText();
    var hasClaimed = body.includes('已领取');
    var hasExpired = body.includes('已过期');
    var claimBtnText = await page.evaluate(function() {
      var btns = Array.from(document.querySelectorAll('button'));
      var btn = btns.find(function(b) { return (b.textContent || '').trim().indexOf('领取') >= 0 && b.offsetParent !== null; });
      return btn ? btn.textContent.trim() : 'none';
    });
    console.log('sharedchat: hasClaimed=' + hasClaimed + ', hasExpired=' + hasExpired + ', btnText=' + claimBtnText);

    if (hasExpired) {
      console.log('sharedchat: WARNING - Codex plan expired!');
    } else if (hasClaimed || claimBtnText !== '领取 Codex 权益') {
      console.log('sharedchat: SUCCESS - claimed today!');
    } else {
      console.log('sharedchat: claim may have failed');
    }

    // Save cookies
    var cookies = await ctx.cookies(BASE);
    if (cookies.length > 0) {
      var all = await loadCookies();
      all.sharedchat = cookies;
      await saveCookies(all);
      console.log('sharedchat: cookies saved:', cookies.length);
    }
    console.log('sharedchat: done');
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
