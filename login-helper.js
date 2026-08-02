const {chromium} = require('playwright');
const fs = require('fs');

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// 方案：用 msedge headless 访问 anyrouter，完成 Cloudflare challenge
// 然后引导用户完成 GitHub OAuth（在可见浏览器中）
// 关键：OAuth 完成后自动检测并保存 cookies
(async () => {
  const browser = await chromium.launch({headless: false, channel: 'msedge'});
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  });
  const page = await ctx.newPage();

  console.log('=== anyrouter 自动登录助手 ===');
  console.log('1. 正在绕过 Cloudflare...');
  await page.goto('https://anyrouter.top/', {waitUntil:'networkidle', timeout:30000});
  await sleep(3000);
  console.log('   Cloudflare 已绕过，URL:', page.url());

  console.log('2. 正在打开 GitHub OAuth...');
  await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('GitHub'));
    if (btn) btn.click();
  });
  await sleep(5000);

  console.log('3. 请在打开的 GitHub 页面中完成登录/授权...');
  console.log('   （如果已登录 GitHub，会自动授权）');
  console.log('');

  // 等待 OAuth 完成
  let loggedIN = false;
  for (let i = 0; i < 180; i++) {
    await sleep(2000);
    const anyrouterPages = ctx.pages().filter(p => p.url().includes('anyrouter.top'));
    for (const p of anyrouterPages) {
      const url = p.url();
      if (!url.includes('login') && !url.includes('oauth') && !url.includes('github')) {
        console.log('   OAuth 完成! URL:', url);
        loggedIN = true;
        
        // Do checkin
        const cr = await p.evaluate(async () => {
          try { const r = await fetch('/api/user/checkin', {method:'POST'}); return await r.json(); }
          catch(e) { return {error: e.message}; }
        });
        console.log('   Checkin:', JSON.stringify(cr));
        break;
      }
    }
    if (loggedIN) break;
    
    // Check if GitHub OAuth page got the user's session
    const oauthPage = ctx.pages().find(p => p.url().includes('github.com'));
    if (oauthPage && i % 5 === 0) {
      const text = await oauthPage.locator('body').innerText().catch(() => '');
      if (text.includes('Sign out') || text.includes('退出')) {
        console.log('   GitHub 已登录，等待授权...');
      }
    }
    
    if (i % 6 === 0) console.log('   等待中... ' + (i*2) + 's');
  }

  if (!loggedIN) {
    console.log('   超时。请确保在 GitHub 页面完成登录和授权。');
  }

  // Save cookies
  const cookies = await ctx.cookies('https://anyrouter.top');
  const all = JSON.parse(fs.readFileSync('I:/Codex/web auto/cookies.json', 'utf8'));
  all.anyrouter = cookies;
  fs.writeFileSync('I:/Codex/web auto/cookies.json', JSON.stringify(all, null, 2), 'utf8');
  console.log('');
  console.log('Cookies saved:', cookies.length, 'cookies');
  console.log('Session expires:', cookies.find(c => c.name === 'session') 
    ? new Date(cookies.find(c => c.name === 'session').expires * 1000).toLocaleString('zh-CN') 
    : 'none');

  await browser.close();
  console.log('');
  console.log('现在可以运行: node auto.js');
})();
