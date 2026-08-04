// login-helper.js - Manual login helper for agentrouter/anyrouter (GitHub OAuth)
var fs = require('fs');
var p = require('playwright').chromium;
var os = require('os');
var path = require('path');

const site = process.argv[2];
if (!site) { console.log('Usage: node login-helper.js <agentrouter|anyrouter>'); process.exit(1); }

var profileDir = path.join(os.tmpdir(), 'webauto_' + site + '_' + Date.now());
fs.mkdirSync(profileDir, { recursive: true });

const BASE = site === 'agentrouter' ? 'https://agentrouter.org' : 'https://anyrouter.top';
const key = site;

async function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

(async () => {
  console.log('=== ' + site.toUpperCase() + ' Manual Login ===');
  console.log('Profile:', profileDir);
  console.log('Proxy:', process.env.HTTP_PROXY || 'none');
  console.log('Opening ' + BASE + ' in browser...\n');

  const proxyArg = process.env.HTTP_PROXY ? ['--proxy-server=' + process.env.HTTP_PROXY] : [];
  const ctx = await p.launchPersistentContext(profileDir, {
    headless: false,
    channel: 'msedge',
    args: [...proxyArg, '--disable-blink-features=AutomationControlled'],
    viewport: { width: 1920, height: 1080 }
  });
  const page = ctx.pages()[0] || await ctx.newPage();

  if (site === 'anyrouter') {
    console.log('1. Bypassing Cloudflare...');
    await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 120000 });
    await sleep(12000);
    console.log('   CF passed, URL:', page.url());
    var isLoggedIn = await page.evaluate(function() {
      return window.location.href.indexOf('login') < 0 && window.location.href.indexOf('oauth') < 0;
    });
    if (!isLoggedIn) {
      console.log('2. Clicking GitHub OAuth...');
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

  console.log('\nPlease complete login (GitHub OAuth) in the browser window...\n');

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
    let all = {};
    try { all = JSON.parse(fs.readFileSync('I:/Codex/web auto/cookies.json', 'utf8')); } catch(e) {}
    all[key] = cookies;
    fs.writeFileSync('I:/Codex/web auto/cookies.json', JSON.stringify(all, null, 2), 'utf8');
    console.log('\nCookies saved:', cookies.length, 'for', key);
    const sess = cookies.find(function(c) { return c.name === 'session'; });
    if (sess) console.log('Session expires:', new Date(sess.expires * 1000).toLocaleString('zh-CN'));
  }

  await sleep(2000);
  await ctx.close();
  try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch(e) {}
  console.log('\nDone! Now run: node auto.js');
})();