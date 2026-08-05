// sites/agentrouter.js - GitHub OAuth login + checkin
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
  const useProxy = process.env.HTTP_PROXY || process.env.ALL_PROXY || '';

  const launchArgs = ['--disable-blink-features=AutomationControlled', '--disable-popup-blocking'];
  if (useProxy) launchArgs.unshift('--proxy-server=' + useProxy);
  

  const browser = await chromium.launch({ headless: true, args: launchArgs });
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 }
  });

  const saved = await loadCookies();
  if (saved.agentrouter && saved.agentrouter.length > 0) {
    console.log('agentrouter: loading saved session cookies...');
    await ctx.addCookies(saved.agentrouter);
  }

  // Mock APIs for OAuth flow
  await ctx.route(/.*api.*/, route => {
    const url = route.request().url();
    if (url.includes('/api/status')) {
      route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({
          data: { github_oauth: true, github_client_id: 'Ov23lidtiR4LeVZvVRNL', linuxdo_oauth: true, system_name: 'Agent Router', setup: true },
          success: true
        })
      });
    } else if (url.includes('/api/oauth/state')) {
      route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ data: 'auto_generated_state', success: true })
      });
    } else if (url.includes('/api/notice')) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: [], success: true }) });
    } else {
      route.continue();
    }
  });

  const page = await ctx.newPage();

  try {
    console.log('agentrouter: visiting main page...');
    await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(5000);
    console.log('agentrouter: URL:', page.url());

    // Check if already logged in
    if (!page.url().includes('login')) {
      console.log('agentrouter: already logged in!');
    } else {
      // Get OAuth state and navigate to GitHub
      console.log('agentrouter: session expired, using GitHub OAuth...');
      await page.goto(BASE + '/login', { waitUntil: 'domcontentloaded', timeout: 60000 });
      await sleep(3000);

      const state = await page.evaluate(async () => {
        const r = await fetch('/api/oauth/state?mode=login&provider=github', { credentials: 'include' });
        const d = await r.json();
        return d.data;
      });
      console.log('agentrouter: OAuth state obtained');

      const githubUrl = 'https://github.com/login/oauth/authorize?client_id=Ov23lidtiR4LeVZvVRNL&redirect_uri=https://agentrouter.org/oauth/github&state=' + state + '&scope=user:email';
      console.log('agentrouter: navigating to GitHub OAuth...');
      await page.goto(githubUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

      // Wait for OAuth redirect
      console.log('agentrouter: waiting for login (10 min timeout)...');
      let logged = false;
      for (let i = 0; i < 120; i++) {
        await sleep(5000);
        const url = page.url();
        if (url.includes('agentrouter.org') && !url.includes('login') && !url.includes('oauth') && !url.includes('github.com')) {
          console.log('agentrouter: login detected!');
          logged = true;
          break;
        }
      }

      if (!logged) {
        console.log('agentrouter: OAuth timeout. Run: node login-helper.js agentrouter');
        return { success: false, error: 'oauth_timeout' };
      }
    }

    // Check in
    await page.goto(BASE + '/console/personal', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(3000);
    console.log('agentrouter: console URL:', page.url());

    const body = await page.locator('body').innerText();
    const hasBalance = body.includes('当前余额') || body.includes('余额');
    console.log('agentrouter: balance found:', hasBalance);

    const cr = await page.evaluate(async () => {
      try {
        const r = await fetch('/api/user/checkin', { method: 'GET', credentials: 'include' });
        return await r.json();
      } catch (e) { return { error: e.message }; }
    });
    console.log('agentrouter: checkin:', JSON.stringify(cr));

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