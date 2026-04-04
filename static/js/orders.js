'use strict';

// ══════════ 订单列表 + 详情 + CRUD ══════════

let _completedDays = 0; // 0=全部
let _completedFrom = '';
let _completedTo   = '';
const _selectedOrders = new Set();
let _orderMultiSelect = localStorage.getItem('order_multi_select') === '1';
let _orderDetailId = null; // 当前展开详情的订单ID

function setOrderTab(status, btn) {
  state.orders.activeTab = status;
  // 更新 sidebar 子菜单 active 状态
  document.querySelectorAll('#orderSubNav .nav-sub-item[data-tab]').forEach(b => b.classList.remove('active'));
  const subItem = document.querySelector(`#orderSubNav .nav-sub-item[data-tab="${status}"]`);
  if (subItem) subItem.classList.add('active');
  const shortageEl = document.getElementById('shortageSection');
  if (shortageEl) shortageEl.style.display = status === 'pending' ? '' : 'none';
  // 显隐 completed 筛选工具栏
  const toolbar = document.getElementById('orderToolbar');
  if (toolbar) toolbar.style.display = status === 'completed' ? '' : 'none';
  const exportBtn = document.getElementById('exportDailyBtn');
  if (exportBtn) exportBtn.style.display = status === 'completed' ? '' : 'none';
  loadOrders();
}

function setCompletedDays(days, btn) {
  _completedDays = days;
  _completedFrom = '';
  _completedTo   = '';
  const f = document.getElementById('orderDateFrom');
  const t = document.getElementById('orderDateTo');
  if (f) f.value = '';
  if (t) t.value = '';
  document.querySelectorAll('#completedFilters .tag-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  loadOrders();
}

function setCompletedRange() {
  const f = document.getElementById('orderDateFrom')?.value || '';
  const t = document.getElementById('orderDateTo')?.value || '';
  if (!f && !t) return;
  _completedFrom = f;
  _completedTo   = t || f;
  _completedDays = 0;
  document.querySelectorAll('#completedFilters .tag-btn').forEach(b => b.classList.remove('active'));
  loadOrders();
}

async function loadOrders() {
  const status = state.orders.activeTab || 'pending';
  let url = `/api/orders?status=${status}`;
  if (status === 'completed') {
    if (_completedFrom) {
      // 自定义日期范围：用 days=0 拉全部，前端过滤
      // 不用 days 参数，直接拉全量再 filter
    } else if (_completedDays > 0) {
      url += `&days=${_completedDays}`;
    }
  }
  let orders = await api(url);

  // 自定义日期范围：前端过滤
  if (status === 'completed' && _completedFrom) {
    const from = _completedFrom;
    const to   = _completedTo || '9999-12-31';
    orders = (orders || []).filter(o => {
      const d = (o.completed_at || o.created_at || '').slice(0, 10);
      return d >= from && d <= to;
    });
  }

  state.orders.all = orders || [];

  if (status === 'pending') {
    Object.keys(_orderIdToIdx).forEach(k => delete _orderIdToIdx[k]);
    orders.forEach((o, idx) => { _orderIdToIdx[o.id] = idx + 1; });
    // 清理已不存在的订单选择，默认选第一个
    const ids = new Set(orders.map(o => o.id));
    [..._selectedOrders].forEach(id => { if (!ids.has(id)) _selectedOrders.delete(id); });
    if (!_selectedOrders.size && orders.length) _selectedOrders.add(orders[0].id);
  }

  renderOrdersFromCache();
}

function renderOrdersFromCache() {
  const orders    = state.orders.all || [];
  const status    = state.orders.activeTab || 'pending';
  const isPending = status === 'pending';
  const isCompleted = status === 'completed';

  // ── 缺货预计算（待处理用） ──
  const shortageMap = isPending ? new Map(_shortageData.map(s => [s.item_id, s])) : null;
  const selectedNeedMap = new Map();
  if (isPending && _selectedOrders.size > 1) {
    for (const so of orders) {
      if (!_selectedOrders.has(so.id)) continue;
      for (const si of (so.items || [])) {
        selectedNeedMap.set(si.item_id, (selectedNeedMap.get(si.item_id) || 0) + si.quantity);
      }
    }
  }
  const calcShortage = (it, isSelected) => {
    if (!isPending || !shortageMap) return 0;
    const iid = it.item_id;
    const useAll = !isSelected;
    const need = _selectedOrders.size > 1 && isSelected ? (selectedNeedMap.get(iid) || it.quantity) : it.quantity;
    const sd = shortageMap.get(iid);
    if (sd) { const stock = _calcStockForItem(sd, useAll); return Math.max(0, need - stock); }
    if (iid.startsWith('__bundle__') && _bundleItemsMap[iid]) {
      for (const subId of _bundleItemsMap[iid]) {
        const sub = shortageMap.get(subId);
        if (sub && _calcStockForItem(sub, useAll) < need) return 1;
      }
      return 0;
    }
    return it.shortage || 0;
  };

  // ── 单行渲染（简化版：行卡片） ──
  const renderRow = (o, idx) => {
    const items = o.items || [];
    const revenue = o.total_revenue || 0;
    const isSelected = _selectedOrders.has(o.id);
    const timeStr = isCompleted ? fmtTime(o.completed_at) : fmtTime(o.created_at);

    let statusHtml = '';
    if (isPending) {
      const itemShortages = items.map(it => ({ ...it, _shortage: calcShortage(it, isSelected) }));
      const shortCount = itemShortages.filter(it => it._shortage > 0 && !_shortageGathered.has(it.item_id)).length;
      const readyCount = items.length - shortCount;
      statusHtml = shortCount === 0
        ? `<span style="color:var(--success);font-size:11px">✓ ${items.length}件备齐</span>`
        : `<span style="color:var(--text3);font-size:11px">${readyCount}/${items.length} 备齐</span> <span style="color:var(--danger);font-size:11px">缺${shortCount}件</span>`;
    } else {
      statusHtml = `<span style="font-size:11px;color:var(--text3)">${items.length}件物品</span>`;
    }

    const isActive = _orderDetailId === o.id;
    const chk = _selectedOrders.has(o.id);
    const fadeCls = isPending && !chk ? ' faded' : '';
    return `<div class="order-row${isActive ? ' active' : ''}${fadeCls}" id="orow_${o.id}" onclick="openOrderDetail(${o.id})">
      ${isPending ? `<div class="order-row-check" onclick="event.stopPropagation()"><input type="checkbox" class="ck" ${chk?'checked':''} onchange="toggleOrderSelect(${o.id},this.checked)"></div>` : ''}
      <div class="order-row-main">
        <div class="order-row-name">${o.customer_name || '订单 #'+o.id}</div>
        <div class="order-row-sub">${statusHtml}</div>
      </div>
      <div class="order-row-meta">
        <div class="order-row-amount">${revenue ? '¥'+fmtPrice(revenue) : ''}</div>
        <div class="order-row-time">${timeStr}</div>
      </div>
    </div>`;
  };

  const container = document.getElementById('ordersListContainer');
  if (!container) return;

  if (!orders.length) {
    container.innerHTML = `<div class="empty">暂无${isPending?'待处理':isCompleted?'已完成':'已归档'}订单</div>`;
    return;
  }

  // 已完成：按日期分组
  if (isCompleted) {
    const getDate = o => (o.completed_at || o.created_at || '').slice(0, 10);
    const groups = {};
    orders.forEach(o => {
      const d = getDate(o);
      if (!groups[d]) groups[d] = [];
      groups[d].push(o);
    });
    const dates = Object.keys(groups).sort().reverse();

    let html = '';
    let globalIdx = 0;
    for (const date of dates) {
      const dayOrders = groups[date];
      const dayRev    = dayOrders.reduce((s,o) => s + (o.total_revenue||0), 0);

      // 日期分组头
      html += `<div style="padding:8px 14px;background:var(--accent-light);border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between">
        <div><span style="font-size:13px;font-weight:700;color:var(--accent)">${date}</span>
          <span style="margin-left:8px;padding:1px 7px;border-radius:4px;font-size:11px;font-weight:600;background:rgba(134,120,255,.15);color:var(--accent)">${dayOrders.length} 单</span></div>
        <span style="font-size:12px;font-weight:600;color:var(--text2)">¥${fmtPrice(dayRev)}</span>
      </div>`;

      for (const o of dayOrders) {
        globalIdx++;
        html += renderRow(o, globalIdx);
      }
    }

    container.innerHTML = html;
  } else {
    // 待处理/已归档：平铺行卡片
    container.innerHTML = orders.map((o, idx) => renderRow(o, idx + 1)).join('');
  }
  if (isPending) _updateOrderCheckAll();
}

function toggleOrderItems(id) {
  const more = document.getElementById('omore_' + id);
  const btn  = document.getElementById('obtn_'  + id);
  if (!more) return;
  const expanded = more.style.display !== 'none';
  more.style.display = expanded ? 'none' : 'inline';
  if (btn) btn.style.display = expanded ? '' : 'none';
}


// ══════════ 订单选择（多选开关）══════════

function toggleOrderSelect(id, checked) {
  if (_orderMultiSelect) {
    if (checked) _selectedOrders.add(id); else _selectedOrders.delete(id);
  } else {
    _selectedOrders.clear();
    _selectedOrders.add(id);
  }
  renderOrdersFromCache();
  renderShortage();
  renderInstock();
  _updateOrderCheckAll();
}

function toggleAllOrders(checked) {
  const orders = (state.orders.all || []).filter(o => (state.orders.activeTab || 'pending') === 'pending');
  _selectedOrders.clear();
  if (checked) orders.forEach(o => _selectedOrders.add(o.id));
  renderOrdersFromCache();
  renderShortage();
  renderInstock();
}

function toggleOrderMultiSelect(checked) {
  _orderMultiSelect = checked;
  localStorage.setItem('order_multi_select', checked ? '1' : '0');
  if (!checked && _selectedOrders.size > 1) {
    const first = [..._selectedOrders][0];
    _selectedOrders.clear();
    _selectedOrders.add(first);
    renderOrdersFromCache();
    renderShortage();
    renderInstock();
  }
}

function _updateOrderCheckAll() {
  const el = document.getElementById('orderCheckAll');
  if (!el) return;
  const orders = state.orders.all || [];
  const isPending = (state.orders.activeTab || 'pending') === 'pending';
  if (!isPending) return;
  el.checked = orders.length > 0 && orders.every(o => _selectedOrders.has(o.id));
  el.indeterminate = !el.checked && orders.some(o => _selectedOrders.has(o.id));
  const ms = document.getElementById('orderMultiSelect');
  if (ms) ms.checked = _orderMultiSelect;
}

// ══════════ 日报导出 ══════════

async function exportDailyReport() {
  // 计算日期范围
  let dateFrom = _completedFrom, dateTo = _completedTo;
  if (!dateFrom || !dateTo) {
    const now = new Date();
    if (_completedDays > 0) {
      const from = new Date(now); from.setDate(from.getDate() - _completedDays);
      dateFrom = from.toISOString().slice(0, 10);
      dateTo = now.toISOString().slice(0, 10);
    } else {
      // 默认今天
      dateFrom = dateTo = now.toISOString().slice(0, 10);
    }
  }

  const [sellRes, costRes] = await Promise.all([
    api(`/api/orders/export?from=${dateFrom}&to=${dateTo}&type=sell`),
    api(`/api/orders/export?from=${dateFrom}&to=${dateTo}&type=cost`),
  ]);

  if (sellRes.error) { toast(sellRes.error, 'error'); return; }

  const modalTitle = document.getElementById('shortageModalTitle');
  const modalBody = document.getElementById('shortageModalBody');
  modalTitle.textContent = `订单日报 ${dateFrom} ~ ${dateTo}`;
  modalBody.innerHTML = `
    <div style="display:flex;gap:12px;margin-bottom:10px">
      <button class="tag-btn active" id="exportTabSell" onclick="switchExportTab('sell')">售价版（给甲方）</button>
      <button class="tag-btn" id="exportTabCost" onclick="switchExportTab('cost')">成本版（内部）</button>
    </div>
    <textarea id="exportSellText" style="width:100%;height:400px;font-size:13px;line-height:1.8;background:var(--bg2);color:var(--text1);border:1px solid var(--border);border-radius:6px;padding:10px;font-family:inherit;resize:vertical">${sellRes.text||''}</textarea>
    <textarea id="exportCostText" style="width:100%;height:400px;font-size:13px;line-height:1.8;background:var(--bg2);color:var(--text1);border:1px solid var(--border);border-radius:6px;padding:10px;font-family:inherit;resize:vertical;display:none">${costRes.text||''}</textarea>
    <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:10px">
      <button class="btn" onclick="copyExportText()">📋 复制</button>
      <button class="btn" onclick="downloadExportText()">💾 下载</button>
      <button class="btn" onclick="closeModal('shortageModal')">关闭</button>
    </div>`;
  document.getElementById('shortageModal').style.display = 'flex';

  window._exportDateRange = { from: dateFrom, to: dateTo };
}

function switchExportTab(tab) {
  const sellEl = document.getElementById('exportSellText');
  const costEl = document.getElementById('exportCostText');
  const sellBtn = document.getElementById('exportTabSell');
  const costBtn = document.getElementById('exportTabCost');
  if (tab === 'sell') {
    sellEl.style.display = ''; costEl.style.display = 'none';
    sellBtn.classList.add('active'); costBtn.classList.remove('active');
  } else {
    sellEl.style.display = 'none'; costEl.style.display = '';
    sellBtn.classList.remove('active'); costBtn.classList.add('active');
  }
}

function copyExportText() {
  const sell = document.getElementById('exportSellText');
  const cost = document.getElementById('exportCostText');
  const text = sell.style.display !== 'none' ? sell.value : cost.value;
  navigator.clipboard.writeText(text).then(() => toast('已复制', 'success'));
}

function downloadExportText() {
  const sell = document.getElementById('exportSellText');
  const cost = document.getElementById('exportCostText');
  const isSell = sell.style.display !== 'none';
  const text = isSell ? sell.value : cost.value;
  const range = window._exportDateRange || {};
  const suffix = isSell ? '售价' : '成本';
  const filename = `订单导出-${range.from||''}\_${range.to||''}-${suffix}.txt`;
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

// ══════════ 订单详情 ══════════

async function openOrderDetail(id) {
  _orderDetailId = id;
  // 高亮当前行
  document.querySelectorAll('.order-row').forEach(r => r.classList.remove('active'));
  const row = document.getElementById('orow_' + id);
  if (row) row.classList.add('active');

  const order = await api(`/api/orders/${id}`);
  const el = document.getElementById('orderDetailContent');
  const emptyEl = document.getElementById('orderDetailEmpty');
  if (emptyEl) emptyEl.style.display = 'none';
  el.style.display = '';

  const items = order.items || [];
  const isPending = order.status === 'pending';
  const totalCost = items.reduce((s,it) => s + (it.cost_price||0) * it.quantity, 0);
  const totalSell = items.reduce((s,it) => s + (it.sell_price||0) * it.quantity, 0);
  const totalProfit = totalSell - totalCost;

  el.innerHTML = `
    <div class="detail-header">
      <div>
        <div style="font-size:14px;font-weight:700;color:var(--text1)">${order.customer_name || '订单 #'+order.id}</div>
        <div style="font-size:11px;color:var(--text3);margin-top:2px">${fmtTime(order.created_at)} · ${items.length}件物品</div>
      </div>
      <div style="display:flex;gap:4px">
        ${isPending ? `<button class="btn small" style="color:var(--success);border-color:var(--success)" onclick="completeOrder(${id},true)">完成</button>` : ''}
        ${isPending ? `<button class="btn small" style="color:var(--danger);border-color:var(--danger)" onclick="cancelOrder(${id},true)">取消</button>` : ''}
        <button class="btn small" style="color:var(--danger);border-color:var(--danger)" onclick="deleteOrder(${id})">删除</button>
      </div>
    </div>
    <div class="detail-body">
      <!-- 客户 -->
      <div class="detail-section">
        <div class="detail-section-title">客户</div>
        <div style="display:flex;gap:6px;align-items:center">
          <input type="text" id="detailCustomer" value="${order.customer_name||''}" placeholder="客户名..." style="flex:1;font-size:13px;padding:6px 10px">
          <button class="btn small" onclick="saveOrderCustomer(${id})">保存</button>
        </div>
      </div>
      <!-- 金额汇总 -->
      <div class="detail-section" style="display:flex;gap:0;padding:0">
        <div style="flex:1;text-align:center;padding:10px 0">
          <div style="font-size:11px;color:var(--text3);margin-bottom:4px">成本</div>
          <div id="detailTotalCost" style="font-size:16px;font-weight:700;color:var(--danger)">${fmtPrice(totalCost)}</div>
        </div>
        <div style="width:1px;background:var(--border)"></div>
        <div style="flex:1;text-align:center;padding:10px 0">
          <div style="font-size:11px;color:var(--text3);margin-bottom:4px">售价</div>
          <div id="detailTotalSell" style="font-size:16px;font-weight:700;color:var(--text1)">${fmtPrice(totalSell)}</div>
        </div>
        <div style="width:1px;background:var(--border)"></div>
        <div style="flex:1;text-align:center;padding:10px 0">
          <div style="font-size:11px;color:var(--text3);margin-bottom:4px">利润</div>
          <div id="detailTotalProfit" style="font-size:16px;font-weight:700;color:${totalProfit>=0?'var(--success)':'var(--danger)'}">${totalProfit>=0?'+':''}${fmtPrice(totalProfit)}</div>
        </div>
      </div>
      <!-- 物品列表 -->
      <div style="padding:10px 16px 6px"><span class="detail-section-title">物品 (${items.length})</span></div>
      ${items.map(it => {
        const isReady = !isPending || it.ready || _shortageGathered.has(it.item_id);
        const isBundle = it.is_bundle || (it.item_id||'').startsWith('__bundle__');
        const displayName = it.name_zh || (isBundle ? '📦 '+it.item_id.replace('__bundle__','') : it.item_id);
        return `
        <div id="oirow_${it.id}" style="display:flex;align-items:center;gap:10px;padding:8px 16px;border-bottom:1px solid var(--border)">
          <div style="width:36px;height:36px;flex-shrink:0;border-radius:6px;background:var(--bg2);border:1px solid var(--border);overflow:hidden;display:flex;align-items:center;justify-content:center">
            ${isBundle ? '<span style="font-size:18px">📦</span>' : `<img src="/api/items/${it.item_id}/image" style="width:30px;height:30px;object-fit:contain" onerror="this.style.opacity=.2">`}
          </div>
          <div style="flex:1;min-width:0">
            <div style="font-size:13px;font-weight:600;color:var(--text1);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${displayName}</div>
            <div style="font-size:11px;color:var(--text3);margin-top:1px">×${it.quantity}${isPending ? (isReady ? ' · <span style="color:var(--success)">✓</span>' : ' · <span style="color:var(--danger)">缺货</span>') : ''}</div>
          </div>
          <div style="flex-shrink:0;display:flex;gap:2px;align-items:center">
            <input type="number" class="ghost-input oi-price" data-id="${it.id}" data-qty="${it.quantity}" data-field="cost"
              value="${it.cost_price||0}" min="0" step="0.1" style="width:52px;font-size:12px;text-align:right" onfocus="this.select()" oninput="recalcOrderTotals()" onblur="autoSaveItemPrice(this,${id})">
            <span style="color:var(--text3);font-size:10px">/</span>
            <input type="number" class="ghost-input oi-price" data-id="${it.id}" data-qty="${it.quantity}" data-field="sell"
              value="${it.sell_price||0}" min="0" step="0.1" style="width:52px;font-size:12px;text-align:right" onfocus="this.select()" oninput="recalcOrderTotals()" onblur="autoSaveItemPrice(this,${id})">
          </div>
        </div>`;
      }).join('')}
    </div>`;
}

function recalcOrderTotals() {
  let totalCost = 0, totalSell = 0;
  const items = {};
  document.querySelectorAll('.oi-price').forEach(el => {
    const id = el.dataset.id;
    const qty = parseInt(el.dataset.qty||1);
    if (!items[id]) items[id] = { qty, cost:0, sell:0 };
    if (el.dataset.field === 'cost') items[id].cost = parseFloat(el.value)||0;
    else items[id].sell = parseFloat(el.value)||0;
  });
  for (const [id, it] of Object.entries(items)) {
    totalCost += it.cost * it.qty;
    totalSell += it.sell * it.qty;
    const profitEl = document.querySelector(`.oi-profit[data-id="${id}"]`);
    if (profitEl) {
      const p = (it.sell - it.cost) * it.qty;
      profitEl.textContent = (p>=0?'+':'')+fmtPrice(p);
      profitEl.style.color = p>=0?'#5ec484':'#f06060';
    }
  }
  const profit = totalSell - totalCost;
  const ce = document.getElementById('detailTotalCost');
  const se = document.getElementById('detailTotalSell');
  const pe = document.getElementById('detailTotalProfit');
  if (ce) ce.textContent = fmtPrice(totalCost);
  if (se) se.textContent = fmtPrice(totalSell);
  if (pe) { pe.textContent = (profit>=0?'+':'')+fmtPrice(profit); pe.style.color = profit>=0?'#5ec484':'#f06060'; }
}

const _priceSaveTimers = {};
function autoSaveItemPrice(el, orderId) {
  const id = el.dataset.id;
  const costEl = document.querySelector(`.oi-price[data-id="${id}"][data-field="cost"]`);
  const sellEl = document.querySelector(`.oi-price[data-id="${id}"][data-field="sell"]`);
  const cost = parseFloat(costEl?.value)||0;
  const sell = parseFloat(sellEl?.value)||0;
  clearTimeout(_priceSaveTimers[id]);
  _priceSaveTimers[id] = setTimeout(async () => {
    await api(`/api/order-items/${id}/price`, { method:'PUT', body: JSON.stringify({ cost_price: cost, sell_price: sell }) });
    loadOrders();
  }, 300);
}

async function toggleReady(itemId, ready) {
  await api(`/api/order-items/${itemId}/ready`, { method:'PUT', body: JSON.stringify({ready}) });
  const row = document.getElementById('oirow_'+itemId);
  if (row) row.querySelector('.ready-btn').textContent = ready ? '✅' : '❗';
}

let _swapTimer = null;
function startItemSwap(oiId, orderId) {
  const cell = document.getElementById('oicell_' + oiId);
  if (!cell || cell.querySelector('.swap-search')) return;
  cell.innerHTML = `<div class="swap-search" style="position:relative">
      <input type="text" placeholder="搜索物品名称..." autocomplete="off" style="width:100%;font-size:12px;padding:4px 8px"
        oninput="swapSearchInput(${oiId},${orderId},this.value)" autofocus>
      <div id="swap_dd_${oiId}" class="ac-dropdown" style="display:none;position:absolute;top:100%;left:0;right:0;z-index:500"></div>
    </div>`;
  cell.querySelector('input').focus();
  setTimeout(() => {
    const handler = (e) => { if (!cell.contains(e.target)) { document.removeEventListener('mousedown', handler); openOrderDetail(orderId); } };
    document.addEventListener('mousedown', handler);
  }, 50);
}

function swapSearchInput(oiId, orderId, q) {
  clearTimeout(_swapTimer);
  const dd = document.getElementById('swap_dd_' + oiId);
  if (!q.trim()) { if (dd) dd.style.display = 'none'; return; }
  _swapTimer = setTimeout(async () => {
    const items = await api(`/api/items?q=${encodeURIComponent(q.trim())}`);
    if (!items || !items.length) { dd.style.display = 'none'; return; }
    dd.style.display = '';
    dd.innerHTML = items.slice(0, 8).map(it => `
      <div class="ac-item" style="padding:5px 10px" onmousedown="doItemSwap(${oiId},${orderId},'${it.item_id}')">
        <img src="/api/items/${it.item_id}/image" onerror="this.style.opacity=.2" style="width:24px;height:24px;object-fit:contain;flex-shrink:0;border-radius:3px">
        <div style="flex:1"><div style="font-size:12px;font-weight:500">${it.name_zh||it.item_id}</div>
          <div style="font-size:10px;color:var(--text3)">${it.name_en||it.item_id}</div></div>
      </div>`).join('');
  }, 200);
}

async function doItemSwap(oiId, orderId, newItemId) {
  const res = await api(`/api/order-items/${oiId}/item`, { method: 'PUT', body: JSON.stringify({ item_id: newItemId }) });
  if (res.error) return toast(res.error, 'error');
  toast('物品已替换', 'success');
  openOrderDetail(orderId); loadOrders();
}

async function rematchItem(oiId, orderId) {
  const res = await api(`/api/order-items/${oiId}/rematch`, { method: 'POST' });
  if (res.error) return toast(res.error, 'error');
  if (res.matched) {
    const swapRes = await api(`/api/order-items/${oiId}/item`, { method: 'PUT', body: JSON.stringify({ item_id: res.matched.item_id }) });
    if (!swapRes.error) { toast(`已匹配到: ${res.matched.name_zh || res.matched.item_id}`, 'success'); openOrderDetail(orderId); loadOrders(); return; }
  }
  const candidates = [res.matched, ...(res.candidates || [])].filter(Boolean);
  if (!candidates.length) { toast('未找到匹配结果，请手动搜索替换', 'error'); return; }
  const cell = document.getElementById('oicell_' + oiId);
  if (!cell) return;
  cell.innerHTML = `<div style="font-size:11px;color:var(--text3);margin-bottom:4px">选择匹配结果：</div>
    <div style="max-height:200px;overflow-y:auto;border:1px solid var(--border);border-radius:6px">
      ${candidates.map(c => `<div class="ac-item" style="padding:5px 8px;cursor:pointer" onclick="doItemSwap(${oiId},'${orderId}','${c.item_id}')">
          ${c.is_bundle ? '<span style="font-size:16px;flex-shrink:0">📦</span>' : `<img src="/api/items/${c.item_id}/image" onerror="this.style.opacity=.2" style="width:24px;height:24px;object-fit:contain;border-radius:3px">`}
          <div style="flex:1"><div style="font-size:12px;font-weight:500">${c.name_zh||c.item_id}</div>
            <div style="font-size:10px;color:var(--text3)">${c.name_en || c.item_id}</div></div>
          <span style="font-size:10px;color:var(--text3)">${c.score||''}分</span>
        </div>`).join('')}
    </div>
    <button class="btn small" onclick="openOrderDetail('${orderId}')" style="margin-top:4px;font-size:10px">取消</button>`;
}

async function saveOrderCustomer(id) {
  const name = document.getElementById('detailCustomer').value.trim();
  await api(`/api/orders/${id}`, { method:'PUT', body: JSON.stringify({customer_name: name}) });
  toast('已保存', 'success'); loadOrders();
}

let _orderActionLock = false;

async function completeOrder(id, fromDetail=false) {
  if (_orderActionLock) return; _orderActionLock = true;
  try {
    // 从存货分布里算出参与的账号：选中的且未被行级排除的、有订单物品库存的账号
    const order = state.orders.all.find(o => o.id === id);
    const orderItemIds = new Set((order?.items || []).map(it => it.item_id));
    const involvedAccIds = new Set();
    for (const item of _instockData) {
      // 检查此物品是否属于本订单（直接匹配或套餐展开后的子物品）
      if (!orderItemIds.has(item.item_id)) continue;
      const excludes = _itemAccountExcludes[item.item_id];
      for (const a of (item.accounts || [])) {
        if (_selectedAccounts.has(a.account_id) && !(excludes && excludes.has(a.account_id))) {
          involvedAccIds.add(a.account_id);
        }
      }
    }
    // 也检查 _shortageData 里展开的套餐子物品
    for (const item of _shortageData) {
      const bids = item.bundle_ids || [];
      if (!bids.some(bid => orderItemIds.has(bid)) && !orderItemIds.has(item.item_id)) continue;
      const excludes = _itemAccountExcludes[item.item_id];
      for (const a of (item.account_stocks || [])) {
        if (_selectedAccounts.has(a.account_id) && !(excludes && excludes.has(a.account_id))) {
          involvedAccIds.add(a.account_id);
        }
      }
    }

    const res = await api(`/api/orders/${id}/complete`, {
      method: 'POST',
      body: JSON.stringify({ sync_account_ids: [...involvedAccIds] })
    });
    if (res.error) return toast('完成失败: ' + res.error, 'error');
    const syncCount = involvedAccIds.size;
    toast(syncCount ? `订单已完成，${syncCount} 个账号同步中…` : '订单已完成', 'success');
    if (fromDetail) closeModal('orderDetailModal');
    await loadOrders();
    await loadShortage();
    if (document.getElementById('instockCard')?.style.display !== 'none') loadInstock();

    // 轮询等待同步完成
    if (syncCount) {
      const syncIds = [...involvedAccIds];
      const pollSync = setInterval(async () => {
        const accounts = await api('/api/accounts');
        const syncing = accounts.filter(a => syncIds.includes(a.id) && a.sync_status === 'syncing');
        if (!syncing.length) {
          clearInterval(pollSync);
          const failed = accounts.filter(a => syncIds.includes(a.id) && a.sync_status === 'error');
          if (failed.length) {
            toast(`同步完成，${failed.length} 个账号失败`, 'error');
          } else {
            toast('所有账号同步完成', 'success');
          }
          // 刷新库存相关数据
          await loadShortage();
          if (document.getElementById('instockCard')?.style.display !== 'none') loadInstock();
        }
      }, 2000);
      // 最多轮询 2 分钟
      setTimeout(() => clearInterval(pollSync), 120000);
    }
  } finally { _orderActionLock = false; }
}

async function cancelOrder(id, fromDetail=false) {
  if (!confirm('确认取消此订单？')) return;
  if (_orderActionLock) return; _orderActionLock = true;
  try {
    await api(`/api/orders/${id}/cancel`, { method:'POST' });
    toast('订单已取消');
    if (fromDetail) closeModal('orderDetailModal');
    await loadOrders();
    await loadShortage();
    if (document.getElementById('instockCard')?.style.display !== 'none') loadInstock();
  } finally { _orderActionLock = false; }
}

async function deleteOrder(id) {
  if (!confirm('确认删除此订单？删除后将移入归档。')) return;
  if (_orderActionLock) return; _orderActionLock = true;
  try {
    await api(`/api/orders/${id}`, { method:'DELETE' });
    toast('已移入归档（7天后自动清除）');
    await loadOrders();
    await loadShortage();
    if (document.getElementById('instockCard')?.style.display !== 'none') loadInstock();
  } finally { _orderActionLock = false; }
}