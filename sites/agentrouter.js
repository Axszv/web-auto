// sites/agentrouter.js — 尝试多种策略绕过Cloudflare
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

async function trySlideCaptcha(page, maxAttempts = 5) {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      // Look for the slider track
      const track = page.locator('.geetest_track, .fc-button, [class*="geetest"], [class*="slide"], [class*="verification"], [class*="captcha"]').first();
      if (await track.count() > 0) {
        console.log('agentrouter: found captcha slider, attempting...');
        // Get track and handle element positions
        const trackBox = await track.boundingBox();
        if (trackBox) {
          // Try to find the handle/thumb
          const handle = track.locator('.geetest_slider_button, .handle, [class*="handler"], [class*="thumb"]').first();
          if (await handle.count() > 0) {
            // Drag the handle
            const handleBox = await handle.boundingBox();
            if (handleBox) {
              const targetX = trackBox.x + trackBox.width - 10;
              await handle.dragTo(handle, { targetPosition: { x: targetX, y: handleBox.y + handleBox.height / 2 } });
              await sleep(1000);
              console.log('agentrouter: slider attempt', i + 1, 'done');
              return true;
            }
          }
        }
      }

      // Alternative: try to find and interact with any visible slider
      const hasSlider = await page.evaluate(() => {
        const sliders = document.querySelectorAll('[class*="slide"], [class*="geetest"], [class*="captcha"], [class*="verify"]');
        for (const el of sliders) {
          const style = window.getComputedStyle(el);
          if (style.display !== 'none' && el.offsetWidth > 50) return true;
        }
        return false;
      });

      if (!hasSlider) break;

      // Try JavaScript-based slide
      await page.evaluate(() => {
        // Find geetest slider
        const track = document.querySelector('.geetest_track');
        const handler = document.querySelector('.geetest_slider_button') || document.querySelector('.handle');
        if (track && handler) {
          const rect = track.getBoundingClientRect();
          const handlerRect = handler.getBoundingClientRect();
          const startX = handlerRect.left + handlerRect.width / 2;
          const startY = handlerRect.top + handlerRect.height / 2;
          const endX = rect.right - 5;
          const endY = startY;

          // Dispatch mouse events
          const events = [
            { type: 'mousedown', x: startX, y: startY },
            { type: 'mousemove', x: endX, y: endY, buttons: 1 },
            { type: 'mouseup', x: endX, y: endY }
          ];
          for (const e of events) {
            const rect = document.elementFromPoint(e.x, e.y)?.getBoundingClientRect();
            if (rect) {
              const evt = new MouseEvent(e.type, {
                bubbles: true, cancelable: true,
                clientX: e.x, clientY: e.y,
                button: 0, buttons: e.buttons || 0
              });
              document.elementFromPoint(e.x, e.y)?.dispatchEvent(evt);
            }
          }
        }
      });
      await sleep(1500);
    } catch (e) {
      console.log('agentrouter: captcha attempt', i + 1, 'failed:', e.message);
    }
  }
  return false;
}

async function run(config = {}) {
  const GH_USER = config.GH_USER || process.env.GH_USER || '';
  const GH_PASS = config.GH_PASS || process.env.GH_PASS || '';
  const BASE = 'https://agentrouter.org';

  const browser = await firefox.launch({
    headless: false,
    args: ['--no-sandbox']
  });

  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0',
    viewport: { width: 1280, height: 800 },
    locale: 'en-US'
  });

  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
  });

  // 先加载旧cookies
  const saved = await loadCookies();
  if (saved.agentrouter && saved.agentrouter.length > 0) await ctx.addCookies(saved.agentrouter);

  const page = await ctx.newPage();
  page.on('console', msg => console.log('[PAGE]', msg.text().substring(0, 200)));
  page.on('pageerror', err => console.log('[PAGE ERROR]', err.message));

  try {
    console.log('agentrouter: navigating to login...');
    await page.goto(BASE + '/login', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(5000);
    console.log('agentrouter URL:', page.url());

    // Check for Cloudflare verification
    let pageText = await page.evaluate(() => document.body.innerText);
    console.log('agentrouter page text:', pageText.substring(0, 300));

    if (pageText.includes('Access Verification') || pageText.includes('verification') || pageText.includes('sliding')) {
      console.log('agentrouter: Cloudflare verification detected, trying to solve...');
      // Try to find and interact with the captcha
      const solved = await trySlideCaptcha(page);
      if (!solved) {
        // Wait longer and retry
        await sleep(5000);
        pageText = await page.evaluate(() => document.body.innerText);
        console.log('agentrouter after captcha wait:', pageText.substring(0, 300));
      }
    }

    // Check if we passed Cloudflare
    const currentUrl = page.url();
    if (!currentUrl.includes('login') && !currentUrl.includes('verification')) {
      console.log('agentrouter: passed Cloudflare, URL:', currentUrl);
    }

    // Now check for login page content
    pageText = await page.evaluate(() => document.body.innerText);
    console.log('agentrouter page text:', pageText.substring(0, 300));

    const hasGitHubBtn = await page.evaluate(() => !!document.querySelector('[aria-label="github_logo"]'));
    console.log('agentrouter: has GitHub button:', hasGitHubBtn);

    if (hasGitHubBtn) {
      // Click GitHub button
      await page.evaluate(() => {
        const svg = document.querySelector('[aria-label="github_logo"]');
        if (svg) {
          const btn = svg.closest('button') || svg.parentElement?.closest('button');
          if (btn) btn.click();
        }
      });
      await sleep(3000);
      console.log('agentrouter after click, URL:', page.url());

      if (page.url().includes('github.com/login') && GH_USER && GH_PASS) {
        console.log('agentrouter: on GitHub login page');
        await page.locator('input[name="login"]').first().fill(GH_USER);
        await page.locator('input[name="password"]').first().fill(GH_PASS);
        await page.locator('input[type="submit"]').first().click();
        await sleep(2000);
        if (page.url().includes('github.com/login')) {
          console.log('agentrouter: 2FA required');
          await browser.close();
          return { success: false, error: '2fa_required' };
        }
      }

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
    }

    if (!page.url().includes('login')) {
      console.log('agentrouter: logged in!');
      try {
        const cookies = await ctx.cookies(BASE);
        const cookieStr = cookies.map(c => c.name + '=' + c.value).join('; ');
        const resp = await page.request.post(BASE + '/api/user/checkin', {
          headers: { 'Cookie': cookieStr, 'Accept': 'application/json' }
        });
        console.log('agentrouter checkin status:', resp.status());
      } catch(e) {}
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
    console.log('agentrouter done');
    return { success: true };
  } catch (e) {
    console.error('agentrouter error:', e.message);
    await browser.close();
    return { success: false, error: e.message };
  }
}

module.exports = { run };
