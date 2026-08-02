// login-helper.js — Manual login helper for sites blocked by WAF
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function loadCookies() {
  const f = path.join(__dirname, 'cookies.json');
  if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8'));
  return {};
}

async function saveCookies(data) {
  fs.writeFileSync(path.join(__dirname, 'cookies.json'), JSON.stringify(data, null, 2), 'utf8');
}

const site = process.argv[2];
if (!site) { console.log('Usage: node login-helper.js <agentrouter|anyrouter>'); process.exit(1); }

const BASE = site === 'agentrouter' ? 'https://agentrouter.org' : 'https://anyrouter.top';
const key = site;

(async () => {
  console.log('=== ' + site.toUpperCase() + ' Manual Login ===');
  console.log('Opening', BASE, 'in browser...');
  console.log('Please complete login (OAuth or username/password).');
  console.log('This window will close automatically after login.\n');

  const browser = await chromium.launch({ headless: false, channel: 'msedge' });
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 }
  });

  const page = await ctx.newPage();
  
  // For anyrouter, try OAuth first; for agentrouter, use regular login
  if (site === 'anyrouter') {
    await page.goto(BASE + '/oauth/github', { waitUntil: 'networkidle', timeout: 30000 });
  } else {
    await page.goto(BASE + '/login', { waitUntil: 'networkidle', timeout: 30000 });
  }
  console.log('Page loaded. Please login now.');

  // Wait for login by polling URL
  for (let i = 0; i < 300; i++) {
    await sleep(2000);
    const url = page.url();
    if (!url.includes('login') && !url.includes('oauth') && !url.includes('github.com') && !url.includes('authorize')) {
      console.log('Login detected! URL:', url);
      break;
    }
    if (i % 5 === 0) console.log('Waiting for login... ' + (i * 2) + 's elapsed');
  }

  // Navigate to console and verify
  await page.goto(BASE + '/console/personal', { waitUntil: 'networkidle', timeout: 30000 });
  await sleep(2000);
  console.log('Console URL:', page.url());
  console.log('Title:', await page.title());

  if (!page.url().includes('login')) {
    // Do checkin
    const cr = await page.evaluate(async () => {
      try { const r = await fetch('/api/user/checkin', { method: 'POST' }); return await r.json(); }
      catch(e) { return { error: e.message }; }
    });
    console.log('Checkin:', JSON.stringify(cr));
  }

  // Save cookies
  const cookies = await ctx.cookies(BASE);
  if (cookies.length > 0) {
    const all = await loadCookies();
    all[key] = cookies;
    await saveCookies(all);
    console.log('Cookies saved:', cookies.length, 'for', key);
  }

  await sleep(2000);
  await browser.close();
  console.log('\nDone! Now run: node auto.js');
})();
