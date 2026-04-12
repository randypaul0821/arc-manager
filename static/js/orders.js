'use strict';

// ══════════ 订单列表 + 详情 + CRUD ══════════

let _completedDays = 0; // 0=全部
let _completedFrom = '';
let _completedTo   = '';
const _selectedOrders = new Set();
let _orderMultiSelect = localStorage.getItem('order_multi_select') === '1';

function setOrderTab(status, btn) {
  state.orders.activeTab = status;
  // 更新 sidebar 子菜单 active 状态
  document.querySelectorAll('#orderSubNav .nav-sub-item[data-tab]').forEach(b => b.classList.remove('active'));
  const subItem = document.querySelector(`#orderSubNav .nav-sub-item[data-tab="${status}"]`);
  if (subItem) subItem.classList.add('active');
  const shortageEl = document.getElementById('shortageSection');
  if (shortageEl) shortageEl.style.display = status === 'pending' ? '' : 'none';
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

/**
 * @param {object} [opts]
 * @param {number[]} [opts.selectIds] — 加载完成后强制选中这些订单 ID
 */
async function loadOrders(opts) {
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
    const ids = new Set(orders.map(o => o.id));

    // 如果调用方指定了要选中的订单（如刚创建的），在列表加载后强制选中
    if (opts && opts.selectIds && opts.selectIds.length) {
      _selectedOrders.clear();
      opts.selectIds.forEach(id => { if (ids.has(id)) _selectedOrders.add(id); });
    }

    // 清理已不存在的订单选择，默认选第一个
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

  // 单行渲染
  const renderRow = (o, idx) => {
    const items   = o.items || [];
    const cost    = o.total_cost || 0;
    const revenue = o.total_revenue || 0;
    const profit  = revenue - cost;
    const isSelected = _selectedOrders.has(o.id);

    let itemsHtml = '';
    if (isPending) {
      // 用 Map 替代 find，O(1) 查找
      const shortageMap = new Map(_shortageData.map(s => [s.item_id, s]));
      // 未选中的订单用全部账号库存计算，不受账号筛选影响
      const useAllAccounts = !isSelected;
      // 汇总所有选中订单的物品需求量，用于多选时的缺货计算
      const selectedNeedMap = new Map();
      if (_selectedOrders.size > 1) {
        for (const so of orders) {
          if (!_selectedOrders.has(so.id)) continue;
          for (const si of (so.items || [])) {
            selectedNeedMap.set(si.item_id, (selectedNeedMap.get(si.item_id) || 0) + si.quantity);
          }
        }
      }
      // 缺货计算：单选用该订单自身数量，多选用选中订单汇总数量
      const calcShortage = (it) => {
        const iid = it.item_id;
        const need = _selectedOrders.size > 1 && isSelected ? (selectedNeedMap.get(iid) || it.quantity) : it.quantity;
        const sd = shortageMap.get(iid);
        if (sd) {
          const stock = _calcStockForItem(sd, useAllAccounts);
          return Math.max(0, need - stock);
        }
        if (iid.startsWith('__bundle__') && _bundleItemsMap[iid]) {
          for (const subId of _bundleItemsMap[iid]) {
            const sub = shortageMap.get(subId);
            if (sub) {
              const stock = _calcStockForItem(sub, useAllAccounts);
              if (stock < need) return 1;
            }
          }
          return 0;
        }
        return it.shortage || 0;
      };
      // 每个物品只算一次，附加分配状态
      const itemShortages = items.map(it => {
        if (!isSelected) {
          // 未选中订单：永远中性灰标签，不参与拿货逻辑
          return { ...it, _shortage: 0, _tagState: 'unassigned' };
        }
        // 选中订单：三态（未分配/已备齐/缺货）
        const gathered = _shortageGathered.has(it.item_id);
        const p = _shortagePickSources[it.item_id];
        const picked = p && p.size > 0;
        const shortage = calcShortage(it);
        let tagState = 'unassigned';
        if (gathered) tagState = 'ok';
        else if (picked) tagState = shortage > 0 ? 'short' : 'ok';
        return { ...it, _shortage: shortage, _tagState: tagState };
      });
      const shortItems = itemShortages.filter(it => it._tagState === 'short')
                                      .map(it => ({ ...it, shortage: it._shortage }));
      const okItems    = itemShortages.filter(it => it._tagState === 'ok');
      const neutralItems = itemShortages.filter(it => it._tagState === 'unassigned');

      // 计算已分配的库存量（仅从选中账号）
      const pickedStockFor = (itemId) => {
        const sd = shortageMap.get(itemId);
        if (!sd) return 0;
        const p = _shortagePickSources[itemId];
        if (!p || p.size === 0) return 0;
        return (sd.account_stocks || [])
          .filter(a => p.has(a.account_id))
          .reduce((s, a) => s + a.quantity, 0);
      };
      const makeShortTag = it => {
        const gap = it.quantity - pickedStockFor(it.item_id);
        const gapText = gap > 0 && gap < it.quantity ? ` 缺${gap}` : '';
        return `<span style="display:inline-flex;align-items:center;gap:3px;padding:2px 9px;border-radius:4px;font-size:12px;font-weight:600;margin:2px;background:rgba(240,68,68,.12);color:var(--danger);border:1px solid rgba(240,68,68,.25)">${it.name_zh||it.raw_name} <b>×${it.quantity}</b>${gapText}</span>`;
      };
      const makeOkTag   = it => `<span style="display:inline-flex;align-items:center;gap:3px;padding:2px 9px;border-radius:4px;font-size:12px;margin:2px;background:rgba(52,211,153,.08);color:var(--success);border:1px solid rgba(52,211,153,.2)">${it.name_zh||it.raw_name} ×${it.quantity}</span>`;
      const makeNeutralTag = it => `<span style="display:inline-flex;align-items:center;gap:3px;padding:2px 9px;border-radius:4px;font-size:12px;margin:2px;background:var(--bg3);color:var(--text2);border:1px solid var(--border)">${it.name_zh||it.raw_name} ×${it.quantity}</span>`;

      const THRESHOLD = 8;
      const allTags   = shortItems.map(makeShortTag).concat(neutralItems.map(makeNeutralTag)).concat(okItems.map(makeOkTag));
      const needFold  = allTags.length > THRESHOLD;
      const visibleHtml = allTags.slice(0, THRESHOLD).join('');
      const hiddenHtml  = needFold ? allTags.slice(THRESHOLD).join('') : '';

      const foldBtn  = needFold ? `<button id="obtn_${o.id}" onclick="toggleOrderItems(${o.id})" style="display:none;cursor:pointer;font-size:11px;color:var(--accent);padding:2px 7px;border:1px solid var(--accent);border-radius:4px;margin:2px;background:none;font-family:inherit">+${allTags.length - THRESHOLD} 展开</button>` : '';
      const foldArea = needFold ? `<span id="omore_${o.id}" style="display:inline">${hiddenHtml}<button onclick="toggleOrderItems(${o.id})" style="cursor:pointer;font-size:11px;color:var(--accent);padding:2px 7px;border:1px solid var(--accent);border-radius:4px;margin:2px;background:none;font-family:inherit">收起</button></span>` : '';

      itemsHtml = shortItems.length === 0 && neutralItems.length === 0
        ? `<span style="font-size:12px;color:var(--success)">✓ 所有物品已备齐（共${items.length}件）</span>`
        : visibleHtml + foldBtn + foldArea;
    } else {
      const SHOW = 4;
      itemsHtml = items.slice(0, SHOW).map(it =>
        `<span style="font-size:11px;color:var(--text3);margin:0 4px 0 0">${it.name_zh||it.raw_name} ×${it.quantity}</span>`
      ).join('') + (items.length > SHOW ? `<span style="font-size:11px;color:var(--text3)">+${items.length-SHOW}件</span>` : '');
    }

    const costColor   = '#e8925a';
    const revColor    = '#8b9cf7';
    const profitColor = profit >= 0 ? '#5ec484' : '#f06060';
    const rowBg = isPending ? '' : 'opacity:.8';
    const cc = (v,c) => `<span style="color:${c}">${v}</span>`;
    const timeStr = isCompleted ? fmtTime(o.completed_at) : fmtTime(o.created_at);

    const chk = _selectedOrders.has(o.id);
    return `<tr id="orow_${o.id}" style="${rowBg}${isPending && !chk ? ';opacity:.5' : ''}">
      <td style="text-align:center">${isPending ? `<input type="checkbox" ${chk?'checked':''} onchange="toggleOrderSelect(${o.id},this.checked)" style="cursor:pointer;width:16px;height:16px">` : ''}</td>
      <td style="color:var(--text3);font-size:12px;white-space:nowrap;cursor:pointer" onclick="this.parentElement.querySelector('input[type=checkbox]')?.click()">#${o.id} ${o.customer_name ? `<span style="color:var(--text1);font-weight:600">${o.customer_name}</span>` : ''}</td>
      <td style="cursor:pointer" onclick="this.parentElement.querySelector('input[type=checkbox]')?.click()">
        <div style="display:flex;flex-wrap:wrap;align-items:center;gap:2px">${itemsHtml}</div>
      </td>
      <td class="col-num" style="color:var(--text2)">${items.length||'—'}</td>
      <td class="col-num">${cc(fmtPrice(cost), cost ? costColor : 'var(--text3)')}</td>
      <td class="col-num">${cc(fmtPrice(revenue), revenue ? revColor : 'var(--text3)')}</td>
      <td class="col-num">${cc((profit>=0?'+':'')+fmtPrice(profit), (cost||revenue) ? profitColor : 'var(--text3)')}</td>
      <td style="color:var(--text2);font-size:12px;white-space:nowrap">${timeStr}</td>
      <td>
        <div style="display:flex;gap:4px;flex-wrap:nowrap">
          <button class="btn small" onclick="openOrderDetail(${o.id})">详情</button>
          ${isPending?`<button class="btn small success" onclick="completeOrder(${o.id})">完成</button>`:''}
          ${isPending?`<button class="btn small danger" onclick="cancelOrder(${o.id})">取消</button>`:''}
          <button class="btn small danger" onclick="deleteOrder(${o.id})">删</button>
        </div>
      </td>
    </tr>`;
  };

  if (!orders.length) {
    document.getElementById('ordersBody').innerHTML =
      `<tr><td colspan="9" class="empty">暂无${isPending?'待处理':isCompleted?'已完成':'已归档'}订单</td></tr>`;
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
      const dayCost   = dayOrders.reduce((s,o) => s + (o.total_cost||0), 0);
      const dayRev    = dayOrders.reduce((s,o) => s + (o.total_revenue||0), 0);
      const dayProfit = dayRev - dayCost;
      const dayItems  = dayOrders.reduce((s,o) => s + (o.items||[]).length, 0);

      // 日期头：colspan=3 合并前3列，总共9列
      html += `<tr style="background:var(--accent-light);border-top:1px solid var(--border)">
        <td colspan="3" style="border-bottom:1px solid rgba(134,120,255,.15);padding:8px 14px">
          <span style="font-size:14px;font-weight:700;color:var(--accent)">${date}</span>
          <span style="display:inline-block;margin-left:8px;padding:1px 7px;border-radius:4px;font-size:11px;font-weight:600;background:rgba(134,120,255,.15);color:var(--accent)">${dayOrders.length} 单</span>
        </td>
        <td class="col-num" style="border-bottom:1px solid rgba(134,120,255,.15);font-size:13px;color:var(--text1);font-weight:700">${dayItems}</td>
        <td class="col-num" style="border-bottom:1px solid rgba(134,120,255,.15);font-size:13px;color:var(--danger);font-weight:700">${fmtPrice(dayCost)}</td>
        <td class="col-num" style="border-bottom:1px solid rgba(134,120,255,.15);font-size:13px;color:var(--text1);font-weight:700">${fmtPrice(dayRev)}</td>
        <td class="col-num" style="border-bottom:1px solid rgba(134,120,255,.15);font-size:13px;color:${dayProfit>=0?'var(--success)':'var(--danger)'};font-weight:700">${(dayProfit>=0?'+':'')+fmtPrice(dayProfit)}</td>
        <td style="border-bottom:1px solid rgba(134,120,255,.15)"></td>
        <td style="border-bottom:1px solid rgba(134,120,255,.15)"></td>
      </tr>`;

      for (const o of dayOrders) {
        globalIdx++;
        html += renderRow(o, globalIdx);
      }
    }

    // 总汇总
    const sumCost   = orders.reduce((s,o) => s + (o.total_cost||0), 0);
    const sumRev    = orders.reduce((s,o) => s + (o.total_revenue||0), 0);
    const sumProfit = sumRev - sumCost;
    const sumItems  = orders.reduce((s,o) => s + (o.items||[]).length, 0);
    html += `<tr style="border-top:2px solid var(--border);background:var(--bg2)">
      <td colspan="3" style="text-align:right;padding-right:14px;font-size:12px;color:var(--text3);font-weight:600">合计 ${orders.length} 单</td>
      <td class="col-num" style="color:var(--text2)">${sumItems}</td>
      <td class="col-num" style="color:var(--danger)">${fmtPrice(sumCost)}</td>
      <td class="col-num" style="color:var(--text1)">${fmtPrice(sumRev)}</td>
      <td class="col-num" style="color:${sumProfit>=0?'var(--success)':'var(--danger)'}">${(sumProfit>=0?'+':'')+fmtPrice(sumProfit)}</td>
      <td colspan="2"></td>
    </tr>`;

    document.getElementById('ordersBody').innerHTML = html;
  } else {
    // 待处理/已归档：原来的平铺方式
    document.getElementById('ordersBody').innerHTML = orders.map((o, idx) => renderRow(o, idx + 1)).join('');
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
  renderShortage();
  _updateOrderCheckAll();
}

function toggleAllOrders(checked) {
  const orders = (state.orders.all || []).filter(o => (state.orders.activeTab || 'pending') === 'pending');
  _selectedOrders.clear();
  if (checked) orders.forEach(o => _selectedOrders.add(o.id));
  renderOrdersFromCache();
  renderShortage();
  renderShortage();
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
    renderShortage();
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
  const order = await api(`/api/orders/${id}`);
  const el = document.getElementById('orderDetailContent');
  const items = order.items || [];
  const isPending = order.status === 'pending';

  const totalCost = items.reduce((s,it) => s + (it.cost_price||0) * it.quantity, 0);
  const totalSell = items.reduce((s,it) => s + (it.sell_price||0) * it.quantity, 0);
  const totalProfit = totalSell - totalCost;

  el.innerHTML = `
    <div style="margin-bottom:16px"><h3>订单 #${order.id}</h3></div>
    <div style="display:flex;gap:12px;margin-bottom:16px;flex-wrap:wrap">
      <div style="flex:1">
        <label class="form-label">客户名</label>
        <input type="text" id="detailCustomer" value="${order.customer_name||''}" placeholder="客户名...">
      </div>
      <div style="display:flex;align-items:flex-end;gap:8px">
        <button class="btn small" onclick="saveOrderCustomer(${id})">保存</button>
      </div>
    </div>
    <div style="margin-bottom:16px">
      <div style="font-size:12px;color:var(--text2);margin-bottom:8px">订单物品</div>
      <table>
        <thead><tr>
          <th style="width:44px"></th><th>物品</th><th>英文名</th><th style="width:48px">数量</th>
          <th style="width:72px;text-align:right;padding-right:10px">成本</th>
          <th style="width:72px;text-align:right;padding-right:10px">售价</th>
          <th style="width:72px;text-align:right;padding-right:10px">利润</th>
          <th style="width:36px;text-align:center">状态</th>
        </tr></thead>
        <tbody>
          ${items.map(it => {
            const isReady = !isPending || it.ready || _shortageGathered.has(it.item_id);
            const itemProfit = ((it.sell_price||0) - (it.cost_price||0)) * it.quantity;
            const isBundle = it.is_bundle || (it.item_id||'').startsWith('__bundle__');
            const displayName = it.name_zh || (isBundle ? '📦 套餐 #'+it.item_id.replace('__bundle__','') : it.item_id);
            const isUnresolved = !it.name_zh || it.name_zh === it.item_id || it.name_zh.startsWith('__bundle__')
              || (!isBundle && it.raw_name && /modded.?weapon|改装武器|\(plan\s|方案\s/i.test(it.raw_name));
            const hl = highlightMatch(it.raw_name, it.name_en);
            const matchIcon = isBundle ? '' : (hl.ratio >= 0.8 ? '✅' : hl.ratio >= 0.5 ? '⚠️' : hl.ratio > 0 ? '❓' : '');
            return `
          <tr id="oirow_${it.id}">
            <td>${isBundle
              ? '<span style="font-size:22px;display:flex;align-items:center;justify-content:center">📦</span>'
              : `<img class="item-img" src="/api/items/${it.item_id}/image" onerror="this.style.opacity=.2">`}</td>
            <td style="font-size:13px;position:relative" id="oicell_${it.id}">
              <div style="display:flex;align-items:center;gap:4px">
                ${isPending ? `<div onclick="startItemSwap(${it.id},'${id}')" style="cursor:pointer;flex:1;min-width:0" title="点击更换物品">` : '<div style="flex:1;min-width:0">'}
                  <div style="font-weight:600;color:var(--text1)">${displayName}${isPending ? ' <span style="font-size:10px;color:var(--text3)">✎</span>' : ''}</div>
                  ${it.raw_name && it.raw_name !== it.name_zh && it.raw_name !== it.name_en ? `<div style="font-size:11px;color:var(--text3);margin-top:1px">${it.raw_name}</div>` : ''}
                </div>
                ${isPending && isUnresolved ? `<button class="btn small" onclick="event.stopPropagation();rematchItem(${it.id},'${id}')" style="flex-shrink:0;font-size:10px;padding:2px 6px;border-color:var(--accent2);color:var(--accent2)" title="重新匹配">🔄</button>` : ''}
              </div>
            </td>
            <td style="font-size:13px">${isBundle
                ? `<span style="color:var(--text2)">${it.name_en || '套餐'}</span>`
                : `<div>${hl.matched || ''}</div>${matchIcon ? `<span style="font-size:10px">${matchIcon}</span>` : ''}`}</td>
            <td style="font-size:13px;font-weight:600;color:var(--text1)">×${it.quantity}</td>
            <td style="padding:2px 4px"><input type="number" class="ghost-input oi-price" data-id="${it.id}" data-qty="${it.quantity}" data-field="cost"
              value="${it.cost_price||0}" min="0" step="0.1" onfocus="this.select()" oninput="recalcOrderTotals()" onblur="autoSaveItemPrice(this,${id})"></td>
            <td style="padding:2px 4px"><input type="number" class="ghost-input oi-price" data-id="${it.id}" data-qty="${it.quantity}" data-field="sell"
              value="${it.sell_price||0}" min="0" step="0.1" onfocus="this.select()" oninput="recalcOrderTotals()" onblur="autoSaveItemPrice(this,${id})"></td>
            <td class="num-cell oi-profit" data-id="${it.id}" style="color:${itemProfit>=0?'#5ec484':'#f06060'}">${itemProfit>=0?'+':''}${fmtPrice(itemProfit)}</td>
            <td style="text-align:center"><button class="ready-btn" onclick="toggleReady(${it.id},${isReady?0:1})" title="点击切换">${isReady ? '✅' : '❗'}</button></td>
          </tr>`;}).join('')}
        </tbody>
        <tfoot><tr style="border-top:2px solid var(--border)">
            <td colspan="4" style="text-align:right;padding-right:8px;font-size:11px;color:var(--text3)">合计</td>
            <td class="num-cell" id="detailTotalCost" style="padding-top:10px;padding-bottom:10px;color:#e8925a">${fmtPrice(totalCost)}</td>
            <td class="num-cell" id="detailTotalSell" style="padding-top:10px;padding-bottom:10px;color:#8b9cf7">${fmtPrice(totalSell)}</td>
            <td class="num-cell" id="detailTotalProfit" style="padding-top:10px;padding-bottom:10px;color:${totalProfit>=0?'#5ec484':'#f06060'}">${totalProfit>=0?'+':''}${fmtPrice(totalProfit)}</td>
            <td></td>
        </tr></tfoot>
      </table>
    </div>
    <div style="display:flex;gap:8px;justify-content:flex-end">
      ${isPending?`<button class="btn success" onclick="completeOrder(${id},true)">✓ 完成订单</button>
      <button class="btn danger" onclick="cancelOrder(${id},true)">✕ 取消订单</button>`:''}
    </div>`;
  openModal('orderDetailModal');
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
    // 传空数组，由后端兜底计算涉及的账号并触发同步
    const res = await api(`/api/orders/${id}/complete`, {
      method: 'POST',
      body: JSON.stringify({ sync_account_ids: [] })
    });
    if (res.error) return toast('完成失败: ' + res.error, 'error');
    const syncCount = res.synced_accounts || 0;
    toast(syncCount ? `订单已完成，${syncCount} 个账号同步中…` : '订单已完成', 'success');
    if (fromDetail) closeModal('orderDetailModal');
    await loadOrders();
    await loadShortage();
    renderShortage();

    // 轮询等待同步完成（后端自动触发了相关账号同步）
    if (syncCount) {
      const pollSync = setInterval(async () => {
        const accounts = await api('/api/accounts');
        const syncing = accounts.filter(a => a.sync_status === 'syncing');
        if (!syncing.length) {
          clearInterval(pollSync);
          const failed = accounts.filter(a => a.sync_status === 'error');
          if (failed.length) {
            toast(`同步完成，${failed.length} 个账号失败`, 'error');
          } else {
            toast('所有账号同步完成', 'success');
          }
          await loadShortage();
          renderShortage();
        }
      }, 2000);
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
    renderShortage();
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
    renderShortage();
  } finally { _orderActionLock = false; }
}