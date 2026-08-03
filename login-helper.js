const { chromium } = require('playwright');
const fs = require('fs');

async function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

const site = process.argv[2];
if (!site) { console.log('Usage: node login-helper.js <agentrouter|anyrouter>'); process.exit(1); }

const BASE = site === 'agentrouter' ? 'https://agentrouter.org' : 'https://anyrouter.top';
const key = site;

(async () => {
  console.log('=== ' + site.toUpperCase() + ' Manual Login ===');
  console.log('Opening ' + BASE + ' in browser...');
  console.log('Please complete login (OAuth or username/password).');
  console.log('This window will close automatically after login.\n');

  const browser = await chromium.launch({ headless: false, channel: 'msedge', args: ['--proxy-server=http://127.0.0.1:10808'] });
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 }
  });

  const page = await ctx.newPage();

  if (site === 'anyrouter') {
    console.log('1. Bypassing Cloudflare...');
    await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 90000 });
    await sleep(8000);
    console.log('   CF passed, URL:', page.url());

    console.log('2. Opening GitHub OAuth...');
    await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('GitHub'));
      if (btn) btn.click();
    });
    await sleep(5000);
  } else {
    console.log('1. Opening login page...');
    await page.goto(BASE + '/login', { waitUntil: 'domcontentloaded', timeout: 30000 });
    console.log('   Page loaded. Please login now.');
  }

  console.log('\n2. Please complete login in the browser window...');
  console.log('   (If already logged into GitHub, it will auto-authorize)\n');

  // Wait for login
  let loggedIN = false;
  while (!loggedIN) {
    await sleep(2000);
    const url = page.url();
    if (!url.includes('login') && !url.includes('oauth') && !url.includes('github.com') && !url.includes('authorize')) {
      console.log('   Login detected! URL:', url);
      loggedIN = true;
    }
  }

  // Navigate to console
  await page.goto(BASE + '/console/personal', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(2000);
  console.log('Console URL:', page.url());
  console.log('Title:', await page.title());

  if (!page.url().includes('login')) {
    try {
      const cr = await page.evaluate(async () => {
        try { const r = await fetch('/api/user/checkin', { method: 'POST' }); return await r.json(); }
        catch(e) { return { error: e.message }; }
      });
      console.log('Checkin:', JSON.stringify(cr));
    } catch(e) { console.log('Checkin error:', e.message); }
  }

  // Save cookies
  const cookies = await ctx.cookies(BASE);
  if (cookies.length > 0) {
    const all = JSON.parse(fs.readFileSync('I:/Codex/web auto/cookies.json', 'utf8'));
    all[key] = cookies;
    fs.writeFileSync('I:/Codex/web auto/cookies.json', JSON.stringify(all, null, 2), 'utf8');
    console.log('\nCookies saved:', cookies.length, 'for', key);
    const sess = cookies.find(c => c.name === 'session');
    if (sess) console.log('Session expires:', new Date(sess.expires * 1000).toLocaleString('zh-CN'));
  }

  await sleep(2000);
  await browser.close();
  console.log('\nDone! Now run: node auto.js');
})();