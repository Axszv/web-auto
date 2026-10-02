// scripts/webview-cdp.js — 通过 Chrome DevTools Protocol 驱动 ArityFlow 的 WebView
// 用法（宿主 runner 上执行，需先 adb forward 好端口）：
//   node webview-cdp.js <serial> <pid> <command> [args...]
// commands:
//   status                 打印当前页面状态（登录/首页/广告按钮是否存在）
//   dismiss-tips           关闭"广告权限提示"弹窗
//   login <user> <pass>    填账号密码并提交
//   click-ad               点击「看广告」按钮
//   home-ad-info           读取首页广告剩余次数
const CDP_PORT = 9222;

function httpJson(path) {
  return new Promise((resolve, reject) => {
    require('http').get({ host: '127.0.0.1', port: CDP_PORT, path }, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => {
        try { resolve(JSON.parse(d)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

async function connect() {
  const targets = await httpJson('/json/list');
  const page = targets.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
  if (!page) throw new Error('no page target: ' + JSON.stringify(targets.map(t => t.url)));
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0;
  const pending = new Map();
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id);
      m.error ? p.rej(new Error(m.error.message)) : p.res(m.result);
    }
  };
  const send = (method, params = {}) => new Promise((res, rej) => {
    const i = ++id; pending.set(i, { res, rej });
    ws.send(JSON.stringify({ id: i, method, params }));
  });
  const evaluate = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description || ''));
    return r.result.value;
  };
  await send('Runtime.enable');
  return { ws, send, evaluate };
}

async function main() {
  const [serial, pid, cmd, ...args] = process.argv.slice(2);
  if (!serial || !pid || !cmd) {
    console.error('usage: webview-cdp.js <serial> <pid> <command> [args]');
    process.exit(2);
  }
  // forward devtools socket
  const { execSync } = require('child_process');
  execSync(`adb -s ${serial} forward tcp:${CDP_PORT} localabstract:webview_devtools_remote_${pid}`, { stdio: 'ignore' });

  const { ws, evaluate } = await connect();
  let out;
  switch (cmd) {
    case 'status': {
      out = await evaluate(`(() => ({
        url: location.href,
        hasLogin: !!document.querySelector('input[type=password], input[placeholder*=密码]'),
        hasAdBtn: !!document.querySelector('button.quota-ad-btn'),
        adBtnText: (document.querySelector('button.quota-ad-btn')||{}).innerText || '',
        hasTips: /广告权限提示/.test(document.body.innerText),
        bodySnippet: document.body.innerText.replace(/\\s+/g,' ').slice(0, 200)
      }))()`);
      break;
    }
    case 'dismiss-tips': {
      out = await evaluate(`(() => {
        const b = [...document.querySelectorAll('button, .el-button')].find(x => /知道了/.test(x.innerText));
        if (b) { b.click(); return 'dismissed'; }
        return 'no-tips';
      })()`);
      break;
    }
    case 'login': {
      const [user, pass] = args;
      out = await evaluate(`(() => {
        const setVal = (el, v) => {
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          setter.call(el, v);
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        };
        const inputs = [...document.querySelectorAll('input')];
        if (inputs.length < 2) return 'inputs=' + inputs.length;
        setVal(inputs[0], ${JSON.stringify(user)});
        setVal(inputs[1], ${JSON.stringify(pass)});
        const btn = [...document.querySelectorAll('button')].find(b => /登\\s*录|登录/.test(b.innerText));
        if (!btn) return 'no-submit';
        btn.click();
        return 'submitted';
      })()`);
      break;
    }
    case 'click-ad': {
      out = await evaluate(`(() => {
        const b = document.querySelector('button.quota-ad-btn') || [...document.querySelectorAll('button')].find(x => /看广告/.test(x.innerText));
        if (!b) return 'no-ad-btn';
        b.click();
        return 'clicked:' + (b.innerText || '').replace(/\\s+/g, ' ');
      })()`);
      break;
    }
    case 'home-ad-info': {
      out = await evaluate(`(() => {
        const b = document.querySelector('button.quota-ad-btn') || [...document.querySelectorAll('button')].find(x => /看广告/.test(x.innerText));
        return (b && b.innerText || '').replace(/\\s+/g, ' ');
      })()`);
      break;
    }
    default:
      out = 'unknown command: ' + cmd;
  }
  console.log(typeof out === 'string' ? out : JSON.stringify(out));
  ws.close();
  process.exit(0);
}

main().catch(e => { console.log('CDP_ERR:' + e.message); process.exit(1); });