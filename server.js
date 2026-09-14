// KVISA 订单管理与上海中心自动预约后端（Node.js + axios）。
// 自动预约、人工确认与短信转发并存；当前限制见 README.md。

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const axios = require('axios');   // 新增：用于调用官网接口

const config = require('./config');
const sms = require('./lib/sms');

const PORT = config.port;
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const ADMIN_TOKEN = config.adminToken;

const REGIONS = {
  '上海中心': '上海、安徽、江苏、浙江',
  '广州中心': '广东、福建、海南、广西',
  '北京中心': '北京、天津、河北、山西、内蒙古、新疆、西藏、青海',
  '西安中心': '陕西',
};
const DEFAULT_VISA_TYPE =
  '国籍 中国(CHINA P.R.) / 入境目的 旅游等短期访问,其他 / 逗留期间 90 天以下';

// 领区 → 官网中心代码。当前仅接入上海；未列出的领区订单不会进入自动抢号队列，等待运营人工介入。
const CENTER_CD_MAP = {
  '上海中心': 'B00009',
};

// 验证码提交时间窗：官方短信验证码有效期约 5 分钟，留出用户看到短信的余量
const CODE_WINDOW_MS = 10 * 60e3;
// ---------- 简易 JSON 数据库 ----------
function ensureDb() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, JSON.stringify({ orders: [], paused: true }, null, 2));
}
function readDb() {
  ensureDb();
  const db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  if (!db || !Array.isArray(db.orders)) throw new Error('Invalid database structure');
  return db;
}
function writeDb(db) {
  const temp = DB_FILE + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(db, null, 2));
  fs.renameSync(temp, DB_FILE);
}

// 读-改-写事务：任何 await 网络之后再改订单必须走这里,避免并发路径互相覆盖。
function updateOrder(orderId, mutator) {
  const db = readDb();
  const order = db.orders.find((x) => x.id === orderId);
  if (!order || order.status !== 'processing') return null;
  mutator(order);
  writeDb(db);
  return order;
}

// ---------- 系统运行总开关（持久化到 db.paused，重启不自动恢复抢号） ----------
// 暂停时：抢号 / 发码 / 监控三大循环空转，用户 certify / resend 也被拒绝——即一切对官网的自动请求全部停止。
function isSystemPaused() { return !!readDb().paused; }
function setSystemPaused(paused) {
  const db = readDb();
  db.paused = !!paused;
  db.pausedAt = db.paused ? new Date().toISOString() : null;
  writeDb(db);
  return { paused: db.paused, pausedAt: db.pausedAt };
}

// ---------- 工具 ----------
function randId(n) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let s = ''; const bytes = crypto.randomBytes(n);
  for (let i = 0; i < n; i++) s += chars[bytes[i] % chars.length];
  return s;
}
function newOrderId() { return 'ord_' + randId(12) + '-' + randId(8); }
function shortId(id) { const p = id.split('-'); return '-' + (p[1] || id.slice(-8)); }
function maskName(name) {
  name = String(name || '').trim();
  return name ? name[0] + '**' : '匿名';
}
function maskPhone(phone) {
  phone = String(phone || '').replace(/\D/g, '');
  if (phone.length < 7) return phone.replace(/.(?=.{2})/g, '*');
  return phone.slice(0, 3) + '****' + phone.slice(-2);
}
// 归一化手机号，便于跨来源（转发 App 可能带 +86 / 空格）与订单 fullPhone 比对
function normPhone(v) {
  let s = String(v || '').replace(/\D/g, '');
  if (s.length > 11 && s.startsWith('86')) s = s.slice(2); // 去掉中国国家码
  if (s.length > 11) s = s.slice(-11);                     // 其余情况取后 11 位
  return s;
}
function isDate(s) { return /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')); }
function normDatePrefs(b) {
  const earliest = isDate(b.apptEarliest) ? b.apptEarliest : '';
  const latest = isDate(b.apptLatest) ? b.apptLatest : '';
  const exclude = Array.isArray(b.apptExclude)
    ? Array.from(new Set(b.apptExclude.filter(isDate))).sort()
    : [];
  return { earliest, latest, exclude };
}
function apptDateViolation(o, appointmentTime) {
  const m = String(appointmentTime || '').match(/\d{4}-\d{2}-\d{2}/);
  if (!m) return null;
  const d = m[0];
  if (o.apptEarliest && d < o.apptEarliest) return `预约日期 ${d} 早于用户可接受的最早日期 ${o.apptEarliest}`;
  if (o.apptLatest && d > o.apptLatest) return `预约日期 ${d} 晚于用户可接受的最晚日期 ${o.apptLatest}`;
  if (Array.isArray(o.apptExclude) && o.apptExclude.indexOf(d) >= 0) return `预约日期 ${d} 在用户排除的日期内`;
  return null;
}
function publicOrder(o) {
  return {
    id: o.id, shortId: shortId(o.id), region: o.region, regionProvinces: o.regionProvinces,
    maskedName: o.maskedName, maskedPhone: o.maskedPhone, relation: o.relation,
    visaType: o.visaType, appointmentTime: o.appointmentTime, exitDate: o.exitDate,
    applicants: o.applicants, applicantNames: (o.applicantList || []).map((a) => maskName(a.name)),
    apptEarliest: o.apptEarliest || '', apptLatest: o.apptLatest || '', apptExclude: o.apptExclude || [],
    status: o.status, receiptCode: o.receiptCode,
    autoPaused: !!o.autoPaused,
    automationEnabled: o.status === 'processing' && !!CENTER_CD_MAP[o.region] && !o.autoPaused && !isSystemPaused(),
    codeRequestedAt: o.codeRequestedAt || null,
    codeSubmittedAt: o.codeSubmittedAt || null,
    certifyPending: !!(o._certifyKey && !o._certifyConfirmed),
    certifyConfirmed: !!o._certifyConfirmed,
    certifyConfirmedAt: o._certifyConfirmedAt || null,
    createdAt: o.createdAt, updatedAt: o.updatedAt,
  };
}

const rateBuckets = new Map();
function rateLimit(key, max, windowMs) {
  const now = Date.now();
  if (rateBuckets.size > 10000) rateBuckets.clear();
  const arr = (rateBuckets.get(key) || []).filter((t) => now - t < windowMs);
  if (arr.length >= max) { rateBuckets.set(key, arr); return false; }
  arr.push(now); rateBuckets.set(key, arr);
  return true;
}

// ---------- 通知 ----------
async function notifySubmitted(o) {
  await sms.send(o.fullPhone, 'submitted', { name: o.maskedName, region: o.region, order: shortId(o.id) });
}
async function notifySuccess(o) {
  await sms.send(o.fullPhone, 'success', { name: o.maskedName, code: o.receiptCode, time: o.appointmentTime || '', region: o.region });
}
async function notifyCodeRequest(o) {
  await sms.send(o.fullPhone, 'code', { name: o.maskedName, order: shortId(o.id) });
}
function clearCode(o) {
  o.verificationCode = null; o.codeRequestedAt = null; o.codeSubmittedAt = null;
  for (const key of ['_certifyKey', '_userSubmittedCode', '_certifyConfirmed', '_certifyConfirmedAt', '_certifyRequestedAt']) delete o[key];
}

function migrateLegacyOrders() {
  const db = readDb();
  if (!db.orders.some(o => ['pending', 'paid', 'refunded'].includes(o.status))) return;
  const backup = DB_FILE + '.before-payment-removal.bak';
  if (!fs.existsSync(backup)) fs.copyFileSync(DB_FILE, backup, fs.constants.COPYFILE_EXCL);
  for (const o of db.orders) {
    if (o.status === 'pending') { o.status = 'processing'; o.autoPaused = true; }
    else if (o.status === 'paid') o.status = 'processing';
    else if (o.status === 'refunded') { o.status = 'cancelled'; o.autoPaused = true; clearCode(o); }
  }
  writeDb(db);
}

// ---------- HTTP 辅助 ----------
function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = ''; let size = 0;
    const fail = (status) => { const error = new Error('Invalid request body'); error.status = status; reject(error); };
    req.on('data', c => { size += c.length; if (size > 32768) { fail(413); return; } data += c; });
    req.on('error', () => fail(400));
    req.on('end', () => {
      if (size > 32768) return;
      try {
        const body = data ? JSON.parse(data) : {};
        if (!body || typeof body !== 'object' || Array.isArray(body)) return fail(400);
        resolve(body);
      } catch { fail(400); }
    });
  });
}
function matchesToken(actual, expected) {
  const a = Buffer.from(String(actual || '')), b = Buffer.from(String(expected || ''));
  return b.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
}
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};
function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  let decoded;
  try { decoded = decodeURIComponent(rel); } catch { res.writeHead(400); return res.end('Bad path'); }
  if (decoded.split(/[\\/]/).some(part => part.startsWith('.'))) { res.writeHead(403); return res.end('Forbidden'); }
  const filePath = path.resolve(PUBLIC_DIR, '.' + decoded);
  if (!filePath.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      if (!path.extname(filePath)) {
        return fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (e2, d2) => {
          if (e2) { res.writeHead(404); return res.end('Not found'); }
          res.writeHead(200, { 'Content-Type': MIME['.html'] }); res.end(d2);
        });
      }
      res.writeHead(404); return res.end('Not found');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
}

// ---------- 业务路由 ----------
async function handleApi(req, res, url) {
  const p = url.pathname;
  const method = req.method;
  if (method === 'POST' && req.headers.origin && req.headers.origin !== new URL(config.baseUrl).origin) {
    return sendJson(res, 403, { error: '来源不允许' });
  }

  if (method === 'GET' && p === '/api/regions') {
    return sendJson(res, 200, { regions: REGIONS });
  }

  // 公开只读：官网名额历史缓冲，供订单页滚动栏使用
  if (method === 'GET' && p === '/api/availability-log') {
    // 附带每个 center 当前已知的"官网禁选"日期,前端可给对应条目打灰
    const centers = Array.from(new Set(Object.values(CENTER_CD_MAP)));
    const disabledByCenter = {};
    centers.forEach(cc => { disabledByCenter[cc] = getDisabledDates(cc); });
    return sendJson(res, 200, {
      entries: getAvailabilityLog(),
      windowMinutes: AVAILABILITY_LOG_WINDOW_MS / 60e3,
      disabledByCenter
    });
  }

  // 创建订单（支持多申请人）
  if (method === 'POST' && p === '/api/orders') {
    const b = await readBody(req);
    if (!REGIONS[b.region]) return sendJson(res, 400, { error: '请选择有效的领区' });
    if (!rateLimit('create:' + req.socket.remoteAddress, 10, 60e3)) return sendJson(res, 429, { error: '提交过于频繁，请稍后再试' });
    if (typeof b.name !== 'string' || !b.name.trim() || b.name.length > 80 || typeof b.phone !== 'string' || !/^\d{11}$/.test(b.phone)) {
      return sendJson(res, 400, { error: '请填写有效的姓名与 11 位手机号' });
    }
    if ((b.applicantList && (!Array.isArray(b.applicantList) || b.applicantList.length > 3 || b.applicantList.some(a => !a || typeof a.name !== 'string' || !a.name.trim() || a.name.length > 80))) ||
        (b.apptExclude && (!Array.isArray(b.apptExclude) || b.apptExclude.length > 10 || b.apptExclude.some(d => !isDate(d)))) ||
        (b.apptEarliest && !isDate(b.apptEarliest)) || (b.apptLatest && !isDate(b.apptLatest)) ||
        (b.relation && !['本人', '父母', '子女', '配偶', '其他'].includes(b.relation))) {
      return sendJson(res, 400, { error: '申请人数、日期或关系填写有误' });
    }

    let list = [{ name: String(b.name).trim() }];
    if (Array.isArray(b.applicantList)) {
      b.applicantList.forEach((a) => { if (a && a.name && String(a.name).trim()) list.push({ name: String(a.name).trim() }); });
    }
    const count = list.length;

    const prefs = normDatePrefs(b);
    if (prefs.earliest && prefs.latest && prefs.earliest > prefs.latest) {
      return sendJson(res, 400, { error: '可接受的最早日期不能晚于最晚日期' });
    }

    // 检查出境日期必填
    if (!b.exitDate || !/^\d{4}-\d{2}-\d{2}$/.test(b.exitDate)) {
      return sendJson(res, 400, { error: '请填写计划出境日期' });
    }

    const db = readDb();
    const now = new Date().toISOString();
    const order = {
      id: newOrderId(), region: b.region, regionProvinces: REGIONS[b.region],
      fullName: list[0].name, fullPhone: String(b.phone).replace(/\D/g, ''),
      maskedName: maskName(list[0].name), maskedPhone: maskPhone(b.phone),
      relation: b.relation || '本人', visaType: DEFAULT_VISA_TYPE,
      exitDate: b.exitDate || '', applicants: count, applicantList: list,
      apptEarliest: prefs.earliest, apptLatest: prefs.latest, apptExclude: prefs.exclude,
      appointmentTime: '', status: 'processing', receiptCode: null,
      autoPaused: false,   // 单订单自动开关：true=运营在后台关闭了该单的自动发码/注入/抢号
      codeRequestedAt: null, verificationCode: null, codeSubmittedAt: null,
      createdAt: now, updatedAt: now,
    };
    db.orders.push(order); writeDb(db);
    notifySubmitted(order);
    return sendJson(res, 201, { order: publicOrder(order) });
  }

  // 恢复订单
  if (method === 'POST' && p === '/api/orders/recover') {
    const ip = req.socket.remoteAddress || 'unknown';
    if (!rateLimit('recover:' + ip, 10, 5 * 60e3)) return sendJson(res, 429, { error: '尝试次数过多，请 5 分钟后再试' });
    const b = await readBody(req);
    const phone = String(b.phone || '').replace(/\D/g, '');
    const name = String(b.name || '').trim();
    if (phone.length !== 11) return sendJson(res, 400, { error: '请填写下单时使用的 11 位手机号' });
    if (!name) return sendJson(res, 400, { error: '请填写下单姓名' });
    const matches = readDb().orders.filter((o) =>
      o.fullPhone === phone &&
      o.fullName === name
    ).reverse();
    if (!matches.length) return sendJson(res, 404, { error: '未找到匹配的订单。请核对信息是否与下单时一致' });
    return sendJson(res, 200, { orders: matches.map(publicOrder) });
  }

  // 用户提交官方短信验证码（运营发起）
  let m = p.match(/^\/api\/orders\/([^/]+)\/code$/);
  if (method === 'POST' && m) {
    const ip = req.socket.remoteAddress || 'unknown';
    if (!rateLimit('code:' + ip, 20, 5 * 60e3)) return sendJson(res, 429, { error: '尝试次数过多，请稍后再试' });
    const b = await readBody(req);
    const db = readDb();
    const o = db.orders.find((x) => x.id === decodeURIComponent(m[1]));
    if (!o) return sendJson(res, 404, { error: '订单不存在' });
    if (o.status !== 'processing') return sendJson(res, 400, { error: '当前订单状态无需提交验证码' });
    if (!o.codeRequestedAt) return sendJson(res, 400, { error: '工作人员尚未发起验证码请求' });
    if (Date.now() - Date.parse(o.codeRequestedAt) > CODE_WINDOW_MS) {
      return sendJson(res, 400, { error: '本次验证码请求已过期，请等待工作人员重新发起' });
    }
    const code = String(b.code || '').trim();
    if (!/^[0-9]{4,8}$/.test(code)) return sendJson(res, 400, { error: '请输入短信中的 4–8 位数字验证码' });
    o.verificationCode = code;
    o.codeSubmittedAt = new Date().toISOString();
    o.updatedAt = o.codeSubmittedAt; writeDb(db);
    return sendJson(res, 200, { order: publicOrder(o) });
  }

  // ===== 新增：用户提交验证码（预存）=====
  m = p.match(/^\/api\/orders\/([^/]+)\/certify$/);
  if (method === 'POST' && m) {
    const b = await readBody(req);
    const db = readDb();
    const o = db.orders.find(x => x.id === decodeURIComponent(m[1]));
    if (!o) return sendJson(res, 404, { error: '订单不存在' });
    if (o.status !== 'processing') return sendJson(res, 400, { error: '当前订单状态不需要验证码' });
    if (o.autoPaused) return sendJson(res, 503, { error: '该订单的自动预约已由运营暂停，请稍后再试或联系客服' });

    const code = String(b.certifyNo || '').trim();
    if (!/^\d{4,8}$/.test(code)) {
      return sendJson(res, 400, { error: '请输入4-8位数字验证码' });
    }
    if (!o._certifyKey) {
      return sendJson(res, 400, { error: '请等待系统发送验证码后再输入' });
    }

    const centerCd = CENTER_CD_MAP[o.region];
    if (!centerCd) return sendJson(res, 400, { error: '当前领区暂未开通自动抢号' });
    if (isSystemPaused()) return sendJson(res, 503, { error: '系统维护中，自动预约暂时暂停，请稍后再试' });
    const isValid = await confirmCertify(o.fullPhone, code, o._certifyKey, centerCd);
    if (!isValid) {
      return sendJson(res, 400, { error: '验证码错误，请重新输入' });
    }

    const now = new Date().toISOString();
    const confirmed = updateOrder(o.id, (fo) => {
      fo._userSubmittedCode = code;
      fo._certifyConfirmed = true;
      fo._certifyConfirmedAt = now;
    });
    if (!confirmed) return sendJson(res, 409, { error: '订单已停止处理' });

    const expiresAt = new Date(Date.now() + GRAB_CONFIG.codeValidMinutes * 60000);
    return sendJson(res, 200, {
      message: `✅ 验证码已确认，有效至 ${expiresAt.toLocaleTimeString()}，期间有名额会自动预约`
    });
  }

  // 用户主动重发验证码(手机没收到 / 想换新码)
  m = p.match(/^\/api\/orders\/([^/]+)\/resend-certify$/);
  if (method === 'POST' && m) {
    const ip = req.socket.remoteAddress || 'unknown';
    if (!rateLimit('resend-cert:' + ip, 10, 5 * 60e3)) return sendJson(res, 429, { error: '尝试次数过多,请稍后再试' });
    const db = readDb();
    const o = db.orders.find((x) => x.id === decodeURIComponent(m[1]));
    if (!o) return sendJson(res, 404, { error: '订单不存在' });
    if (o.status !== 'processing') return sendJson(res, 400, { error: '当前订单状态无需验证码' });
    if (o.autoPaused) return sendJson(res, 503, { error: '该订单的自动预约已由运营暂停，请稍后再试或联系客服' });
    if (!CENTER_CD_MAP[o.region]) return sendJson(res, 400, { error: '当前领区暂未开通自动抢号' });
    if (isSystemPaused()) return sendJson(res, 503, { error: '系统维护中，暂时无法发送验证码，请稍后再试' });
    // 单订单节流:距上次发送不足 60 秒不允许再发,防止刷官方短信配额
    if (o._lastCertifySentAt) {
      const elapsed = Date.now() - Date.parse(o._lastCertifySentAt);
      if (elapsed < 60e3) {
        return sendJson(res, 429, { error: `距上次发送仅 ${Math.round(elapsed/1000)} 秒,请 ${Math.ceil((60e3 - elapsed) / 1000)} 秒后再试` });
      }
    }
    // 触发实际发送(异步,不阻塞响应)
    sendCertifyForOrder({ id: o.id, region: o.region, fullPhone: o.fullPhone, maskedName: o.maskedName }).catch(() => {});
    return sendJson(res, 200, { message: '已请求重新发送,请留意手机短信' });
  }

  // ===== 新增：短信转发注入验证码（情况 B：验证码收在运营自己控制的设备/号池上）=====
  // 运营侧收码设备（苹果：Mac 监听 Messages / iOS 快捷指令自动化；安卓：SmsForwarder 等）
  // 把官网验证码短信 POST 到这里；服务器按「接收短信的号码」匹配订单并自动 confirmCertify，
  // 整个验证码环节无人参与。接口用独立令牌 SMS_INGEST_TOKEN 保护，与运营后台令牌分离。
  if (method === 'POST' && p === '/api/ingest/sms') {
    const ingestToken = config.smsIngestToken;
    if (!ingestToken) return sendJson(res, 503, { error: '短信注入未启用（未配置 SMS_INGEST_TOKEN）' });
    const provided = String(req.headers['x-ingest-token'] || '').trim()
      || String(req.headers['authorization'] || '').replace(/^Bearer\s+/i, '').trim();
    if (!matchesToken(provided, ingestToken)) return sendJson(res, 401, { error: '未授权' });

    const ip = req.socket.remoteAddress || 'unknown';
    if (!rateLimit('ingest:' + ip, 60, 60e3)) return sendJson(res, 429, { error: '请求过于频繁' });
    if (isSystemPaused()) return sendJson(res, 503, { error: '系统维护中，暂停处理' });

    const b = await readBody(req);
    const phone = normPhone(b.phone);
    // 优先用显式 code；否则从短信正文里抓第一段 4–8 位数字
    let code = String(b.code || '').replace(/\D/g, '');
    if (!code && b.text) {
      const mm = String(b.text).match(/(\d{4,8})/);
      if (mm) code = mm[1];
    }
    if (!/^\d{4,8}$/.test(code)) {
      return sendJson(res, 400, { error: '未能识别 4–8 位验证码', hint: '在 code 字段直接传验证码，或在 text 里包含短信正文' });
    }

    // 候选：处理中 + 已接入领区 + 有 certify_key + 未处于"已确认且未过期"
    const candidates = readDb().orders.filter((o) =>
      o.status === 'processing' && !o.autoPaused && CENTER_CD_MAP[o.region] && o._certifyKey &&
      !(o._certifyConfirmed && !isCodeExpired(o))
    );
    let target = null;
    if (phone) {
      target = candidates
        .filter((o) => normPhone(o.fullPhone) === phone)
        .sort((a, c) => Date.parse(c._certifyRequestedAt || c.updatedAt || 0) - Date.parse(a._certifyRequestedAt || a.updatedAt || 0))[0] || null;
    }
    // 单线兜底：没给号码 / 号码没匹配上，但全局只有一个订单在等码，就用它
    if (!target && candidates.length === 1) target = candidates[0];

    if (!target) {
      const reason = candidates.length === 0 ? '当前没有等待验证码的订单'
        : (phone ? `号码 ${maskPhone(phone)} 未匹配到等待验证码的订单`
                 : `有 ${candidates.length} 个订单在等码，请在 phone 字段指明接收号码`);
      return sendJson(res, 404, { error: reason });
    }

    const centerCd = CENTER_CD_MAP[target.region];
    const isValid = await confirmCertify(target.fullPhone, code, target._certifyKey, centerCd);
    if (!isValid) return sendJson(res, 400, { error: '官网校验未通过（验证码错误或已过期）', order: shortId(target.id) });

    const now = new Date().toISOString();
    const confirmed = updateOrder(target.id, (fo) => {
      fo._userSubmittedCode = code;
      fo._certifyConfirmed = true;
      fo._certifyConfirmedAt = now;
    });
    if (!confirmed) return sendJson(res, 409, { error: '订单已停止处理' });
    console.log(`[短信注入] ✅ 订单 [订单]（${maskPhone(target.fullPhone)}）验证码已自动确认，进入抢号队列`);
    return sendJson(res, 200, { message: '验证码已确认，进入自动抢号', order: shortId(target.id), phone: maskPhone(target.fullPhone) });
  }

  m = p.match(/^\/api\/orders\/([^/]+)$/);
  if (method === 'GET' && m) {
    const db = readDb();
    const o = db.orders.find((x) => x.id === decodeURIComponent(m[1]));
    if (!o) return sendJson(res, 404, { error: '订单不存在' });
    return sendJson(res, 200, { order: publicOrder(o) });
  }

  // ----- 运营后台 -----
  function auth() {
    if (!rateLimit('admin:' + req.socket.remoteAddress, 120, 60e3)) return false;
    return matchesToken(req.headers.authorization, 'Bearer ' + ADMIN_TOKEN);
  }

  if (method === 'GET' && p === '/api/admin/orders') {
    if (!auth()) return sendJson(res, 401, { error: '未授权' });
    return sendJson(res, 200, { orders: readDb().orders.slice().reverse() });
  }

  // 系统运行总开关：查询 / 暂停 / 恢复 全部对官网的自动操作
  if (method === 'GET' && p === '/api/admin/system') {
    if (!auth()) return sendJson(res, 401, { error: '未授权' });
    const db = readDb();
    return sendJson(res, 200, { paused: !!db.paused, pausedAt: db.pausedAt || null });
  }
  if (method === 'POST' && p === '/api/admin/system/pause') {
    if (!auth()) return sendJson(res, 401, { error: '未授权' });
    console.log('[系统] ⏸ 运营已暂停：抢号 / 发码 / 监控全部停止对官网发起请求');
    return sendJson(res, 200, setSystemPaused(true));
  }
  if (method === 'POST' && p === '/api/admin/system/resume') {
    if (!auth()) return sendJson(res, 401, { error: '未授权' });
    console.log('[系统] ▶ 运营已恢复：抢号 / 发码 / 监控重新开始');
    return sendJson(res, 200, setSystemPaused(false));
  }

  m = p.match(/^\/api\/admin\/orders\/([^/]+)\/request-code$/);
  if (method === 'POST' && m) {
    if (!auth()) return sendJson(res, 401, { error: '未授权' });
    const db = readDb();
    const o = db.orders.find((x) => x.id === decodeURIComponent(m[1]));
    if (!o) return sendJson(res, 404, { error: '订单不存在' });
    if (o.status !== 'processing') return sendJson(res, 400, { error: '仅处理中的订单可索要验证码' });
    o.codeRequestedAt = new Date().toISOString();
    o.verificationCode = null; o.codeSubmittedAt = null;
    o.updatedAt = o.codeRequestedAt; writeDb(db);
    notifyCodeRequest(o);
    return sendJson(res, 200, { order: o });
  }

  // 单订单自动开关：paused=true 关闭该单的自动发码/注入/抢号；false 恢复
  m = p.match(/^\/api\/admin\/orders\/([^/]+)\/auto$/);
  if (method === 'POST' && m) {
    if (!auth()) return sendJson(res, 401, { error: '未授权' });
    const b = await readBody(req);
    const o = updateOrder(decodeURIComponent(m[1]), (fo) => {
      fo.autoPaused = !!b.paused;
      fo.updatedAt = new Date().toISOString();
    });
    if (!o) return sendJson(res, 404, { error: '订单不存在' });
    console.log(`[单订单开关] 订单 [订单] 自动处理 → ${o.autoPaused ? '已关闭' : '已开启'}`);
    return sendJson(res, 200, { order: o });
  }

  m = p.match(/^\/api\/admin\/orders\/([^/]+)\/confirm$/);
  if (method === 'POST' && m) {
    if (!auth()) return sendJson(res, 401, { error: '未授权' });
    const b = await readBody(req);
    const db = readDb();
    const o = db.orders.find((x) => x.id === decodeURIComponent(m[1]));
    if (!o) return sendJson(res, 404, { error: '订单不存在' });
    if (!['processing', 'success'].includes(o.status)) return sendJson(res, 409, { error: '已取消的订单不可确认预约' });
    const code = b.receiptCode && String(b.receiptCode).trim();
    if (!code) return sendJson(res, 400, { error: '必须填写官网返回的真实受理编号' });
    const newAppt = b.appointmentTime || o.appointmentTime;
    const violation = apptDateViolation(o, newAppt);
    if (violation && !b.force) {
      return sendJson(res, 409, { error: violation + '，如确认无误请勾选"仍要确认"', needsOverride: true });
    }
    o.receiptCode = code;
    o.appointmentTime = newAppt;
    o.status = 'success'; o.updatedAt = new Date().toISOString();
    clearCode(o);
    writeDb(db);
    notifySuccess(o);
    return sendJson(res, 200, { order: o });
  }

  m = p.match(/^\/api\/admin\/orders\/([^/]+)\/cancel$/);
  if (method === 'POST' && m) {
    if (!auth()) return sendJson(res, 401, { error: '未授权' });
    const db = readDb();
    const o = db.orders.find((x) => x.id === decodeURIComponent(m[1]));
    if (!o) return sendJson(res, 404, { error: '订单不存在' });
    if (o.status !== 'processing') return sendJson(res, 409, { error: '仅处理中的订单可取消' });
    o.status = 'cancelled'; o.autoPaused = true; o.updatedAt = new Date().toISOString();
    clearCode(o);
    writeDb(db);
    return sendJson(res, 200, { order: o });
  }

  return sendJson(res, 404, { error: 'API 不存在' });
}

// ================================================================
// ===== 新增：自动抢号 + 验证码管理模块 =====
// ================================================================

const GRAB_CONFIG = {
    checkInterval: 1000,                // 抢号检测间隔（毫秒）
    codeValidMinutes: 5,                // 验证码有效期（分钟）
    sendInterval: 5 * 60 * 1000,        // 定时发码间隔（毫秒）
    apiBase: 'https://www.visaforkorea-sh.com/visacenter/booking',
};

// 韩签官网 axios 客户端：显式禁用系统代理（HTTPS_PROXY 等环境变量）,
// 因为很多用户装了本地代理客户端（Clash/V2 等）会把默认 axios 请求打进代理，
// 而代理往往没把韩国域名放行，导致 15 秒超时。走直连即可。
const koreaApi = axios.create({
    proxy: false,
    headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        'Referer': 'https://www.visaforkorea-sh.com/',
        'Origin': 'https://www.visaforkorea-sh.com'
    }
});

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// ---- 验证码管理 ----
function isCodeExpired(order) {
    if (!order._certifyConfirmedAt) return true;
    const elapsed = (Date.now() - Date.parse(order._certifyConfirmedAt)) / 60000;
    return elapsed > GRAB_CONFIG.codeValidMinutes;
}

function cleanExpiredCodes() {
    const db = readDb();
    const cleanedOrders = [];
    for (const order of db.orders) {
        if (order.status !== 'processing') continue;
        if (order._certifyConfirmed && isCodeExpired(order)) {
            console.log(`[验证码] 订单 [订单] 验证码已过期，清除状态`);
            delete order._certifyKey;
            delete order._userSubmittedCode;
            delete order._certifyConfirmed;
            delete order._certifyConfirmedAt;
            order._certifyRequestedAt = null;
            // 仅为「未被运营关闭」的订单安排立即补发，关闭的单不再碰官网
            if (!order.autoPaused) {
                cleanedOrders.push({ id: order.id, region: order.region, fullPhone: order.fullPhone, maskedName: order.maskedName });
            }
        }
    }
    if (cleanedOrders.length) {
        writeDb(db);
        // 立即为刚过期的订单重新发码,不等下一轮 setInterval tick(避免 UX 出现最多 5 分钟的空档期)
        // 系统暂停时不补发——暂停意味着完全不碰官网。
        if (!isSystemPaused()) {
            for (const info of cleanedOrders) {
                setImmediate(() => { sendCertifyForOrder(info).catch(() => {}); });
            }
        }
    }
    return cleanedOrders.length > 0;
}

// 为单个订单发码;autoSendCertify 定时任务 与 cleanExpiredCodes 过期即刻补发 共用
async function sendCertifyForOrder(orderInfo) {
    const current = readDb().orders.find(o => o.id === orderInfo.id);
    if (!current || current.status !== 'processing' || current.autoPaused || isSystemPaused()) return false;
    const centerCd = CENTER_CD_MAP[orderInfo.region];
    if (!centerCd) return false;
    try {
        const result = await sendCertifyToPhone(orderInfo.fullPhone, centerCd);
        if (result.success) {
            const now = new Date().toISOString();
            const updated = updateOrder(orderInfo.id, (o) => {
                o._certifyKey = result.certifyKey;
                o._certifyRequestedAt = now;
                o._lastCertifySentAt = now;
                o._certifyConfirmed = false;
                o._userSubmittedCode = null;
            });
            if (!updated) return false;
            console.log(`[验证码] ✅ 已发送到 ${maskPhone(orderInfo.fullPhone)}`);
            await sms.send(orderInfo.fullPhone, 'code', {
                name: orderInfo.maskedName,
                order: shortId(orderInfo.id)
            });
            return true;
        }
        console.log(`[验证码] ❌ 发送失败: [请求失败]`);
        return false;
    } catch (err) {
        console.log(`[验证码] ❌ 异常: [请求失败]`);
        return false;
    }
}

function getOrdersNeedCode() {
    cleanExpiredCodes();
    return readDb().orders.filter(o => {
        if (o.status !== 'processing') return false;
        if (o.autoPaused) return false;              // 运营关闭了该单的自动处理
        if (!CENTER_CD_MAP[o.region]) return false;
        if (o._certifyConfirmed && !isCodeExpired(o)) return false;
        if (o._lastCertifySentAt && (Date.now() - Date.parse(o._lastCertifySentAt)) < 60000) {
            return false;
        }
        return true;
    });
}

// ---- 官网API调用 ----
async function sendCertifyToPhone(phone, centerCd) {
    try {
        const response = await koreaApi.post(
            `${GRAB_CONFIG.apiBase}/sendCertifyJSON`,
            { phone, center_cd: centerCd },
            { headers: { 'Content-Type': 'application/json' }, timeout: 10000 }
        );
        const data = response.data;
        if (!data || typeof data !== 'object') return { success: false, error: '官网返回非预期格式' };
        if (!data.certify_key || data.certify_key === 'fail') {
            return { success: false, error: '官网返回失败' };
        }
        return { success: true, certifyKey: data.certify_key };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

async function confirmCertify(phone, certifyNo, certifyKey, centerCd) {
    try {
        const response = await koreaApi.post(
            `${GRAB_CONFIG.apiBase}/certifyConfirmJSON`,
            { phone, certify_no: certifyNo, certify_key: certifyKey, center_cd: centerCd },
            { headers: { 'Content-Type': 'application/json' }, timeout: 10000 }
        );
        const data = response.data;
        if (!data || typeof data !== 'object') return false;
        return data.certify_confirm === 'success';
    } catch (error) {
        return false;
    }
}

// 扫描本月所有可用日期(不做偏好过滤,只列出官网当前放出的所有档期)
async function scanCurrentMonthAvailability(centerCd) {
    try {
        const now = new Date();
        const year = now.getFullYear();
        const month = String(now.getMonth() + 1).padStart(2, '0');
        const response = await koreaApi.post(
            `${GRAB_CONFIG.apiBase}/visitCntInfo`,
            { visit_type: 'month', visit_val: `${year}-${month}`, center_cd: centerCd },
            { headers: { 'Content-Type': 'application/json' }, timeout: 5000 }
        );
        const days = response.data;
        if (!Array.isArray(days)) return [];
        return days.filter((d) => d.check === true).map((d) => d.work_day).filter(isDate);
    } catch (error) {
        return [];
    }
}

// 反向学习:官网 insertJSON 返回 -1 通常代表"visitCntInfo check=true 但此刻不可预约"(名额瞬间被抢完 / datepicker 暂时禁选)。
// 短暂拉黑(避免同秒空转和无谓的 API/certify_key 消耗);TTL 短,让日期变可预约后能及时再抢。
const DISABLED_DATE_TTL_MS = 30e3;
const disabledDatesCache = new Map(); // key: `${centerCd}|${workDay}` -> expireAt (ms)
function isDateDisabled(centerCd, workDay) {
    const key = `${centerCd}|${workDay}`;
    const expireAt = disabledDatesCache.get(key);
    if (!expireAt) return false;
    if (Date.now() > expireAt) { disabledDatesCache.delete(key); return false; }
    return true;
}
function markDateDisabled(centerCd, workDay) {
    disabledDatesCache.set(`${centerCd}|${workDay}`, Date.now() + DISABLED_DATE_TTL_MS);
    console.log(`[抢号] 日期 ${centerCd} ${workDay} 此刻不可预约,${DISABLED_DATE_TTL_MS/1000} 秒后再试`);
}
function getDisabledDates(centerCd) {
    const now = Date.now();
    const out = [];
    for (const [k, exp] of disabledDatesCache.entries()) {
        if (exp <= now) { disabledDatesCache.delete(k); continue; }
        if (k.startsWith(centerCd + '|')) out.push(k.slice(centerCd.length + 1));
    }
    return out;
}

// 官网名额历史缓冲:近 30 分钟内每次探测到 check=true 的日期都记一条(同 (center, date) 60 秒内去重)
const AVAILABILITY_LOG_WINDOW_MS = 30 * 60e3;
const AVAILABILITY_DEDUPE_MS = 60e3;
const availabilityLog = []; // [{time: ms, centerCd, workDay}]
function recordAvailability(centerCd, workDay) {
    const now = Date.now();
    const cutoff = now - AVAILABILITY_LOG_WINDOW_MS;
    while (availabilityLog.length && availabilityLog[0].time < cutoff) availabilityLog.shift();
    for (let i = availabilityLog.length - 1; i >= 0; i--) {
        const e = availabilityLog[i];
        if (now - e.time > AVAILABILITY_DEDUPE_MS) break;
        if (e.centerCd === centerCd && e.workDay === workDay) return;
    }
    availabilityLog.push({ time: now, centerCd, workDay });
}
function getAvailabilityLog() {
    const cutoff = Date.now() - AVAILABILITY_LOG_WINDOW_MS;
    while (availabilityLog.length && availabilityLog[0].time < cutoff) availabilityLog.shift();
    return availabilityLog.slice().reverse();
}

// 后台常驻:每 60 秒扫一次每个已接入 center 的当月名额,不受订单状态影响,持续填充历史缓冲。
async function monitorAvailability() {
    console.log('[监控] 官网名额监控启动 (60 秒一次)');
    while (true) {
        try {
            if (!isSystemPaused()) {
                for (const centerCd of Object.values(CENTER_CD_MAP)) {
                    const dates = await scanCurrentMonthAvailability(centerCd);
                    dates.forEach((d) => recordAvailability(centerCd, d));
                }
            }
        } catch (error) {
            console.error('[监控] 请求异常');
        }
        await sleep(60000);
    }
}

// 跨月扫描并返回第一个"符合订单日期偏好"的可用日期;找不到返回 null
async function findMatchingDateForOrder(order, centerCd) {
    const monthsAhead = 4;
    const now = new Date();
    const latestMonthKey = order.apptLatest ? order.apptLatest.slice(0, 7) : null;
    for (let i = 0; i < monthsAhead; i++) {
        const target = new Date(now.getFullYear(), now.getMonth() + i, 1);
        const y = target.getFullYear();
        const m = String(target.getMonth() + 1).padStart(2, '0');
        const monthKey = `${y}-${m}`;
        if (latestMonthKey && monthKey > latestMonthKey) break;
        let days;
        try {
            const response = await koreaApi.post(
                `${GRAB_CONFIG.apiBase}/visitCntInfo`,
                { visit_type: 'month', visit_val: monthKey, center_cd: centerCd },
                { headers: { 'Content-Type': 'application/json' }, timeout: 5000 }
            );
            days = response.data;
        } catch (e) {
            continue;
        }
        if (!Array.isArray(days)) continue;
        for (const day of days) {
            if (day.check !== true) continue;
            const d = day.work_day;
            if (!isDate(d)) continue;
            if (isDateDisabled(centerCd, d)) continue;  // 反向学习:曾被官网 -1 拒绝的日期短期内跳过
            if (order.apptEarliest && d < order.apptEarliest) continue;
            if (order.apptLatest && d > order.apptLatest) continue;
            if (Array.isArray(order.apptExclude) && order.apptExclude.indexOf(d) >= 0) continue;
            return d;
        }
    }
    return null;
}

async function getAvailableSlot(date, centerCd) {
    try {
        const response = await koreaApi.post(
            `${GRAB_CONFIG.apiBase}/visitCntInfo`,
            { visit_type: 'day', visit_val: date, center_cd: centerCd },
            { headers: { 'Content-Type': 'application/json' }, timeout: 5000 }
        );
        const slots = response.data;
        if (!Array.isArray(slots)) return null;
        for (const slot of slots) {
            if (slot.check === true) return slot.work_hour;
        }
        return null;
    } catch (error) {
        return null;
    }
}

async function submitBooking(order, certifyKey, selectedDate, selectedHour, centerCd) {
    try {
        if (!order.exitDate || !/^\d{4}-\d{2}-\d{2}$/.test(order.exitDate)) {
            return { success: false, error: '缺少必填项：出境日子' };
        }
        const nextHour = String(parseInt(selectedHour) + 1).padStart(2, '0');
        const payload = {
            visit_sche_day: selectedDate,
            visit_sche_time: `${selectedHour}:00`,
            visit_sche_next_time: `${nextHour}:00`,
            nationality_cd: 'CN',
            purpose_cd: 'C-3-9',
            stay_duration_cd: '90',
            general_rsrv_cnt: String(order.applicants || 1),
            express_rsrv_cnt: '0',
            visa_relationship_cd: order.relation === '本人' ? 'SELF' : 'FAMILY',
            booker_nm: order.fullName.toUpperCase(),
            booker_phone: order.fullPhone,
            departure_day: order.exitDate,
            personal_info_agree_yn: 'Y',
            certify_key: certifyKey,
            certify_confirm: 'success',
            center_cd: centerCd
        };
        const response = await koreaApi.post(
            `${GRAB_CONFIG.apiBase}/insertJSON`,
            payload,
            { headers: { 'Content-Type': 'application/json' }, timeout: 15000 }
        );
        const result = response.data;
        if (result === 1) return { success: true };
        if (result === -3) return { success: false, error: '该手机号已预约过' };
        if (result === -4) return { success: false, error: '该时段已被抢完' };
        if (result === -1) {
            // -1 通常是"此刻这一天不可预约"——可能是名额刚被别人抢走 / datepicker 暂时禁选。
            // 短暂缓存(30 秒)避免同秒重试空转,过期后若 check=true 会再抢一次。
            markDateDisabled(centerCd, selectedDate);
            return { success: false, error: `日期 ${selectedDate} 此刻不可预约(可能刚被抢走),30 秒后重试` };
        }
        // 其他未知返回码：把响应体和状态一起打印，方便逆向官网 API 语义
        console.log(`[抢号] insertJSON 未知返回:`, JSON.stringify({ status: response.status }));
        return { success: false, error: `提交失败 (code: ${result})` };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

// ---- 定时发送验证码 ----
async function autoSendCertify() {
    console.log('[验证码] 定时任务启动，每5分钟检查并发送');
    setInterval(async () => {
        try {
            if (isSystemPaused()) return;
            const orders = getOrdersNeedCode();
            if (orders.length === 0) return;
            console.log(`[验证码] 为 ${orders.length} 个订单发送验证码`);
            for (const order of orders) {
                await sendCertifyForOrder(order);
                await sleep(2000);
            }
        } catch (err) {
            console.error('[验证码] 定时任务异常');
        }
    }, GRAB_CONFIG.sendInterval);
}

// ---- 抢号循环 ----
function getOrdersReadyToGrab() {
    cleanExpiredCodes();
    return readDb().orders.filter(o => {
        if (o.status !== 'processing') return false;
        if (o.autoPaused) return false;              // 运营关闭了该单的自动处理
        if (!CENTER_CD_MAP[o.region]) return false;
        if (!o._certifyConfirmed || !o._userSubmittedCode || !o._certifyKey) return false;
        if (isCodeExpired(o)) return false;
        if (o._lastGrabAttempt && (Date.now() - Date.parse(o._lastGrabAttempt)) < 5000) {
            return false;
        }
        return true;
    });
}

async function grabForOrder(order) {
    const centerCd = CENTER_CD_MAP[order.region];
    if (!centerCd) return { success: false, reason: '不支持的领区' };
    if (!order._certifyConfirmed || !order._userSubmittedCode || !order._certifyKey) {
        return { success: false, reason: '无有效验证码' };
    }
    if (isCodeExpired(order)) {
        updateOrder(order.id, (o) => {
            delete o._certifyConfirmed;
            delete o._certifyConfirmedAt;
        });
        return { success: false, reason: '验证码已过期' };
    }
    updateOrder(order.id, (o) => { o._lastGrabAttempt = new Date().toISOString(); });

    console.log(`[抢号] 订单 [订单] 开始抢号`);

    const availableDate = await findMatchingDateForOrder(order, centerCd);
    if (!availableDate) {
        console.log(`[抢号] ❌ 订单 [订单] 官网有名额但均不在日期偏好内 (${order.apptEarliest || '不限'} ~ ${order.apptLatest || '不限'})`);
        return { success: false, reason: '无符合日期偏好的档期' };
    }

    const availableHour = await getAvailableSlot(availableDate, centerCd);
    if (!availableHour) {
        console.log(`[抢号] ❌ 订单 [订单] 日期 ${availableDate} 无可用时段`);
        return { success: false, reason: '无可用时段' };
    }

    // 兜底：再校一次日期偏好，防止 findMatchingDateForOrder 漏检
    const apptStr = `${availableDate} ${availableHour}:00`;
    const violation = apptDateViolation(order, apptStr);
    if (violation) return { success: false, reason: '兜底校验拦截：' + violation };

    console.log(`[抢号] 订单 [订单]: 名额 ${apptStr}`);

    const current = readDb().orders.find(o => o.id === order.id);
    if (!current || current.status !== 'processing' || current.autoPaused || isSystemPaused()) {
        return { success: false, reason: '订单已停止处理' };
    }
    const submitResult = await submitBooking(order, order._certifyKey, availableDate, availableHour, centerCd);

    if (submitResult.success) {
        console.log(`✅ [抢号] 订单 [订单] 预约成功！`);
        const now = new Date().toISOString();
        const fresh = updateOrder(order.id, (o) => {
            o.status = 'success';
            o.receiptCode = '待从官网获取';
            o.appointmentTime = apptStr;
            o.updatedAt = now;
            delete o._certifyKey;
            delete o._userSubmittedCode;
            delete o._certifyConfirmed;
            delete o._certifyConfirmedAt;
            delete o._certifyRequestedAt;
        });
        if (fresh && fresh.status === 'success') await notifySuccess(fresh);
        return { success: true, receiptCode: '待从官网获取' };
    } else {
        console.log(`❌ [抢号] 订单 [订单] 提交失败: [请求失败]`);
        if (submitResult.error && submitResult.error.indexOf('已被抢完') >= 0) {
            return { success: false, reason: '名额已被抢完，继续等待' };
        }
        updateOrder(order.id, (o) => {
            delete o._certifyKey;
            delete o._userSubmittedCode;
            delete o._certifyConfirmed;
        });
        return { success: false, reason: submitResult.error };
    }
}

async function grabLoop() {
    console.log('[抢号] 启动自动抢号循环 (间隔: 1秒)');
    while (true) {
        try {
            if (isSystemPaused()) { await sleep(GRAB_CONFIG.checkInterval); continue; }
            const orders = getOrdersReadyToGrab();
            if (orders.length > 0) {
                // 按 center 分组做外层门控，避免每个订单都跨月扫描浪费官方接口
                const centers = new Set(orders.map(o => CENTER_CD_MAP[o.region]));
                for (const centerCd of centers) {
                    const dates = await scanCurrentMonthAvailability(centerCd);
                    dates.forEach((d) => recordAvailability(centerCd, d));
                    if (dates.length === 0) continue;
                    const centerOrders = orders.filter(o => CENTER_CD_MAP[o.region] === centerCd);
                    console.log(`[抢号] center=${centerCd} 检测到有名额！待处理订单: ${centerOrders.length}`);
                    for (const order of centerOrders) {
                        await grabForOrder(order);
                        await sleep(1500);
                    }
                }
            }
            await sleep(GRAB_CONFIG.checkInterval);
        } catch (error) {
            console.error('[抢号] 循环异常');
            await sleep(5000);
        }
    }
}

// ===== 启动服务器 =====
ensureDb();
migrateLegacyOrders();

const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'");
    try {
        const url = new URL(req.url, config.baseUrl);
        if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
        return serveStatic(req, res, url.pathname);
    } catch (e) {
        sendJson(res, e.status || 500, { error: e.status === 413 ? '请求内容过大' : e.status === 400 ? '请求格式错误' : '服务器错误' });
    }
});

server.listen(PORT, config.host, () => {
    console.log(`预约管理服务已启动: ${config.baseUrl}`);
    console.log(`短信通知: ${sms.enabled ? '已启用' : '演示模式(仅控制台打印)'}`);
    console.log(`运营后台: ${config.baseUrl}/admin.html  (使用配置的 ADMIN_TOKEN 登录)`);
    console.log('[系统] 自动抢号模块已启动');
    if (isSystemPaused()) {
        console.log('[系统] ⏸ 当前为「已暂停」状态（持久化）——抢号/发码/监控不会执行，直到运营在后台点「恢复」');
    }
    autoSendCertify();
    grabLoop();
    monitorAvailability();
});
