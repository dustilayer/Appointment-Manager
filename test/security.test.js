const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');

test('configuration rejects missing, placeholder and shared credentials', () => {
  for (const values of [{ ADMIN_TOKEN: '' }, { ADMIN_TOKEN: 'change-me-to-a-long-random-string' },
    { ADMIN_TOKEN: 'a'.repeat(32), SMS_INGEST_TOKEN: 'a'.repeat(32) }]) {
    const result = spawnSync(process.execPath, ['-e', "require('./config')"], {
      cwd: root, env: { ...process.env, SMS_INGEST_TOKEN: '', ...values }, encoding: 'utf8', windowsHide: true });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Set ADMIN_TOKEN|SMS_INGEST_TOKEN must/);
  }
  const result = spawnSync(process.execPath, ['-e', "console.log(require('./config').host)"], {
    cwd: root, env: { ...process.env, HOST: '', ADMIN_TOKEN: 'a'.repeat(32), SMS_INGEST_TOKEN: '' }, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0); assert.equal(result.stdout.trim(), '127.0.0.1');
});

test('frontend escapes untrusted markup and has no inline script requirement', () => {
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(root, 'public/app.js'), 'utf8'), context);
  assert.equal(context.escapeHtml('<img src=x onerror="alert(1)">'), '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
  assert.equal(context.escapeHtml("'&"), '&#39;&amp;');
  for (const file of fs.readdirSync(path.join(root, 'public')).filter(f => f.endsWith('.html'))) {
    const html = fs.readFileSync(path.join(root, 'public', file), 'utf8');
    assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/i, file);
    assert.doesNotMatch(html, /\son(?:click|error|load)=/i, file);
  }
});
