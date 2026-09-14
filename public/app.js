function escapeHtml(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, c => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[c]));
}
// ===== KVISA 韩签助手 — 前端逻辑 =====

async function api(path, opts) {
  const res = await fetch(path, Object.assign({ headers: { 'Content-Type': 'application/json' } }, opts));
  const data = await res.json().catch(function () { return {}; });
  if (!res.ok) throw new Error(data.error || ('请求失败 ' + res.status));
  return data;
}

function qs(name) { return new URLSearchParams(location.search).get(name); }

var toastEl, toastTimer;
function showToast(msg) {
  if (!toastEl) { toastEl = document.createElement('div'); toastEl.className = 'toast'; document.body.appendChild(toastEl); }
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { toastEl.classList.remove('show'); }, 2000);
}

var STATUS_TEXT = { processing: '处理中', success: '预约成功', cancelled: '已取消' };

// 把订单的日期偏好拼成一句话：如"2026-07-13 前 · 排除 07-20"
function apptRangeText(o) {
  var parts = [];
  if (o.apptEarliest && o.apptLatest) parts.push(o.apptEarliest + ' 至 ' + o.apptLatest);
  else if (o.apptLatest) parts.push(o.apptLatest + ' 及之前');
  else if (o.apptEarliest) parts.push(o.apptEarliest + ' 及之后');
  if (o.apptExclude && o.apptExclude.length) parts.push('排除 ' + o.apptExclude.join('、'));
  return parts.length ? parts.join('；') : '不限日期';
}

/* ---------- FAQ 折叠（首页 / 帮助中心共用） ---------- */
function bindFaq() {
  document.querySelectorAll('.faq-q').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var item = btn.closest('.faq-item');
      var open = item.classList.contains('open');
      document.querySelectorAll('.faq-item.open').forEach(function (el) { el.classList.remove('open'); });
      if (!open) item.classList.add('open');
    });
  });
}

/* ---------- 首页：FAQ + 领区行 ---------- */
function initHome() {
  bindFaq();
  document.querySelectorAll('.region-row').forEach(function (row) {
    row.addEventListener('click', function () {
      location.href = 'booking.html?region=' + encodeURIComponent(row.dataset.region);
    });
  });
}

/* ---------- 恢复订单 ---------- */
function initRecover() {
  var errEl = document.getElementById('formError');
  var form = document.getElementById('recoverForm');
  var submitBtn = document.getElementById('recoverBtn');
  var resultsEl = document.getElementById('recoverResults');

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    errEl.textContent = '';
    resultsEl.innerHTML = '';
    var payload = { phone: form.phone.value.trim() };
    payload.name = form.name.value.trim();
    if (!/^\d{11}$/.test(payload.phone)) { errEl.textContent = '请填写下单时使用的 11 位手机号'; return; }
    if (!payload.name) { errEl.textContent = '请填写下单姓名'; return; }
    submitBtn.disabled = true; submitBtn.textContent = '查询中…';
    api('/api/orders/recover', { method: 'POST', body: JSON.stringify(payload) })
      .then(function (d) {
        resultsEl.innerHTML = '<div class="rr-head">找到 ' + d.orders.length + ' 笔订单，点击查看：</div>' +
          d.orders.map(function (o) {
            return '<a class="result-row" href="order.html?id=' + encodeURIComponent(o.id) + '">' +
              '<span class="rr-id">订单 ' + escapeHtml(o.shortId) + '</span>' +
              '<span class="rr-info">' + escapeHtml(o.region) + ' · ' + escapeHtml(o.maskedName) + ' · ' + escapeHtml((o.createdAt || '').slice(0, 10)) + '</span>' +
              '<span class="rr-status">' + escapeHtml(STATUS_TEXT[o.status] || '未知状态') + ' →</span></a>';
          }).join('');
      })
      .catch(function (err) { errEl.textContent = err.message; })
      .then(function () { submitBtn.disabled = false; submitBtn.textContent = '找回订单'; });
  });
}

/* ---------- 预约表单 ---------- */
function initBooking() {
  var region = qs('region') || '上海中心';
  var provincesEl = document.getElementById('regionProvinces');
  var titleEl = document.getElementById('regionTitle');
  var errEl = document.getElementById('formError');
  var form = document.getElementById('bookingForm');
  var submitBtn = document.getElementById('submitBtn');

  titleEl.textContent = region + ' · 预约信息';
  api('/api/regions').then(function (d) {
    if (d.regions[region]) {
      provincesEl.innerHTML = d.regions[region].split('、').map(function (p) {
        return '<span class="tag">' + p + '</span>';
      }).join('');
    }
  });

  // 排除日期动态增删
  var excludeWrap = document.getElementById('excludeDates');
  var addExcludeBtn = document.getElementById('addExclude');
  if (addExcludeBtn) {
    addExcludeBtn.addEventListener('click', function () {
      if (excludeWrap.querySelectorAll('.exclude-date').length >= 10) { showToast('最多排除 10 个日期'); return; }
      var row = document.createElement('div');
      row.className = 'field exclude-date';
      row.innerHTML = '<label>排除日期 <span class="hint">这一天不预约</span></label>' +
        '<div style="display:flex;gap:10px">' +
        '<input type="date" class="exclude-input" style="flex:1" />' +
        '<button type="button" class="btn-sm danger remove-exclude" style="flex:0 0 auto">删除</button></div>';
      excludeWrap.appendChild(row);
      row.querySelector('.remove-exclude').onclick = function () { row.remove(); };
    });
  }

  // 附加申请人动态增删
  var extraWrap = document.getElementById('extraApplicants');
  var addBtn = document.getElementById('addApplicant');
  if (addBtn) {
    addBtn.addEventListener('click', function () {
      if (extraWrap.querySelectorAll('.extra-applicant').length >= 3) { showToast('最多 4 名申请人'); return; }
      var row = document.createElement('div');
      row.className = 'field extra-applicant';
      row.innerHTML = '<label>附加申请人姓名 <span class="hint">与护照一致</span></label>' +
        '<div style="display:flex;gap:10px">' +
        '<input type="text" class="extra-name" placeholder="请输入姓名" autocomplete="off" style="flex:1" />' +
        '<button type="button" class="btn-sm danger remove-applicant" style="flex:0 0 auto">删除</button></div>';
      extraWrap.appendChild(row);
      row.querySelector('.remove-applicant').onclick = function () { row.remove(); };
    });
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    errEl.textContent = '';
    var extras = Array.prototype.map.call(document.querySelectorAll('.extra-name'), function (i) { return { name: i.value.trim() }; })
      .filter(function (a) { return a.name; });
    var exclude = Array.prototype.map.call(document.querySelectorAll('.exclude-input'), function (i) { return i.value; })
      .filter(function (d) { return d; });
    var payload = {
      region: region,
      name: form.name.value.trim(),
      phone: form.phone.value.trim(),
      relation: form.relation.value,
      exitDate: form.exitDate.value,
      apptEarliest: form.apptEarliest.value,
      apptLatest: form.apptLatest.value,
      apptExclude: exclude,
      applicantList: extras,
    };
    if (!payload.name) { errEl.textContent = '请填写主申请人姓名'; return; }
    if (!/^\d{11}$/.test(payload.phone)) { errEl.textContent = '请填写 11 位手机号'; return; }
    if (payload.apptEarliest && payload.apptLatest && payload.apptEarliest > payload.apptLatest) {
      errEl.textContent = '可接受的最早日期不能晚于最晚日期'; return;
    }
    submitBtn.disabled = true; submitBtn.textContent = '提交中…';
    api('/api/orders', { method: 'POST', body: JSON.stringify(payload) })
      .then(function (d) { location.href = 'order.html?id=' + encodeURIComponent(d.order.id); })
      .catch(function (err) {
        errEl.textContent = err.message; submitBtn.disabled = false; submitBtn.textContent = '提交预约';
      });
  });
}

/* ---------- 订单页（动态） ---------- */
function initOrder() {
  var id = qs('id');
  var root = document.getElementById('orderRoot');
  if (!id) { root.innerHTML = '<p style="text-align:center;color:#64748b;padding:40px">缺少订单号</p>'; return; }

  function render(o) {
    document.getElementById('osId').textContent = '订单 ' + o.shortId;
    document.getElementById('osName').textContent = o.maskedName;
    var pill = document.getElementById('osStatus');
    pill.textContent = STATUS_TEXT[o.status] || o.status;
    pill.className = 'order-status' +
      (o.status === 'processing' ? ' status-pill-processing' : o.status === 'cancelled' ? ' status-pill-cancelled' : '');

    var success = document.getElementById('successCard');
    var processing = document.getElementById('processingCard');
    var cancelled = document.getElementById('cancelledCard');
    [success, processing, cancelled].forEach(function (el) { el.classList.add('state-hide'); });

    if (o.status === 'success') {
      success.classList.remove('state-hide');
      document.getElementById('confirmTitle').textContent = o.region + '预约申请确认书';
      document.getElementById('receiptCode').textContent = o.receiptCode || '—';
      document.getElementById('dProvinces').textContent = o.regionProvinces;
      document.getElementById('dVisaType').textContent = o.visaType;
      document.getElementById('dAppt').textContent = o.appointmentTime || '待官网确认';
      document.getElementById('dName').textContent = o.maskedName;
      document.getElementById('dRelation').textContent = o.relation;
      document.getElementById('dPhone').textContent = o.maskedPhone;
      document.getElementById('dExit').textContent = o.exitDate || '—';
      var apptReq = apptRangeText(o);
      document.getElementById('dApptReq').textContent = apptReq;
      document.getElementById('dApptReqRow').classList.toggle('state-hide', apptReq === '不限日期');
      var applicantsText = '一般 ' + o.applicants + ' 名';
      if (o.applicantNames && o.applicantNames.length > 1) applicantsText += '（' + o.applicantNames.join('、') + '）';
      document.getElementById('dApplicants').textContent = applicantsText;
      document.getElementById('dCenter').textContent = o.region;
      var copyBtn = document.getElementById('copyBtn');
      copyBtn.onclick = function () {
        var code = o.receiptCode || '';
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(code).then(function () { showToast('已复制受理编号'); });
        else showToast('已复制受理编号');
      };
    } else if (o.status === 'cancelled') {
      cancelled.classList.remove('state-hide');
    } else {
      processing.classList.remove('state-hide');
      var msg = o.autoPaused ? '该订单已暂停自动处理，请联系运营人员确认后继续。'
        : o.region !== '上海中心' ? '订单已提交，当前领区由运营人员人工处理。'
        : '订单已提交，系统将按您的日期偏好处理预约。请留意验证码与进度信息；最终结果请在官网核对。';
      document.getElementById('processingMsg').textContent = msg;
      var reqEl = document.getElementById('processingApptReq');
      var rangeText = apptRangeText(o);
      if (reqEl) {
        reqEl.textContent = '您的日期要求：' + rangeText + '。只有符合此要求的名额才会为您预约。';
        reqEl.classList.toggle('state-hide', rangeText === '不限日期');
      }
      var pDphoneEl = document.getElementById('pDphone');
      if (pDphoneEl) pDphoneEl.textContent = o.maskedPhone || '—';
      var pDdatePrefEl = document.getElementById('pDdatePref');
      if (pDdatePrefEl) pDdatePrefEl.textContent = rangeText;
      renderCodeBox(o);
      renderAutoCertifyBox(o);
    }
  }

  // 自动抢号验证码：后端 autoSendCertify 已从官网拿到 certifyKey 时出现输入框
  function renderAutoCertifyBox(o) {
    var pendingBox = document.getElementById('autoCertifyBox');
    var doneBox = document.getElementById('autoCertifyDone');
    var waitingBox = document.getElementById('autoCertifyWaiting');
    if (!pendingBox || !doneBox) return;
    var showPending = o.automationEnabled && o.certifyPending && !o.certifyConfirmed;
    var showDone = o.automationEnabled && o.certifyConfirmed;
    // 空档期：处理中 但既没验证码在等确认、也没确认过 → 处于两次发码之间的等待
    var showWaiting = o.automationEnabled && !o.certifyPending && !o.certifyConfirmed;
    pendingBox.classList.toggle('state-hide', !showPending);
    doneBox.classList.toggle('state-hide', !showDone);
    if (waitingBox) waitingBox.classList.toggle('state-hide', !showWaiting);
    if (showDone && o.certifyConfirmedAt) {
      var expiresAt = Date.parse(o.certifyConfirmedAt) + 5 * 60 * 1000;
      var remainingMs = expiresAt - Date.now();
      var msgEl = document.getElementById('autoCertifyDoneMsg');
      if (msgEl && remainingMs > 0) {
        var min = Math.floor(remainingMs / 60000);
        var sec = Math.floor((remainingMs % 60000) / 1000);
        var pad = sec < 10 ? '0' + sec : String(sec);
        msgEl.textContent = '验证码有效剩余 ' + min + ':' + pad + '。一旦有符合日期偏好的名额，系统会自动为您完成预约。';
      }
    }
    var resendRow = document.getElementById('resendCertifyRow');
    if (resendRow) {
      var showResend = o.automationEnabled && !o.certifyConfirmed;
      resendRow.classList.toggle('state-hide', !showResend);
      if (showResend && !resendRow.dataset.bound) {
        resendRow.dataset.bound = '1';
        document.getElementById('resendCertifyBtn').addEventListener('click', function () {
          var btn = document.getElementById('resendCertifyBtn');
          var errEl = document.getElementById('resendCertifyErr');
          errEl.textContent = '';
          btn.disabled = true;
          btn.textContent = '发送中…';
          api('/api/orders/' + encodeURIComponent(o.id) + '/resend-certify', { method: 'POST' })
            .then(function (d) {
              showToast(d.message || '已请求重发');
              btn.textContent = '已发送';
              setTimeout(function () { btn.disabled = false; btn.textContent = '重新发送'; }, 30000);
              load();
            })
            .catch(function (e) {
              errEl.textContent = e.message;
              btn.disabled = false;
              btn.textContent = '重新发送';
            });
        });
      }
    }

    if (!showPending || pendingBox.dataset.bound) return;
    pendingBox.dataset.bound = '1';
    document.getElementById('autoCertifySubmit').addEventListener('click', function () {
      var input = document.getElementById('autoCertifyInput');
      var errEl = document.getElementById('autoCertifyErr');
      var code = input.value.trim();
      errEl.textContent = '';
      if (!/^\d{4,8}$/.test(code)) { errEl.textContent = '请输入短信中的 4-8 位数字验证码'; return; }
      api('/api/orders/' + encodeURIComponent(o.id) + '/certify', { method: 'POST', body: JSON.stringify({ certifyNo: code }) })
        .then(function (d) { input.value = ''; showToast(d.message || '验证码已确认'); load(); })
        .catch(function (e) { errEl.textContent = e.message; });
    });
  }

  // 验证码输入框：运营发起"索要验证码"后出现；提交后转为等待提示
  function renderCodeBox(o) {
    var box = document.getElementById('codeBox');
    var done = document.getElementById('codeDone');
    if (!box) return;
    var windowMs = 10 * 60e3;
    var waiting = o.status === 'processing' && o.codeRequestedAt && !o.codeSubmittedAt &&
      (Date.now() - Date.parse(o.codeRequestedAt) < windowMs);
    box.classList.toggle('state-hide', !waiting);
    done.classList.toggle('state-hide', !(o.status === 'processing' && o.codeSubmittedAt));
    if (!waiting || box.dataset.bound) return;
    box.dataset.bound = '1';
    document.getElementById('codeSubmit').addEventListener('click', function () {
      var input = document.getElementById('codeInput');
      var errEl = document.getElementById('codeErr');
      var code = input.value.trim();
      errEl.textContent = '';
      if (!/^\d{4,8}$/.test(code)) { errEl.textContent = '请输入短信中的 4–8 位数字验证码'; return; }
      api('/api/orders/' + encodeURIComponent(o.id) + '/code', { method: 'POST', body: JSON.stringify({ code: code }) })
        .then(function () { input.value = ''; showToast('验证码已提交，系统将自动为您抢约'); load(); })
        .catch(function (e) { errEl.textContent = e.message; });
    });
  }

  function load() {
    api('/api/orders/' + encodeURIComponent(id))
      .then(function (d) { render(d.order); })
      .catch(function (e) { root.innerHTML = '<p style="text-align:center;color:#64748b;padding:40px">' + escapeHtml(e.message) + '</p>'; });
  }
  load();
  // 处理中状态下轮询，运营一确认就自动刷新为成功
  setInterval(function () {
    var pill = document.getElementById('osStatus');
    if (pill && pill.textContent.indexOf('处理中') >= 0) load();
  }, 5000);

  // 官网名额动态：每 10 秒拉一次，只在处理中时轮询
  function pollAvailability() {
    var listEl = document.getElementById('availabilityList');
    var dotEl = document.getElementById('apDot');
    var winEl = document.getElementById('apWindowMin');
    if (!listEl) return;
    api('/api/availability-log').then(function (d) {
      if (winEl && d.windowMinutes) winEl.textContent = d.windowMinutes;
      if (dotEl) { dotEl.style.background = '#22c55e'; setTimeout(function () { dotEl.style.background = '#94a3b8'; }, 500); }
      var entries = d.entries || [];
      var disabledByCenter = d.disabledByCenter || {};
      if (entries.length === 0) {
        listEl.innerHTML = '<div style="color:#94a3b8;text-align:center;padding:8px 0">近期无名额出现</div>';
        return;
      }
      listEl.innerHTML = entries.map(function (e) {
        var t = new Date(e.time);
        var hh = String(t.getHours()).padStart(2, '0');
        var mm = String(t.getMinutes()).padStart(2, '0');
        var ss = String(t.getSeconds()).padStart(2, '0');
        var disabledList = disabledByCenter[e.centerCd] || [];
        var isDisabled = disabledList.indexOf(e.workDay) >= 0;
        var dateStyle = isDisabled ? 'color:#94a3b8;text-decoration:line-through' : 'color:#111';
        var badge = isDisabled ? ' <span style="font-size:10px;color:#a3a3a3;margin-left:4px">此刻不可选</span>' : '';
        return '<div style="display:flex;justify-content:space-between;padding:3px 0;border-bottom:1px dashed #e5e7eb">'
          + '<span style="color:#64748b">' + hh + ':' + mm + ':' + ss + '</span>'
          + '<span style="' + dateStyle + '">' + escapeHtml(e.workDay) + badge + '</span>'
          + '</div>';
      }).join('');
    }).catch(function () { /* 静默失败 */ });
  }
  pollAvailability();
  setInterval(function () {
    var pill = document.getElementById('osStatus');
    if (pill && pill.textContent.indexOf('处理中') >= 0) pollAvailability();
  }, 10000);
}

/* ---------- 运营后台 ---------- */
function initAdmin() {
  var token = sessionStorage.getItem('kvisa_admin_token') || '';
  var loginBox = document.getElementById('loginBox');
  var panel = document.getElementById('adminPanel');

  function headers() { return { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token }; }

  var refreshTimer;
  function showPanel() {
    loginBox.classList.add('state-hide'); panel.classList.remove('state-hide'); loadOrders(); loadSystem();
    // 自动刷新：等待用户提交验证码时无需手动刷新页面
    clearInterval(refreshTimer);
    refreshTimer = setInterval(function () { if (!document.querySelector('.modal-backdrop')) { loadOrders(); loadSystem(); } }, 8000);
  }

  // ---- 系统运行总开关 ----
  function renderSystem(d) {
    var paused = !!d.paused;
    var panelEl = document.getElementById('sysPanel');
    var dot = document.getElementById('sysDot');
    var title = document.getElementById('sysTitle');
    var sub = document.getElementById('sysSub');
    var btn = document.getElementById('sysToggleBtn');
    if (!panelEl) return;
    panelEl.classList.toggle('is-paused', paused);
    dot.className = 'sys-dot ' + (paused ? 'is-paused' : 'is-running');
    btn.disabled = false;
    btn.dataset.paused = paused ? '1' : '0';
    if (paused) {
      title.textContent = '● 已暂停';
      sub.textContent = (d.pausedAt ? '自 ' + new Date(d.pausedAt).toLocaleString() + ' 起，' : '') +
        '系统不再对官网发起任何自动操作（抢号 / 发码 / 监控），处理中订单暂时挂起。';
      btn.textContent = '▶ 恢复自动预约';
      btn.className = 'btn-sm primary';
    } else {
      title.textContent = '● 运行中';
      sub.textContent = '系统正在实时监测官网并自动为处理中订单发码 / 抢约。';
      btn.textContent = '⏸ 暂停自动预约';
      btn.className = 'btn-sm danger';
    }
  }
  function loadSystem() {
    fetch('/api/admin/system', { headers: headers() })
      .then(function (r) { return r.json(); })
      .then(function (d) { if (!d.error) renderSystem(d); })
      .catch(function () {});
  }
  document.getElementById('sysToggleBtn').addEventListener('click', function () {
    var btn = this;
    var action = btn.dataset.paused === '1' ? 'resume' : 'pause';
    btn.disabled = true;
    fetch('/api/admin/system/' + action, { method: 'POST', headers: headers() })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d.error) { btn.disabled = false; showToast(d.error); return; }
        renderSystem(d);
        showToast(d.paused ? '已暂停：不再对官网发起自动操作' : '已恢复：系统重新开始监测/抢约');
      })
      .catch(function () { btn.disabled = false; showToast('操作失败'); });
  });

  document.getElementById('loginBtn').addEventListener('click', function () {
    token = document.getElementById('tokenInput').value.trim();
    fetch('/api/admin/orders', { headers: headers() }).then(function (r) {
      if (r.ok) { sessionStorage.setItem('kvisa_admin_token', token); showPanel(); }
      else { document.getElementById('loginErr').textContent = '令牌错误'; }
    });
  });
  document.getElementById('logoutBtn').addEventListener('click', function () {
    sessionStorage.removeItem('kvisa_admin_token'); location.reload();
  });

  function badge(s) {
    if (!Object.prototype.hasOwnProperty.call(STATUS_TEXT, s)) s = 'unknown';
    var map = { processing: '处理中', success: '预约成功', cancelled: '已取消' };
    return '<span class="badge badge-' + s + '">' + escapeHtml(map[s] || '未知状态') + '</span>';
  }

  // 验证码列：展示索要/等待/已提交三种状态；验证码提交后运营需尽快使用（官方有效期约 5 分钟）
  function codeCell(o) {
    if (o.status !== 'processing') return '—';
    if (o.verificationCode) {
      var age = o.codeSubmittedAt ? Math.round((Date.now() - Date.parse(o.codeSubmittedAt)) / 60e3) : 0;
      return '<strong style="font-family:monospace;font-size:15px">' + escapeHtml(o.verificationCode) + '</strong>' +
        '<br><span style="color:#a3a3a3">' + age + ' 分钟前提交</span>';
    }
    if (o.codeRequestedAt) return '<span style="color:#a3a3a3">等待用户输入…</span>';
    return '—';
  }

  function loadOrders() {
    fetch('/api/admin/orders', { headers: headers() }).then(function (r) { return r.json(); }).then(function (d) {
      var tbody = document.getElementById('ordersBody');
      if (!d.orders || !d.orders.length) { tbody.innerHTML = '<tr><td colspan="9" class="admin-empty">暂无订单</td></tr>'; return; }
      window.__orders = Object.create(null);
      tbody.innerHTML = d.orders.map(function (o) {
        window.__orders[o.id] = o;
        var actions = '';
        if (o.status === 'processing') {
          actions += '<button class="btn-sm" data-auto="' + escapeHtml(o.id) + '">' + (o.autoPaused ? '▶ 开启自动' : '⏸ 关闭自动') + '</button>';
          actions += '<button class="btn-sm" data-reqcode="' + escapeHtml(o.id) + '">索要验证码</button>';
          actions += '<button class="btn-sm primary" data-confirm="' + escapeHtml(o.id) + '">确认预约</button>';
        }
        if (o.status === 'success') actions += '<button class="btn-sm" data-confirm="' + escapeHtml(o.id) + '">核对受理编号</button>';
        if (o.status !== 'cancelled' && o.status !== 'success') actions += '<button class="btn-sm danger" data-cancel="' + escapeHtml(o.id) + '">取消订单</button>';
        actions += '<a class="btn-sm" href="order.html?id=' + encodeURIComponent(o.id) + '" target="_blank">查看</a>';
        var range = apptRangeText(o);
        var rangeCell = range === '不限日期'
          ? '<span style="color:#a3a3a3">不限</span>'
          : '<strong>' + escapeHtml(range) + '</strong>';
        return '<tr>' +
          '<td>' + escapeHtml(o.id.split('-')[1]) + '</td>' +
          '<td>' + escapeHtml(o.region) + '</td>' +
          '<td>' + escapeHtml(o.fullName) + '<br><span style="color:#94a3b8">' + escapeHtml(o.fullPhone) + '</span></td>' +
          '<td>' + escapeHtml(o.exitDate || '—') + '</td>' +
          '<td>' + rangeCell + '</td>' +
          '<td>' + badge(o.status) + (o.status === 'processing' && o.autoPaused ? '<br><span style="color:#b91c1c;font-size:12px">⏸ 自动已关</span>' : '') + '</td>' +
          '<td>' + codeCell(o) + '</td>' +
          '<td>' + escapeHtml(o.receiptCode || '—') + '</td>' +
          '<td>' + actions + '</td></tr>';
      }).join('');
      tbody.querySelectorAll('[data-confirm]').forEach(function (b) { b.onclick = function () { openConfirm(b.dataset.confirm); }; });
      tbody.querySelectorAll('[data-cancel]').forEach(function (b) { b.onclick = function () { doCancel(b.dataset.cancel); }; });
      tbody.querySelectorAll('[data-reqcode]').forEach(function (b) { b.onclick = function () { requestCode(b.dataset.reqcode); }; });
      tbody.querySelectorAll('[data-auto]').forEach(function (b) { b.onclick = function () { toggleAuto(b.dataset.auto); }; });
    });
  }

  function toggleAuto(id) {
    var o = (window.__orders || {})[id] || {};
    var next = !o.autoPaused;
    fetch('/api/admin/orders/' + encodeURIComponent(id) + '/auto', { method: 'POST', headers: headers(), body: JSON.stringify({ paused: next }) })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d.error) { showToast(d.error); return; }
        loadOrders(); showToast(next ? '已关闭该订单的自动处理' : '已开启该订单的自动处理');
      });
  }

  function requestCode(id) {
    fetch('/api/admin/orders/' + encodeURIComponent(id) + '/request-code', { method: 'POST', headers: headers() })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d.error) { showToast(d.error); return; }
        loadOrders(); showToast('已通知用户填写验证码');
      });
  }

  function openConfirm(id) {
    var o = (window.__orders || {})[id] || {};
    var range = apptRangeText(o);
    var reqLine = range === '不限日期' ? '' :
      '<div class="modal-note">用户日期要求：<strong>' + escapeHtml(range) + '</strong>。请填写符合要求的预约时间。</div>';
    var backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    backdrop.innerHTML =
      '<div class="modal"><h3>确认预约成功</h3>' +
      reqLine +
      '<div class="field"><label>受理编号 <span class="hint">必填 · 官网预约完成后返回的真实编号</span></label><input id="mCode" placeholder="官网受理编号"></div>' +
      '<div class="field"><label>预约时间 <span class="hint">建议含日期，用于核对是否符合用户要求</span></label><input id="mAppt" placeholder="2026-07-16 15:30"></div>' +
      '<label style="display:none;align-items:center;gap:8px;font-size:13px;margin:2px 0 12px" id="mForceWrap"><input type="checkbox" id="mForce" style="width:auto">仍要确认（预约日期不符合用户要求）</label>' +
      '<div class="form-error" id="mErr"></div>' +
      '<div style="display:flex;gap:10px;margin-top:10px">' +
      '<button class="btn-sm" id="mCancel" style="flex:1;padding:12px">取消</button>' +
      '<button class="btn-sm primary" id="mOk" style="flex:1;padding:12px">确认</button></div></div>';
    document.body.appendChild(backdrop);
    backdrop.querySelector('#mCancel').onclick = function () { backdrop.remove(); };
    backdrop.querySelector('#mOk').onclick = function () {
      var code = backdrop.querySelector('#mCode').value.trim();
      if (!code) { backdrop.querySelector('#mErr').textContent = '必须填写官网返回的真实受理编号'; return; }
      var body = {
        receiptCode: code,
        appointmentTime: backdrop.querySelector('#mAppt').value,
        force: backdrop.querySelector('#mForce').checked,
      };
      fetch('/api/admin/orders/' + encodeURIComponent(id) + '/confirm', { method: 'POST', headers: headers(), body: JSON.stringify(body) })
        .then(function (r) { return r.json(); })
        .then(function (d) {
          if (d.needsOverride) {
            backdrop.querySelector('#mForceWrap').style.display = 'flex';
            backdrop.querySelector('#mErr').textContent = d.error;
            return;
          }
          if (d.error) { backdrop.querySelector('#mErr').textContent = d.error; return; }
          backdrop.remove(); loadOrders(); showToast('已确认预约成功');
        });
    };
  }

  function doCancel(id) {
    fetch('/api/admin/orders/' + encodeURIComponent(id) + '/cancel', { method: 'POST', headers: headers() })
      .then(function (r) { return r.json(); })
      .then(function (d) { if (d.error) { showToast(d.error); return; } loadOrders(); showToast('已取消'); })
      .catch(function (e) { showToast(e.message); });
  }

  if (token) {
    fetch('/api/admin/orders', { headers: headers() }).then(function (r) { if (r.ok) showPanel(); });
  }
}
