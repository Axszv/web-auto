// lib/baseline.js — 跨运行持久化「上次 quota 基线」，存于私有 gist
// 环境变量：GIST_ID（gist 数字 id）、GIST_TOKEN（gist scope 的 PAT）
// 未配置或读写失败时降级为 null（当天判定退化为「登录成功即建立基线」），不影响登录/签到本身
const https = require('https');

const FILE = 'quota-baseline.json';

function api(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = https.request({
      hostname: 'api.github.com',
      path,
      method,
      headers: {
        'User-Agent': 'web-auto',
        'Accept': 'application/vnd.github+json',
        'Authorization': 'Bearer ' + token,
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {})
      }
    }, res => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => resolve({ status: res.statusCode, body: buf }));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function readAll() {
  const id = process.env.GIST_ID, token = process.env.GIST_TOKEN;
  if (!id || !token) return null;
  try {
    const r = await api('GET', '/gists/' + id, null, token);
    if (r.status !== 200) return null;
    const gist = JSON.parse(r.body);
    const f = gist.files && gist.files[FILE];
    if (!f || !f.content) return {};
    return JSON.parse(f.content);
  } catch { return null; }
}

async function writeAll(obj) {
  const id = process.env.GIST_ID, token = process.env.GIST_TOKEN;
  if (!id || !token) return false;
  try {
    const r = await api('PATCH', '/gists/' + id, { files: { [FILE]: { content: JSON.stringify(obj, null, 2) } } }, token);
    return r.status === 200;
  } catch { return false; }
}

async function get(site) {
  const all = await readAll();
  if (!all) return null;
  const v = all[site];
  return typeof v === 'number' ? v : null;
}

async function set(site, quota) {
  const all = (await readAll()) || {};
  all[site] = quota;
  return await writeAll(all);
}

module.exports = { get, set };
