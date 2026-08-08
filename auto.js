const fs = require('fs');
const path = require('path');

const COOKIE_FILE = path.join(__dirname, 'cookies.json');
const LOG_DIR = path.join(__dirname, 'logs');

async function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function loadCookies() {
  if (fs.existsSync(COOKIE_FILE)) {
    return JSON.parse(fs.readFileSync(COOKIE_FILE, 'utf8'));
  }
  return {};
}

async function saveCookies(data) {
  fs.writeFileSync(COOKIE_FILE, JSON.stringify(data, null, 2), 'utf8');
}

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
];

(async () => {
  const log = [];
  var hadFailure = false;
  var allCheckinSuccess = true;
  const start = Date.now();
  log.push('=== Web Auto Start ===');
  log.push('Time: ' + new Date().toISOString());
  log.push('');

  const cookieData = await loadCookies();
  log.push('Loaded cookies: ' + Object.keys(cookieData).join(', ') || 'none');
  log.push('');

  for (const site of sites) {
    const cfg = require('./config.json').sites.find(s => s.name === site.name);
    log.push('--- ' + site.name.toUpperCase() + ' ---');
    try {
      const result = await site.mod.run(cfg ? cfg.config : {});
      log.push('Result: ' + JSON.stringify(result));

      // 对于 agentrouter 和 anyrouter，检查签到是否成功
      if (site.name === 'agentrouter' || site.name === 'anyrouter') {
        if (result.checkinSuccess === false) {
          allCheckinSuccess = false;
          log.push('WARNING: ' + site.name + ' checkin may have failed');
        } else {
          log.push('OK: ' + site.name + ' checkin successful');
        }
      }

      if (result.success === false) hadFailure = true;
    } catch (e) {
      log.push('Error: ' + e.message);
      hadFailure = true;
    }
    log.push('');
    await sleep(1500);
  }

  log.push('=== Done in ' + (Date.now() - start) + 'ms ===');
  const text = log.join('\n');
  console.log(text);
  await writeLog(log);

  if (!allCheckinSuccess) {
    log.push('*** Some sites checkin failed, exiting with error ***');
    console.log(text);
    process.exit(1);
  }
  if (hadFailure) {
    console.log('\n*** Some sites failed, exiting with error ***');
    process.exit(1);
  }
})();
