// sites/agentrouter.js — GitHub OAuth login + checkin
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
  const BASE = 'https://agentrouter.org';
  const email = config.email || process.env.AGENTROUTER_EMAIL || '';
  const password = config.password || process.env.AGENTROUTER_PASSWORD || '';
  const useProxy = process.env.HTTP_PROXY || process.env.all_proxy || '';

  const launchArgs = ['--disable-blink-features=AutomationControlled', '--disable-popup-blocking'];
  if (useProxy) launchArgs.unshift('--proxy-server=' + useProxy);
  launchArgs.push('--ignore-certificate-errors');

  const browser = await chromium.launch({ headless: true, args: launchArgs });
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 }
  });

  const saved = await loadCookies();
  if (saved.agentrouter && saved.agentrouter.length > 0) await ctx.addCookies(saved.agentrouter);

  const page = await ctx.newPage();

  try {
    // Step 1: Pass Cloudflare
    console.log('agentrouter: passing Cloudflare...');
    await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(5000);
    console.log('agentrouter: CF passed, URL:', page.url());

    // Step 2: Try console with saved session
    await page.goto(BASE + '/console/personal', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(3000);
    let url = page.url();
    console.log('agentrouter: console URL:', url);

    if (!url.includes('login')) {
      console.log('agentrouter: already logged in!');
    } else {
      // Step 3: Get OAuth config and navigate to GitHub
      console.log('agentrouter: session expired, using GitHub OAuth...');
      await page.goto(BASE + '/login', { waitUntil: 'domcontentloaded', timeout: 60000 });
      await sleep(3000);
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
      await sleep(3000);

      const clientId = await page.evaluate(async () => {
        const r = await fetch('/api/status', { credentials: 'include' });
        const data = await r.json();
        return data.data.github_client_id;
      });

      const state = await page.evaluate(async () => {
        const r = await fetch('/api/oauth/state?mode=login&provider=github', { credentials: 'include' });
        const data = await r.json();
        return data.data;
      });

      console.log('agentrouter: GitHub client_id:', clientId);
      console.log('agentrouter: OAuth state obtained');

      const redirectUri = BASE + '/oauth/github';
      const githubUrl = 'https://github.com/login/oauth/authorize?client_id=' + clientId + '&redirect_uri=' + encodeURIComponent(redirectUri) + '&state=' + state + '&scope=user:email';
      console.log('agentrouter: opening GitHub OAuth...');

      try {
        const oauthPage = await ctx.newPage();
        await oauthPage.goto(githubUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await sleep(3000);
        console.log('agentrouter: GitHub OAuth URL:', oauthPage.url());
        console.log('agentrouter: Please complete GitHub login in the browser window.');

        // Wait for redirect back to agentrouter
        let logged = false;
        for (let i = 0; i < 120; i++) {
          await sleep(5000);
          const curUrl = oauthPage.url();
          if (curUrl.includes('agentrouter.org') && !curUrl.includes('login') && !curUrl.includes('oauth')) {
            console.log('agentrouter: OAuth complete!');
            logged = true;
            break;
          }
        }

        if (!logged) {
          console.log('agentrouter: OAuth timeout. Cookies may need manual refresh.');
          return { success: false, error: 'oauth_timeout' };
        }

        // Save cookies from OAuth page
        const cookies = await oauthPage.context().cookies(BASE);
        if (cookies.length > 0) {
          const all = await loadCookies();
          all.agentrouter = cookies;
          await saveCookies(all);
          console.log('agentrouter: cookies saved:', cookies.length);
        }
      } catch (oauthErr) {
        console.log('agentrouter: GitHub OAuth navigation failed (likely proxy SSL error):', oauthErr.message);
        console.log('agentrouter: On GitHub Actions (no proxy), this should work. Manual login recommended for now.');
        return { success: false, error: 'oauth_ssl_error' };
      }
    }

    // Step 4: Check in
    console.log('agentrouter: checking in...');
    const cr = await page.evaluate(async () => {
      try {
        const r = await fetch('/api/user/checkin', { method: 'POST' });
        return await r.json();
      } catch(e) { return { error: e.message }; }
    });
    console.log('agentrouter: checkin result:', JSON.stringify(cr));

    // Save cookies
    const cookies = await ctx.cookies(BASE);
    if (cookies.length > 0) {
      const all = await loadCookies();
      all.agentrouter = cookies;
      await saveCookies(all);
      console.log('agentrouter: cookies saved:', cookies.length);
    }
    console.log('agentrouter: done');
    return { success: true, checkin: cr };
  } catch (e) {
    console.error('agentrouter error:', e.message);
    return { success: false, error: e.message };
  } finally {
    await page.close();
    await browser.close();
  }
}

module.exports = { run };
