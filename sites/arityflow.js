// sites/arityflow.js — qd.arityflow.top 每日签到（账号密码登录 + 图片验证码）
// 流程：登录拿 token → 读签到状态 → 若已签直接返回 → 请求验证码 → ddddocr 识别 → 提交签到
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const SITE = 'arityflow';
const BASE = 'https://qd.arityflow.top';

// 读取账号密码（环境变量优先，兼容 GitHub secret）
function getCreds(config) {
  const username = config.username || process.env.ARITYFLOW_USER;
  const password = config.password || process.env.ARITYFLOW_PASSWORD;
  const code = config.code || process.env.ARITYFLOW_CODE || 'kfcvvo50';
  if (!username || !password) throw new Error('ARITYFLOW_USER/ARITYFLOW_PASSWORD env required');
  return { username, password, code };
}

// 调用 Python ddddocr 识别验证码图片，返回 4 位文本
async function ocrCaptcha(imgPath) {
  const script = path.join(__dirname, '..', 'lib', 'captcha_ocr.py');
  const venvPy = path.join(__dirname, '..', 'venv', 'bin', 'python');
  const py = fs.existsSync(venvPy) ? venvPy : (process.env.PYTHON || 'python3');
  const out = execFileSync(py, [script, imgPath], { encoding: 'utf8', timeout: 60000 }).trim();
  return out;
}

async function run(config = {}) {
  const { username, password, code } = getCreds(config);

  console.log(SITE + ': start');
  // 原生 fetch 走 HTTP 流程（无代理）
  const j = async (method, path, body, token) => {
    const headers = { 'Content-Type': 'application/json', 'Accept': 'application/json' };
    if (token) headers['Authorization'] = 'Bearer ' + token;
    const r = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const text = await r.text();
    let json; try { json = JSON.parse(text); } catch { json = null; }
    return { status: r.status, json, text };
  };

  try {
    // 1. 登录
    const login = await j('POST', '/api/auth/login', { username, password });
    if (!login.json || !login.json.token) {
      throw new Error('login failed: ' + (login.text || '').slice(0, 200));
    }
    const token = login.json.token;
    console.log(SITE + ': logged in');

    // 2. 读签到状态
    const status = await j('GET', '/api/checkin/status', null, token);
    const st = status.json;
    if (!st) throw new Error('status failed: ' + (status.text || '').slice(0, 200));
    console.log(SITE + ': status=' + JSON.stringify(st));
    if (st.checked_today === true) {
      console.log(SITE + ': already checked in today');
      return { success: true, checkinSuccess: true, already: true, reward: st.today_reward };
    }

    // 3. 请求验证码并识别（最多重试 5 次）
    let checkedIn = null;
    for (let attempt = 1; attempt <= 5 && !checkedIn; attempt++) {
      // 3a. 拿验证码
      const cap = await j('GET', '/api/captcha', null, token);
      const cj = cap.json;
      if (!cj || !cj.captcha_id) { throw new Error('captcha failed: ' + (cap.text || '').slice(0, 150)); }

      // 3b. 下载图片
      const imgPath = path.join(__dirname, '..', '.qd_captcha_' + attempt + '.jpg');
      const imgResp = await fetch(cj.image_url);
      const imgBuf = Buffer.from(await imgResp.arrayBuffer());
      fs.writeFileSync(imgPath, imgBuf);

      // 3c. OCR
      const answer = await ocrCaptcha(imgPath);
      fs.rmSync(imgPath, { force: true });
      console.log(SITE + ': attempt ' + attempt + ' ocr=' + answer);

      // 3d. 提交签到
      const ci = await j('POST', '/api/checkin', { code, captcha_id: cj.captcha_id, captcha_answer: answer, cf_token: '' }, token);
      if (ci.status === 200 && ci.json && ci.json.reward !== undefined) {
        checkedIn = ci.json;
        console.log(SITE + ': checkin success ' + JSON.stringify(ci.json));
      } else {
        console.log(SITE + ': attempt ' + attempt + ' failed: ' + (ci.text || '').slice(0, 150));
        await sleep(1500);
      }
    }

    if (checkedIn) {
      return { success: true, checkinSuccess: true, reward: checkedIn.reward };
    }
    console.log(SITE + ': checkin FAILED after 5 attempts');
    return { success: true, checkinSuccess: false };
  } catch (e) {
    console.error(SITE + ': error:', e.message);
    return { success: false, error: e.message };
  }
}

module.exports = { run };