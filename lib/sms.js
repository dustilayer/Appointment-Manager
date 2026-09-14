// ===== 短信通知（阿里云 Dysmsapi）=====
// 未配置时降级为控制台打印，方便本地演示；配置后走真实短信。
const crypto = require('crypto');
const https = require('https');
const cfg = require('../config').sms;

function percentEncode(s) {
  return encodeURIComponent(s)
    .replace(/\+/g, '%20').replace(/\*/g, '%2A').replace(/%7E/g, '~');
}

// 阿里云 RPC 风格签名（HMAC-SHA1）
function aliyunRequest(action, bizParams) {
  const a = cfg.aliyun;
  const params = Object.assign({
    Format: 'JSON',
    Version: '2017-05-25',
    AccessKeyId: a.accessKeyId,
    SignatureMethod: 'HMAC-SHA1',
    SignatureVersion: '1.0',
    SignatureNonce: crypto.randomBytes(16).toString('hex'),
    Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    Action: action,
    RegionId: 'cn-hangzhou',
  }, bizParams);

  const sortedQs = Object.keys(params).sort()
    .map((k) => `${percentEncode(k)}=${percentEncode(params[k])}`).join('&');
  const stringToSign = `GET&${percentEncode('/')}&${percentEncode(sortedQs)}`;
  const signature = crypto.createHmac('sha1', a.accessKeySecret + '&')
    .update(stringToSign).digest('base64');
  const finalQs = sortedQs + '&Signature=' + percentEncode(signature);

  return new Promise((resolve, reject) => {
    const req = https.get('https://dysmsapi.aliyuncs.com/?' + finalQs, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { resolve({ raw: data }); } });
    });
    req.on('error', reject);
    req.setTimeout(8000, () => { req.destroy(new Error('SMS 请求超时')); });
  });
}

async function send(phone, kind, vars) {
  // kind: 'submitted' | 'success' | 'code'(请用户回订单页填验证码)
  if (!cfg.enabled) {
    console.log(`[SMS·演示] ${kind} 通知已跳过（未配置短信服务）`);
    return { demo: true };
  }
  const a = cfg.aliyun;
  const template = {
    success: a.templateSuccess,
    code: a.templateCodeRequest,
    submitted: a.templateSubmitted,
  }[kind];
  if (!template) { console.log(`[SMS] 缺少 ${kind} 模板，跳过`); return { skipped: true }; }
  try {
    const r = await aliyunRequest('SendSms', {
      PhoneNumbers: phone,
      SignName: a.signName,
      TemplateCode: template,
      TemplateParam: JSON.stringify(vars || {}),
    });
    if (r.Code !== 'OK') console.log('[SMS] 发送失败');
    return r;
  } catch (e) {
    console.log('[SMS] 请求异常');
    return { error: e.message };
  }
}

module.exports = { enabled: cfg.enabled, send };
