// sites/gogocs.js
const crypto = require("crypto");
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

async function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function solvePow(salt, difficulty, ip, timestamp, originalSignature) {
  const prefix = "" + timestamp + ip + difficulty + salt;
  const threshold = Math.floor(0xffffff / difficulty);
  for (let nonce = 0; nonce < 50000000; nonce++) {
    const hashBuffer = crypto.createHash("sha256").update(prefix + nonce).digest();
    const first3Bytes = (hashBuffer[0] << 16) | (hashBuffer[1] << 8) | hashBuffer[2];
    if (first3Bytes < threshold) return { nonce: String(nonce), timestamp, ip, difficulty, salt, signature: originalSignature };
  }
  return null;
}

async function loadCookies() {
  const f = path.join(__dirname, "..", "cookies.json");
  if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, "utf8"));
  return {};
}

async function saveCookies(data) {
  fs.writeFileSync(path.join(__dirname, "..", "cookies.json"), JSON.stringify(data, null, 2), "utf8");
}

async function loginAndGetCookies(browser, ctx, email, password) {
  const page = await ctx.newPage();
  await page.goto("https://gogocs.xyz/auth/login", { waitUntil: "domcontentloaded", timeout: 60000 });
  await sleep(3000);
  const challenge = await page.evaluate(async () => {
    const r = await fetch("/auth/pow_challenge", { method: "POST" });
    return await r.json();
  });
  await sleep(1000);
  const solution = await solvePow(challenge.salt, challenge.difficulty, challenge.ip, challenge.timestamp, challenge.signature);
  await sleep(1000);
  const loginData = new URLSearchParams({
    email, passwd: password, code: "",
    pow_timestamp: String(solution.timestamp), pow_ip: solution.ip,
    pow_difficulty: String(solution.difficulty), pow_salt: solution.salt,
    pow_signature: solution.signature, pow_nonce: solution.nonce
  });
  const result = await page.evaluate(async (data) => {
    const r = await fetch("/auth/login", {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: data, credentials: "include"
    });
    return await r.json();
  }, loginData.toString());
  await page.close();
  if (result.ret !== 1) throw new Error("Login failed: " + (result.msg || JSON.stringify(result)));
  return await ctx.cookies("https://gogocs.xyz");
}

async function run(config = {}) {
  const email = config.email || process.env.GOGOCS_EMAIL || "504740633@qq.com";
  const password = config.password || process.env.GOGOCS_PASSWORD || "XA531729";
  const BASE = "https://gogocs.xyz";

  const browser = await chromium.launch({ headless: true, args: [process.env.HTTP_PROXY ? "--proxy-server=" + process.env.HTTP_PROXY : ""] });
  const ctx = await browser.newContext({
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
  });

  try {
    const cookies = await loginAndGetCookies(browser, ctx, email, password);
    console.log("Login OK, cookies:", cookies.length);

    const page = await ctx.newPage();

    // Step 1: Handle disable protection page
    await page.goto(BASE + "/user", { waitUntil: "domcontentloaded", timeout: 60000 });
    await sleep(2000);
    if (page.url().includes("disable")) {
      console.log("On disable page, cancelling protection...");
      await page.click(`button:has-text("取消账户保护")`);
      await sleep(5000);
      const okBtn = page.locator(`button:has-text("知道了")`);
      if (await okBtn.count() > 0) await okBtn.click({force:true});
      await sleep(3000);
    }

    // Step 2: Set group via UI interactions
    console.log("Setting group to 延迟优先...");
    await page.goto(BASE + "/user/edit", { waitUntil: "domcontentloaded", timeout: 60000 });
    await sleep(2000);

    // Click the group dropdown button
    await page.click("button#group");
    await sleep(1000);

    // Click the 延迟优先 option (val=3)
    var optionFound = false;
    var opts = await page.locator("a.dropdown-option").all();
    for (const opt of opts) {
      var text = await opt.textContent();
      if (text.includes("延迟优先")) {
        await opt.click();
        console.log("Selected 延迟优先");
        optionFound = true;
        break;
      }
    }
    if (!optionFound) console.log("延迟优先 option not found (may already be set)");

    await sleep(500);

    // Click the submit button - page auto-redirects to /user/edit after 100ms
    await page.click("button#group-update");
    await sleep(4000);
    console.log("Group update submitted, page redirected");

    // Step 3: Verify (page should already be on /user/edit after redirect)
    const currentGroup = await page.evaluate(() => document.getElementById("group")?.value);
    console.log("Current group value:", currentGroup, "(3=延迟优先)");

    // Save cookies
    const finalCookies = await ctx.cookies(BASE);
    const all = await loadCookies();
    all.gogocs = finalCookies;
    await saveCookies(all);
    console.log("gogocs cookies saved:", finalCookies.length);
    console.log("All done for gogocs.xyz");
    return { success: true };
  } catch (e) {
    console.error("gogocs Error:", e.message);
    return { success: false, error: e.message };
  } finally {
    await browser.close();
  }
}

module.exports = { run };