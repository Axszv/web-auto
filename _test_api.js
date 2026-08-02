const https = require('https');
const { CookieJar } = require('tough-cookie');

// Test if anyrouter responds to API with session cookie
const jar = new CookieJar();
const sessionVal = 'MTc4NTY2ODAyMnxEWDhFQVFMX2dBQUJFQUVRQUFBeF80QUFBUVp6ZEhKcGJtY01EUUFMYjJGMWRHaGZjM1JoZEdVR2MzUnlhVzVuREE0QURHcE9hVVF3ZUZZelZXcEhiUT09fBcsVQLpmeEPOBbitU_iP8S6TkdxI3Dx7IOUMTTtu6SY';

const opts = {
  hostname: 'anyrouter.top',
  port: 443,
  path: '/api/user/self',
  method: 'GET',
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Cookie': 'session=' + sessionVal + '; acw_sc__v2=6a6f21971224155471dd684bbced7b92de760012; cdn_sec_tc=9b66334517856679916407240e2468881741b5df3997954672f3fcf088; acw_tc=9b66334517856679916407240e2468881741b5df3997954672f3fcf088'
  }
};

const req = https.request(opts, res => {
  let d = '';
  res.on('data', c => d += c);
  res.on('end', () => {
    console.log('Status:', res.statusCode);
    console.log('Body:', d.substring(0, 300));
  });
});
req.on('error', e => console.log('Error:', e.message));
req.setTimeout(15000, () => { console.log('Timeout'); req.destroy(); });
req.end();
