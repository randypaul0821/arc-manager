// ══════════ 账号 ══════════
async function loadAccounts() {
  const accounts = await api('/api/accounts');
  state.accounts.all = accounts;

  // 检查是否有同步错误，显示 Cookie 过期提示
  const hasError = accounts.some(a => a.active && (
    a.sync_status === 'error' || a.sync_status === 'cookie_expired' ||
    (a.sync_error || '').includes('404')
  ));
  const alertEl = document.getElementById('cookieAlert');
  if (alertEl) alertEl.style.display = hasError ? '' : 'none';
  const statusEl = document.getElementById('cookieStatus');
  if (statusEl) {
    if (hasError) {
      statusEl.innerHTML = '<span style="color:var(--danger)">● Cookie 可能过期</span>';
    } else if (accounts.some(a => a.active && a.sync_status === 'ok')) {
      statusEl.innerHTML = '<span style="color:var(--success)">● 连接正常</span>';
    } else {
      statusEl.textContent = '';
    }
  }

  // 排序
  const sortBy = document.getElementById('accountSort')?.value || 'name';
  if (sortBy === 'status') {
    const statusOrder = {error:0, cookie_expired:0, timeout:1, never:2, syncing:3, ok:4};
    accounts.sort((a, b) => {
      if (a.active !== b.active) return a.active ? -1 : 1;
      const sa = statusOrder[a.sync_status] ?? 3;
      const sb = statusOrder[b.sync_status] ?? 3;
      return sa - sb || a.name.localeCompare(b.name);
    });
  } else {
    accounts.sort((a, b) => a.name.localeCompare(b.name));
  }

  // 统一开关组件：CSS transition 实现丝滑动画
  const sw = (on, onclick, title) =>
    `<span class="toggle-switch${on ? ' on' : ''}" onclick="${onclick}" title="${title}">
      <span class="toggle-knob"></span>
    </span>`;

  document.getElementById('accountsBody').innerHTML = accounts.length
    ? accounts.map((a, idx) => {
      const paused = a.sync_paused;
      const inactive = !a.active;
      const statusLabel = {ok:'正常',ready:'待同步',never:'未同步',syncing:'同步中…',timeout:'超时',cookie_expired:'Cookie过期',error:'错误'}[a.sync_status]||a.sync_status;
      const statusClass = a.sync_status === 'ok' ? 'ok' : a.sync_status === 'ready' ? 'pending' : a.sync_status === 'never' ? 'pending' : 'error';

      return `
      <tr style="${inactive ? 'opacity:.4' : ''}">
        <td style="color:var(--text3);font-size:12px;text-align:center">${idx + 1}</td>
        <td>
          <input type="text" class="ghost-input" value="${(a.name||'').replace(/"/g,'&quot;')}"
            style="font-size:13px;font-weight:500;text-align:left;width:100%;padding:3px 6px"
            onblur="saveAccountName(${a.id},this.value)"
            onkeydown="if(event.key==='Enter'){this.blur()}">
        </td>
        <td>
          <input type="text" class="ghost-input" value="${(a.note||'').replace(/"/g,'&quot;')}" placeholder="—"
            style="font-size:12px;text-align:left;width:100%;padding:3px 6px"
            onblur="saveAccountNote(${a.id},this.value)"
            onkeydown="if(event.key==='Enter'){this.blur()}">
        </td>
        <td style="font-size:12px;color:var(--text2)">${a.used_slots||0}/${a.max_slots||0}</td>
        <td style="font-size:12px;color:var(--text2)">${fmtTime(a.last_sync)}</td>
        <td style="font-size:12px">
          ${inactive
            ? '<span class="badge error">已停用</span>'
            : `<span class="badge ${statusClass}">${statusLabel}</span>
               ${a.sync_error ? '<div style="font-size:10px;color:var(--danger);margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="'+escHtml(a.sync_error)+'">'+escHtml(a.sync_error)+'</div>' : ''}`
          }
        </td>
        <td style="text-align:center">${sw(a.active, `toggleActive(event,${a.id},${a.active?0:1})`, a.active?'点击停用':'点击启用')}</td>
        <td style="text-align:center">${inactive ? '<span style="color:var(--text3);font-size:11px">—</span>' : sw(!paused, `toggleSyncPaused(event,${a.id})`, paused?'点击恢复':'点击暂停')}</td>
        <td style="text-align:center"><button class="btn small" onclick="syncOne(${a.id})" id="syncbtn_${a.id}">↻</button></td>
        <td style="text-align:center;white-space:nowrap">
          <button class="btn small" onclick="manualLogin(${a.id})" style="border-color:var(--accent);color:var(--accent)" title="手动登录（弹出浏览器）">🔗</button>
          <button class="btn small" onclick="autoLoginRefresh(${a.id})" style="margin-left:2px;border-color:${a.arc_email?'var(--success)':'var(--text3)'};color:${a.arc_email?'var(--success)':'var(--text3)'}" title="${a.arc_email?'自动刷新（无头模式）':'需先手动登录并设置凭据'}" ${a.arc_email?'':'disabled'}>⚡</button>
          <button class="btn small" onclick="openArcCredentials(${a.id})" style="margin-left:2px" title="设置 arctracker 登录凭据">⚙</button>
        </td>
        <td style="text-align:center"><button class="btn small danger" onclick="deleteAccount(${a.id})">🗑</button></td>
      </tr>`}).join('')
    : '<tr><td colspan="11" class="empty">暂无账号，点击右上角添加</td></tr>';
}

/** 跳转到关注页并筛选指定账号 */
function goToWatch(accountId) {
  showPage('inventory');
  setInvTab('watch');
  setTimeout(() => {
    const sel = document.getElementById('watchAccountFilter');
    if (sel) { sel.value = accountId; loadWatchAlerts(); }
  }, 100);
}


function openAccountEditor() {
  document.getElementById('accName').value = '';
  document.getElementById('accNote').value = '';
  openModal('accountEditorModal');
  setTimeout(() => document.getElementById('accName').focus(), 100);
}

async function saveAccount() {
  const name = document.getElementById('accName').value.trim();
  const note = document.getElementById('accNote').value.trim();
  if (!name) return toast('账号名不能为空', 'error');
  const res = await api('/api/accounts', { method:'POST', body: JSON.stringify({name, note}) });
  if (res.error) return toast(res.error, 'error');
  toast('账号已添加，点 ⚡ 首次登录', 'success');
  closeModal('accountEditorModal');
  loadAccounts();
}

async function toggleActive(e, id, active) {
  // 先播动画
  e.currentTarget.classList.toggle('on');
  await api(`/api/accounts/${id}`, { method:'PUT', body: JSON.stringify({active}) });
  setTimeout(() => loadAccounts(), 200);
}

async function toggleSyncPaused(e, id) {
  e.currentTarget.classList.toggle('on');
  const res = await api(`/api/accounts/${id}/sync-paused`, { method:'POST' });
  if (res.error) return toast(res.error, 'error');
  setTimeout(() => loadAccounts(), 200);
}

let _noteSaveTimer = {};
async function saveAccountNote(id, note) {
  clearTimeout(_noteSaveTimer[id]);
  _noteSaveTimer[id] = setTimeout(async () => {
    await api(`/api/accounts/${id}`, { method:'PUT', body: JSON.stringify({note}) });
  }, 500);
}

let _nameSaveTimer = {};
async function saveAccountName(id, name) {
  name = name.trim();
  if (!name) return toast('账号名不能为空', 'error');
  clearTimeout(_nameSaveTimer[id]);
  _nameSaveTimer[id] = setTimeout(async () => {
    const res = await api(`/api/accounts/${id}`, { method:'PUT', body: JSON.stringify({name}) });
    if (res.error) toast(res.error, 'error');
  }, 500);
}

async function syncOne(id) {
  const btn = document.getElementById('syncbtn_'+id);
  if (btn) { btn.disabled = true; btn.textContent = '同步中...'; }
  const res = await api(`/api/accounts/${id}/sync`, { method:'POST' });
  toast(res.ok ? '同步成功' : '同步失败', res.ok ? 'success' : 'error');
  loadAccounts();
}

async function syncAll() {
  const btn = document.getElementById('syncAllBtn');
  btn.disabled = true; btn.textContent = '同步中...';
  const res = await api('/api/accounts/sync-all', { method:'POST' });
  btn.disabled = false; btn.textContent = '↻ 全量同步';
  if (res.error) {
    toast('全量同步失败: ' + res.error, 'error');
  } else {
    const r = res.results || {};
    const total = Object.keys(r).length;
    const ok = Object.values(r).filter(v => v === 'ok').length;
    if (total === 0) {
      toast('没有可同步的账号', 'warning');
    } else if (ok === total) {
      toast(`全量同步完成（${total}个账号全部成功）`, 'success');
    } else {
      toast(`同步完成：${ok}/${total} 成功`, ok > 0 ? 'warning' : 'error');
    }
  }
  loadAccounts();
}

async function deleteAccount(id) {
  if (!confirm('确认删除此账号及其所有库存数据？')) return;
  const res = await api(`/api/accounts/${id}`, { method:'DELETE' });
  if (res.error) {
    toast('删除失败: ' + res.error, 'error');
    return;
  }
  toast('已删除');
  loadAccounts();
}

// ══════════ arctracker 凭据 ══════════

function openArcCredentials(accountId) {
  const acc = state.accounts.all.find(a => a.id === accountId);
  if (!acc) return;
  document.getElementById('arcCredAccountId').value = accountId;
  document.getElementById('arcCredEmail').value = acc.arc_email || '';
  document.getElementById('arcCredPassword').value = acc.arc_password || '';
  document.getElementById('arcCredTitle').textContent = `设置「${acc.name}」的 arctracker 登录凭据`;
  openModal('arcCredModal');
  setTimeout(() => document.getElementById('arcCredEmail').focus(), 100);
}

async function saveArcCredentials() {
  const id = document.getElementById('arcCredAccountId').value;
  const email = document.getElementById('arcCredEmail').value.trim();
  const password = document.getElementById('arcCredPassword').value;
  if (!email || !password) return toast('邮箱和密码都不能为空', 'error');
  const res = await api(`/api/accounts/${id}`, { method:'PUT', body: JSON.stringify({ arc_email: email, arc_password: password }) });
  if (res.error) return toast(res.error, 'error');
  toast('凭据已保存', 'success');
  closeModal('arcCredModal');
  loadAccounts();
}

// ══════════ 手动登录 / 自动登录 ══════════

async function manualLogin(accountId) {
  const acc = state.accounts.all.find(a => a.id === accountId);
  const name = acc ? acc.name : `#${accountId}`;
  toast(`正在启动浏览器，请手动登录「${name}」的 arctracker 账号…`);
  const res = await api(`/api/accounts/${accountId}/auto-login/init`, { method: 'POST' });
  if (res.error) return toast(res.error, 'error');
  _pollAutoTask(accountId, name);
}

async function autoLoginRefresh(accountId) {
  const acc = state.accounts.all.find(a => a.id === accountId);
  const name = acc ? acc.name : `#${accountId}`;
  toast(`正在自动刷新「${name}」…`);
  const res = await api(`/api/accounts/${accountId}/auto-login/refresh`, { method: 'POST' });
  if (res.error) return toast(res.error, 'error');
  _pollAutoTask(accountId, name);
}

async function autoLoginBatchRefresh() {
  const withCreds = state.accounts.all.filter(a => a.active && a.arc_email);
  if (!withCreds.length) { toast('没有已设置凭据的活跃账号，请先点 ⚙ 设置', 'error'); return; }
  toast(`正在批量登录 ${withCreds.length} 个账号…`);
  const res = await api('/api/auto-login/batch-refresh', { method: 'POST' });
  if (res.error) return toast(res.error, 'error');
  toast(`已启动 ${res.started} 个账号刷新` + (res.skipped ? `，跳过 ${res.skipped} 个` : ''), 'success');

  // 轮询直到全部完成
  const poll = setInterval(async () => {
    const sr = await api('/api/auto-login/status');
    const tasks = sr.tasks || {};
    const active = Object.values(tasks).some(t => t.status === 'refreshing' || t.status === 'starting' || t.status === 'binding_steam');
    if (!active) {
      clearInterval(poll);
      toast('批量刷新完成', 'success');
      loadAccounts();
    }
  }, 3000);
  setTimeout(() => clearInterval(poll), 300000);
}

function _waitSyncDone(accountId) {
  let checks = 0;
  const t = setInterval(async () => {
    checks++;
    const acc = await api(`/api/accounts/${accountId}`);
    if (!acc || acc.sync_status !== 'syncing' || checks > 30) {
      clearInterval(t);
      loadAccounts();
    }
  }, 2000);
}

let _autoLoginPoll = null;
let _lastAutoLoginMsg = '';  // 用于检测 message 变化，避免重复弹 toast
function _pollAutoTask(accountId, name) {
  if (_autoLoginPoll) clearInterval(_autoLoginPoll);
  let ticks = 0;
  _lastAutoLoginMsg = '';
  _autoLoginPoll = setInterval(async () => {
    ticks++;
    const res = await api('/api/auto-login/status');
    const task = (res.tasks || {})[accountId];
    if (!task || task.status === 'ok') {
      clearInterval(_autoLoginPoll); _autoLoginPoll = null;
      toast(`「${name}」${task ? task.message : 'Cookie 已更新'}，正在同步...`, 'success');
      loadAccounts();
      // Cookie 刷新后主动触发一次同步，然后等待同步完成再刷新 UI
      api(`/api/accounts/${accountId}/sync`, { method: 'POST' }).then(() => loadAccounts());
      _waitSyncDone(accountId);
    } else if (task.status === 'steam_expired') {
      clearInterval(_autoLoginPoll); _autoLoginPoll = null;
      toast(`「${name}」${task.message}`, 'error');
      loadAccounts();
      _waitSyncDone(accountId);
    } else if (task.status === 'error' || task.status === 'timeout' || task.status === 'expired') {
      clearInterval(_autoLoginPoll); _autoLoginPoll = null;
      toast(`「${name}」${task.message}`, 'error');
      loadAccounts();
    } else if (task.status === 'starting' && ticks > 15) {
      clearInterval(_autoLoginPoll); _autoLoginPoll = null;
      toast(`「${name}」Chrome 启动失败，请确认已关闭所有 Chrome 窗口后重试`, 'error');
      loadAccounts();
    } else if ((task.status === 'waiting' || task.status === 'binding_steam') && task.message && task.message !== _lastAutoLoginMsg) {
      // message 变化时弹 toast（如：登录成功、Steam绑定中等）
      _lastAutoLoginMsg = task.message;
      toast(`「${name}」${task.message}`, 'info');
    }
  }, 2000);
  // 首次登录需要更长时间（登录+绑Steam），最多轮询 15 分钟
  setTimeout(() => { if (_autoLoginPoll) { clearInterval(_autoLoginPoll); _autoLoginPoll = null; loadAccounts(); } }, 900000);
}

// ══════════ AI 设置 ══════════
async function loadAiSettings() {
  const res = await api('/api/settings/ai');
  const badge = document.getElementById('aiStatusBadge');
  if (res.configured) {
    badge.textContent = `已配置 (${res.source === 'env' ? '环境变量' : '数据库'})`;
    badge.style.background = 'rgba(34,197,94,.12)';
    badge.style.color = '#16a34a';
  } else {
    badge.textContent = '未配置';
    badge.style.background = 'rgba(239,68,68,.08)';
    badge.style.color = 'var(--danger)';
  }
}

async function saveAiKey() {
  const key = document.getElementById('aiApiKeyInput').value.trim();
  if (!key) return toast('请输入 API Key', 'error');
  const res = await api('/api/settings/ai', {
    method: 'POST', body: JSON.stringify({ api_key: key })
  });
  if (res.error) return toast(res.error, 'error');
  document.getElementById('aiApiKeyInput').value = '';
  toast('API Key 已保存', 'success');
  loadAiSettings();
}

async function deleteAiKey() {
  if (!confirm('确认清除 API Key？清除后将使用纯本地模糊匹配。')) return;
  await api('/api/settings/ai', { method: 'DELETE' });
  toast('API Key 已清除');
  loadAiSettings();
}

