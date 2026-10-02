const fs = require('fs');
const path = require('path');

const LOG_DIR = path.join(__dirname, 'logs');

async function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function writeLog(log) {
  if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(LOG_DIR, ts + '.log');
  fs.writeFileSync(file, log.join('\n'), 'utf8');
  console.log('Log saved:', file);
}

const sites = [
  { name: 'gogocs', mod: require('./sites/gogocs') },
  { name: 'agentrouter', mod: require('./sites/agentrouter') },
  { name: 'anyrouter', mod: require('./sites/anyrouter') },
  { name: 'arityflow', mod: require('./sites/arityflow') },
];

// SITES 环境变量指定本次只跑哪些站（逗号分隔），供拆分的多个 workflow 复用同一入口
const SITES_FILTER = (process.env.SITES || '').split(',').map(s => s.trim()).filter(Boolean);

// 各站"成功"的定义：
//   gogocs       —— 取消账户保护 + 改分组完成（脚本返回 success:true）
//   agentrouter  —— 签到后余额实际增加（checkinSuccess:true）
//   anyrouter    —— 签到后余额实际增加（checkinSuccess:true）
//   arityflow    —— 签到成功（checkinSuccess:true；含"今日已签"）
function siteSucceeded(name, result) {
  if (!result) return false;
  if (name === 'gogocs') return result.success === true;
  return result.checkinSuccess === true;
}

(async () => {
  const log = [];
  var hadFailure = false;
  const start = Date.now();
  log.push('=== Web Auto Start ===');
  log.push('Time: ' + new Date().toISOString());
  log.push('');

  const toRun = SITES_FILTER.length
    ? sites.filter(s => SITES_FILTER.includes(s.name))
    : sites;
  log.push('Sites this run: ' + toRun.map(s => s.name).join(', '));
  log.push('');

  for (const site of toRun) {
    const cfg = require('./config.json').sites.find(s => s.name === site.name);
    log.push('--- ' + site.name.toUpperCase() + ' ---');
    try {
      const result = await site.mod.run(cfg ? cfg.config : {});
      log.push('Result: ' + JSON.stringify(result));
      // 成功判定按站点语义：gogocs 看取消保护+改组完成，agent/any 看余额是否实际增加
      if (!siteSucceeded(site.name, result)) {
        hadFailure = true;
        log.push('FAIL: ' + site.name + ' did not meet success criteria');
      }
    } catch (e) {
      log.push('Error: ' + e.message);
      hadFailure = true;
      log.push('FAIL: ' + site.name + ' threw');
    }
    log.push('');
    await sleep(1500);
  }

  log.push('=== Done in ' + (Date.now() - start) + 'ms ===');
  const text = log.join('\n');
  console.log(text);
  await writeLog(log);
  if (hadFailure) {
    console.log('\n*** Some sites failed, exiting with error ***');
    process.exit(1);
  }
})();
