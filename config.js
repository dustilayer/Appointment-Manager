// ===== 集中配置：全部从环境变量读取，未配置则走演示模式 =====
const fs = require('fs');
const path = require('path');

// 支持 .env 文件（无需依赖 dotenv）
(function loadEnv() {
  const f = path.join(__dirname, '.env');
  if (!fs.existsSync(f)) return;
  fs.readFileSync(f, 'utf8').split('\n').forEach(function (line) {
    line = line.trim();
    if (!line || line[0] === '#') return;
    const i = line.indexOf('=');
    if (i < 0) return;
    const k = line.slice(0, i).trim();
    let v = line.slice(i + 1).trim();
    if ((v[0] === '"' && v.slice(-1) === '"') || (v[0] === "'" && v.slice(-1) === "'")) v = v.slice(1, -1);
    if (process.env[k] === undefined) process.env[k] = v;
  });
})();

const E = process.env;
function strongToken(value) {
  return typeof value === 'string' && value.length >= 32 && !/change[-_ ]?me|replace[-_ ]?me/i.test(value);
}
if (!strongToken(E.ADMIN_TOKEN)) throw new Error('Set ADMIN_TOKEN to a random token of at least 32 characters.');
if (E.SMS_INGEST_TOKEN && (!strongToken(E.SMS_INGEST_TOKEN) || E.SMS_INGEST_TOKEN === E.ADMIN_TOKEN)) {
  throw new Error('SMS_INGEST_TOKEN must be a separate random token of at least 32 characters.');
}

module.exports = {
  port: Number(E.PORT) || 8777,
  host: E.HOST || '127.0.0.1',
  baseUrl: E.BASE_URL || `http://localhost:${Number(E.PORT) || 8777}`,
  adminToken: E.ADMIN_TOKEN,
  // 短信转发注入令牌（情况 B）：运营侧收码设备用它调 /api/ingest/sms。留空则该接口关闭。
  smsIngestToken: E.SMS_INGEST_TOKEN || '',
  sms: {
    // provider: '' | 'aliyun' | 'console'
    provider: E.SMS_PROVIDER || '',
    aliyun: {
      accessKeyId: E.ALIYUN_SMS_KEY_ID || '',
      accessKeySecret: E.ALIYUN_SMS_KEY_SECRET || '',
      signName: E.ALIYUN_SMS_SIGN || '',
      templateSubmitted: E.ALIYUN_SMS_TPL_SUBMITTED || '',       // 已受理/处理中模板
      templateSuccess: E.ALIYUN_SMS_TPL_SUCCESS || '', // 预约成功模板
      templateCodeRequest: E.ALIYUN_SMS_TPL_CODE || '',   // 请求用户回订单页填验证码
    },
    get enabled() { return this.provider === 'aliyun' && !!(this.aliyun.accessKeyId && this.aliyun.accessKeySecret); },
  },
};
