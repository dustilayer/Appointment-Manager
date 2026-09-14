const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

const root = path.resolve(__dirname, '..');

test('direct submission, lifecycle, removed routes and legacy upgrade', { timeout: 20000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'appointment-test-'));
  // Run a separate copy with no user configuration or real orders.
  for (const file of ['server.js', 'config.js']) fs.copyFileSync(path.join(root, file), path.join(dir, file));
  for (const folder of ['lib', 'public']) fs.cpSync(path.join(root, folder), path.join(dir, folder), { recursive: true });
  fs.mkdirSync(path.join(dir, 'data'));
  const old = { paused: true, orders: ['pending', 'paid', 'refunded', 'success'].map(status => ({
    id: 'legacy-' + status, status, region: '上海中心', fullPhone: '00000000000', fullName: '旧测试',
    createdAt: '2020-01-01T00:00:00Z', paidAt: '2020-01-01T00:00:00Z',
    price: 1.9, alipayTradeNo: 'historical-record', _certifyKey: 'old-key', verificationCode: '123456'
  })) };
  fs.writeFileSync(path.join(dir, 'data/db.json'), JSON.stringify(old));
  const listener = net.createServer();
  listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
  const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
  const token = 'local-test-only-0123456789-abcdefgh';
  const env = { ...process.env, HOST: '127.0.0.1', NODE_PATH: path.join(root, 'node_modules'), PORT: String(port),
    BASE_URL: 'http://127.0.0.1:' + port, ADMIN_TOKEN: token, SMS_PROVIDER: '', SMS_INGEST_TOKEN: '' };
  // An outbound network attempt fails the test, including accidental monitoring.
  fs.writeFileSync(path.join(dir, 'block-network.cjs'), `
    for (const mod of [require('http'), require('https')]) {
      mod.request = mod.get = () => { console.error('UNEXPECTED_OUTBOUND_REQUEST'); throw new Error('Network disabled in tests'); };
    }
  `);
  let logs = '';
  const child = spawn(process.execPath, ['--require', './block-network.cjs', 'server.js'], { cwd: dir, env, windowsHide: true });
  child.stdout.on('data', x => { logs += x; }); child.stderr.on('data', x => { logs += x; });
  t.after(async () => {
    if (child.exitCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; }
    assert.equal(logs.includes('UNEXPECTED_OUTBOUND_REQUEST'), false, logs);
    const resolved = fs.realpathSync(dir);
    assert.equal(path.dirname(resolved).toLowerCase(), fs.realpathSync(os.tmpdir()).toLowerCase());
    assert.ok(path.basename(resolved).startsWith('appointment-test-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  async function req(url, method = 'GET', body, admin = false) {
    const res = await fetch(env.BASE_URL + url, { method, headers: { 'Content-Type': 'application/json',
      ...(admin ? { Authorization: 'Bearer ' + token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text(); let data; try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, data, headers: res.headers };
  }
  for (let i = 0; i < 100; i++) {
    try { if ((await req('/api/regions')).status === 200) break; } catch {}
    if (child.exitCode !== null) throw Error(logs);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  const regions = await req('/api/regions'); assert.equal(regions.status, 200);
  assert.equal(regions.headers.get('cache-control'), 'no-store');
  assert.equal(regions.headers.get('referrer-policy'), 'no-referrer');
  assert.match(regions.headers.get('content-security-policy'), /script-src 'self';/);
  assert.deepEqual(Object.keys(regions.data), ['regions']);
  const migrated = JSON.parse(fs.readFileSync(path.join(dir, 'data/db.json')));
  assert.deepEqual(migrated.orders.map(o => o.status), ['processing', 'processing', 'cancelled', 'success']);
  assert.equal(migrated.orders[0].autoPaused, true);
  assert.equal(migrated.orders[1].alipayTradeNo, 'historical-record');
  assert.equal(migrated.orders[2]._certifyKey, undefined);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'data/db.json.before-payment-removal.bak'))), old);

  const payload = { name: '测试申请人', phone: '00000000000', region: '广州中心', exitDate: '2030-06-30',
    apptEarliest: '2030-06-01', apptLatest: '2030-06-20', apptExclude: ['2030-06-10'] };
  const created = await req('/api/orders', 'POST', payload); assert.equal(created.status, 201);
  const o = created.data.order; assert.equal(o.status, 'processing'); assert.equal(o.autoPaused, false);
  assert.equal(o.automationEnabled, false);
  for (const key of ['price', 'payProvider', 'paidAt', 'alipayTradeNo']) assert.equal(key in o, false);
  const id = encodeURIComponent(o.id);
  const recovered = await req('/api/orders/recover', 'POST', { name: payload.name, phone: payload.phone });
  assert.equal(recovered.status, 200); assert.equal(recovered.data.orders[0].id, o.id);
  assert.equal((await req('/api/orders/recover', 'POST', { phone: payload.phone, tradeNo: 'historical-record' })).status, 400);
  assert.equal((await req('/api/admin/orders/' + id + '/cancel', 'POST', {})).status, 401);
  assert.equal((await req('/api/admin/orders/' + id + '/request-code', 'POST', {}, true)).status, 200);
  assert.equal((await req('/api/orders/' + id + '/code', 'POST', { code: '123456' })).status, 200);
  const cancelled = await req('/api/admin/orders/' + id + '/cancel', 'POST', {}, true);
  assert.equal(cancelled.data.order.status, 'cancelled'); assert.equal(cancelled.data.order.verificationCode, null);
  assert.equal((await req('/api/orders/' + id + '/code', 'POST', { code: '123456' })).status, 400);
  assert.equal((await req('/api/admin/orders/' + id + '/confirm', 'POST', { receiptCode: 'TEST' }, true)).status, 409);
  const second = (await req('/api/orders', 'POST', payload)).data.order;
  const confirmUrl = '/api/admin/orders/' + encodeURIComponent(second.id) + '/confirm';
  assert.equal((await req(confirmUrl, 'POST', {}, true)).status, 400);
  assert.equal((await req(confirmUrl, 'POST', { receiptCode: 'TEST-ONLY', appointmentTime: '2030-06-10 10:00' }, true)).status, 409);
  const confirmed = await req(confirmUrl, 'POST', { receiptCode: 'TEST-ONLY', appointmentTime: '2030-06-11 10:00' }, true);
  assert.equal(confirmed.data.order.status, 'success');
  assert.equal((await req(confirmUrl, 'POST', { receiptCode: 'TEST-CORRECTED', appointmentTime: '2030-06-11 10:00' }, true)).status, 200);
  assert.equal((await req('/api/admin/orders/' + second.id + '/cancel', 'POST', {}, true)).status, 409);
  for (const url of ['/api/orders/' + id + '/pay', '/api/alipay/notify', '/api/admin/orders/' + id + '/refund']) {
    assert.equal((await req(url, 'POST', {}, true)).status, 404, url);
  }
  assert.equal((await req('/pay.html')).status, 404);
  assert.equal((await req('/api/admin/orders')).status, 401);
  for (const url of ['/.env', '/%2eenv', '/%2e%2e%5cconfig.js', '/data/db.json', '/config.js']) {
    assert.ok([403, 404].includes((await req(url)).status), url);
  }
  const crossOrigin = await fetch(env.BASE_URL + '/api/orders', { method: 'POST', headers: { Origin: 'https://untrusted.example', 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  assert.equal(crossOrigin.status, 403);
  const invalidJson = await fetch(env.BASE_URL + '/api/orders', { method: 'POST', body: '{' });
  assert.equal(invalidJson.status, 400);
  const oversized = await fetch(env.BASE_URL + '/api/orders', { method: 'POST', body: JSON.stringify({ name: 'x'.repeat(40000) }) });
  assert.equal(oversized.status, 413);
  assert.equal((await req('/api/orders', 'POST', { ...payload, name: { html: 'invalid' } })).status, 400);
  assert.equal((await req('/api/orders', 'POST', { ...payload, applicantList: Array(4).fill({ name: 'extra' }) })).status, 400);
  for (const file of fs.readdirSync(path.join(root, 'public')).filter(x => x.endsWith('.html'))) {
    const page = await req('/' + file); assert.equal(page.status, 200, file);
    assert.doesNotMatch(page.data, /支付宝|支付|退款|¥1\.9|initPay|pay\.html/);
    for (const match of page.data.matchAll(/(?:href|src)="([^"#?]+)(?:[?#][^"]*)?"/g)) {
      if (/^https?:|^\/\//.test(match[1])) continue;
      assert.equal((await req('/' + match[1])).status, 200, file + ' -> ' + match[1]);
    }
  }
  assert.equal(logs.includes('00000000000'), false, 'phone must not be logged');
  assert.equal(logs.includes('123456'), false, 'verification code must not be logged');
  assert.equal(logs.includes(o.id), false, 'bearer order ID must not be logged');
});
