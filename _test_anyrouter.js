const {chromium} = require('playwright');
const fs = require('fs');

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Test: What does the GitHub OAuth page look like?
// Does it have the user's GitHub session?
(async () => {
  const browser = await chromium.launch({headless: false, channel: 'msedge'});
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  });
  const page = await ctx.newPage();
  
  // Get CF cookies first
  await page.goto('https://anyrouter.top/', {waitUntil:'networkidle', timeout:30000});
  await sleep(2000);
  
  // Add saved session cookie
  const saved = JSON.parse(fs.readFileSync('I:/Codex/web auto/cookies.json', 'utf8'));
  if (saved.anyrouter?.length) await ctx.addCookies(saved.anyrouter);
  
  // Click GitHub button
  await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('GitHub'));
    if (btn) btn.click();
  });
  await sleep(5000);
  
  // Check all pages
  console.log('Pages:');
  for (const p of ctx.pages()) {
    console.log('  ' + p.url().substring(0, 100));
  }
  
  const oauthPage = ctx.pages().find(p => p.url().includes('github.com'));
  if (oauthPage) {
    console.log('\nOAuth page title:', await oauthPage.title());
    const text = await oauthPage.locator('body').innerText();
    console.log('Has signout:', text.includes('Sign out') || text.includes('退出'));
    console.log('Has signin:', text.includes('Sign in') || text.includes('登录'));
    console.log('First 200 chars:', text.substring(0, 200));
  }
  
  await browser.close();
})();
