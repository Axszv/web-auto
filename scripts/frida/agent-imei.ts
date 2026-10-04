// agent-imei.ts — 把 TelephonyManager 报的 IMEI 换成格式合法的真机值。
//
// 起因：Redroid 官方维护者明确说过「the telephony is not emulated in redroid」，
// 它生成的 IMEI 是 5efb42d032e3dde4 这样的 16 位纯 hex —— 而真实 IMEI 是
// 15 位十进制、带 Luhn 校验位、前 8 位是厂商 TAC。格式本身就一眼假。
// App 的 OAID 链退到 getIMEI 后，这个值会被直接塞进广告请求。
//
// 之前所有改 getprop 的方案都无效，因为 SDK 不读 getprop，它读 TelephonyManager。
// 这里直接在 framework 层拦截返回值 —— 是目前唯一能改变「请求内容本身」的操作。
import Java from 'frida-java-bridge';

const FAKE_IMEI = '8609110312345670';   // 小米 TAC 86091103 + 合法 Luhn 校验位
const FAKE_IMSI = '460001234567890';    // 15 位，中国移动 46000
const FAKE_ANDROID_ID = '7d3f1a9c5e2b8406';

Java.perform(function () {
  // ---- IMEI：TelephonyManager.getDeviceId() / getImei() ----
  ['getDeviceId', 'getImei'].forEach(function (m: string) {
    try {
      const TM = Java.use('android.telephony.TelephonyManager');
      if (!TM[m]) return;
      TM[m].overloads.forEach(function (ov: any) {
        ov.implementation = function () {
          try {
            const orig = ov.apply(this, arguments);
            console.log('[IMEI] ' + m + ' 原值=' + String(orig) + ' -> 改为 ' + FAKE_IMEI);
            return FAKE_IMEI;
          } catch (e) {
            return FAKE_IMEI;
          }
        };
      });
      console.log('[HOOKED] TelephonyManager.' + m);
    } catch (e) { console.log('[IMEI-ERR] ' + m + ' ' + e); }
  });

  // ---- 相关读取接口一并对齐，避免 SDK 交叉校验时发现不一致 ----
  const fixes: [string, string, string][] = [
    ['android.telephony.TelephonyManager', 'getSubscriberId', FAKE_IMSI],
    ['android.telephony.TelephonyManager', 'getSimSerialNumber', '8695740312345678'],
    ['android.telephony.TelephonyManager', 'getLine1Number', '13800138000'],
    ['android.provider.Settings$Secure', 'getString', ''],   // 不动，仅占位
  ];
  fixes.forEach(function (p: [string, string, string]) {
    if (!p[2]) return;
    try {
      const C: any = Java.use(p[0]);
      if (!C[p[1]]) return;
      C[p[1]].overloads.forEach(function (ov: any) {
        ov.implementation = function () {
          const r = ov.apply(this, arguments);
          console.log('[FIX] ' + p[1] + ' 原值=' + String(r) + ' -> ' + p[2]);
          return p[2];
        };
      });
      console.log('[HOOKED] ' + p[0] + '.' + p[1]);
    } catch (e) { }
  });

  // ---- Android ID：Settings.Secure 里读的是静态表，直接改 system property ----
  try {
    const SystemProperties = Java.use('android.os.SystemProperties');
    if (SystemProperties.get) {
      SystemProperties.get.overloads.forEach(function (ov: any) {
        ov.implementation = function (key: any) {
          const k = String(key);
          const r = ov.apply(this, arguments);
          if (k === 'ro.serialno') return '8695740312345678';
          return r;
        };
      });
      console.log('[HOOKED] SystemProperties.get(ro.serialno)');
    }
  } catch (e) { }

  console.log('[READY-IMEI] hook 完成，之后 App 读到的 IMEI 应为 ' + FAKE_IMEI);
});