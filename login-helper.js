var fs = require('fs');
var p = require('playwright').chromium;
var profileDir = fs.readFileSync('I:/Codex/web auto/_temp_profile.txt', 'utf8').trim();

async function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

const site = process.argv[2];
if (!site) { console.log('Usage: node login-helper.js <agentrouter|anyrouter>'); process.exit(1); }

const BASE = site === 'agentrouter' ? 'https://agentrouter.org' : 'https://anyrouter.top';
const key = site;

(async () => {
  console.log('=== ' + site.toUpperCase() + ' Manual Login ===');
  console.log('Profile:', profileDir);
  console.log('Opening ' + BASE + ' in browser...\n');

  const ctx = await p.launchPersistentContext(profileDir, {
    headless: false,
    channel: 'msedge',
    args: ['--proxy-server=http://127.0.0.1:10808'],
    viewport: { width: 1920, height: 1080 }
  });
  const page = ctx.pages()[0] || await ctx.newPage();

  if (site === 'anyrouter') {
    console.log('1. Bypassing Cloudflare...');
    await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 120000 });
    await sleep(10000);
    console.log('   CF passed, URL:', page.url());
    var isLoggedIn = await page.evaluate(function() {
      return window.location.href.indexOf('login') < 0 && window.location.href.indexOf('oauth') < 0;
    });
    if (!isLoggedIn) {
      console.log('2. Clicking GitHub...');
      await page.evaluate(function() {
        var btns = Array.from(document.querySelectorAll('button'));
        var btn = btns.find(function(b) { return (b.textContent || '').indexOf('GitHub') >= 0; });
        if (btn) btn.click();
      });
    }
    await sleep(5000);
  } else {
    console.log('1. Opening login...');
    await page.goto(BASE + '/login', { waitUntil: 'domcontentloaded', timeout: 60000 });
    console.log('   Page loaded.');
  }

  console.log('\nPlease complete login in the browser window...\n');

  let loggedIN = false;
  while (!loggedIN) {
    await sleep(2000);
    const url = page.url();
    if (!url.includes('login') && !url.includes('oauth') && !url.includes('github.com') && !url.includes('authorize')) {
      console.log('   Login detected! URL:', url);
      loggedIN = true;
    }
  }

  await page.goto(BASE + '/console/personal', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(3000);
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

  const cookies = await ctx.cookies(BASE);
  if (cookies.length > 0) {
    const all = JSON.parse(fs.readFileSync('I:/Codex/web auto/cookies.json', 'utf8'));
    all[key] = cookies;
    fs.writeFileSync('I:/Codex/web auto/cookies.json', JSON.stringify(all, null, 2), 'utf8');
    console.log('\nCookies saved:', cookies.length, 'for', key);
    const sess = cookies.find(function(c) { return c.name === 'session'; });
    if (sess) console.log('Session expires:', new Date(sess.expires * 1000).toLocaleString('zh-CN'));
  }

  await sleep(2000);
  await ctx.close();
  console.log('\nDone! Now run: node auto.js');
})();