'use strict';

// ══════════ 补货清单 + 存货分布 ══════════
const _shortageGathered = new Set();
let   _shortageShowAll  = false;
const _orderIdToIdx     = {};
let   _shortageData     = [];
let   _instockData      = [];
let   _bundleItemsMap   = {};
let   _stockAccounts    = [];
let   _selectedAccounts = new Set();
let   _shortageMultiSelect = localStorage.getItem('shortage_multi_select') === '1';
let   _itemAccountExcludes = {}; // { item_id: Set([account_id, ...]) } 行级排除

function switchListTab(tab) {
  document.getElementById('tabShortage').classList.toggle('active', tab === 'shortage');
  document.getElementById('tabInstock').classList.toggle('active', tab === 'instock');
  document.getElementById('shortageCard').style.display = tab === 'shortage' ? '' : 'none';
  document.getElementById('instockCard').style.display  = tab === 'instock'  ? '' : 'none';
  document.getElementById('shortageToggle').style.display = tab === 'shortage' ? '' : 'none';
  if (tab === 'instock') loadInstock();
}

// ── 账号筛选栏 ──

function _buildAccountBar() {
  const bar = document.getElementById('stockAccountBar');
  if (!bar) return;
  if (!_stockAccounts.length) { bar.style.display = 'none'; return; }
  bar.style.display = 'flex';

  const allActive = _selectedAccounts.size === _stockAccounts.length;
  let html = '<span style="font-size:11px;color:var(--text3);margin-right:4px;white-space:nowrap">选择账号：</span>';
  html += `<button class="tag-btn${allActive ? ' active' : ''}" onclick="toggleStockAccount('all')" style="font-size:11px">全部</button>`;
  for (const a of _stockAccounts) {
    const active = _selectedAccounts.has(a.account_id);
    html += `<button class="tag-btn${active ? ' active' : ''}" onclick="toggleStockAccount(${a.account_id})" style="font-size:11px">${a.account_name}</button>`;
  }
  bar.innerHTML = html;
}

function toggleStockAccount(id) {
  if (id === 'all') {
    // 全选不受多选开关影响
    if (_selectedAccounts.size === _stockAccounts.length) {
      _selectedAccounts.clear();
    } else {
      _stockAccounts.forEach(a => _selectedAccounts.add(a.account_id));
    }
  } else {
    if (_selectedAccounts.has(id)) _selectedAccounts.delete(id);
    else _selectedAccounts.add(id);
  }
  // 全局变了，清除行级微调
  _itemAccountExcludes = {};
  _buildAccountBar();
  renderShortage();
  renderOrdersFromCache();
  if (document.getElementById('instockCard')?.style.display !== 'none') {
    renderInstock();
  }
}


/** 行内点击账号标签：切换单个物品的单个账号 */
function toggleItemAccount(itemId, accountId) {
  if (!_itemAccountExcludes[itemId]) _itemAccountExcludes[itemId] = new Set();
  const ex = _itemAccountExcludes[itemId];
  if (ex.has(accountId)) ex.delete(accountId);
  else ex.add(accountId);
  if (!ex.size) delete _itemAccountExcludes[itemId];
  renderInstock();
  renderShortage();
  renderOrdersFromCache();
}

// ── 根据选中账号计算物品库存 ──

function _calcStockForItem(item) {
  if (!_selectedAccounts.size) return 0;
  const excludes = _itemAccountExcludes[item.item_id];
  return (item.account_stocks || [])
    .filter(a => _selectedAccounts.has(a.account_id) && !(excludes && excludes.has(a.account_id)))
    .reduce((s, a) => s + a.quantity, 0);
}

// ── 补货清单 ──

function toggleShortageView(btn) {
  _shortageShowAll = !_shortageShowAll;
  btn.textContent  = _shortageShowAll ? '显示全部' : '只看缺货';
  btn.classList.toggle('active', !_shortageShowAll);
  renderShortage();
}

function markShortageGathered(item_id) {
  _shortageGathered.add(item_id);
  for (const [bundleId, itemIds] of Object.entries(_bundleItemsMap)) {
    if (itemIds.has(item_id)) {
      if ([...itemIds].every(id => _shortageGathered.has(id))) {
        _shortageGathered.add(bundleId);
      }
    }
  }
  renderShortage();
  renderInstock();
  renderOrdersFromCache();
}

async function loadShortage() {
  const raw = await api('/api/orders/shortage');
  _shortageData = raw || [];

  // 构建套餐→子物品映射
  _bundleItemsMap = {};
  for (const item of _shortageData) {
    for (const bid of (item.bundle_ids || [])) {
      if (!_bundleItemsMap[bid]) _bundleItemsMap[bid] = new Set();
      _bundleItemsMap[bid].add(item.item_id);
    }
  }

  // 提取有库存的账号
  const accMap = {};
  for (const item of _shortageData) {
    for (const a of (item.account_stocks || [])) {
      if (!accMap[a.account_id]) {
        accMap[a.account_id] = { account_id: a.account_id, account_name: a.account_name };
      }
    }
  }
  _stockAccounts = Object.values(accMap).sort((a, b) => a.account_name.localeCompare(b.account_name));

  // 默认全选
  if (!_selectedAccounts.size) {
    _stockAccounts.forEach(a => _selectedAccounts.add(a.account_id));
  }

  _buildAccountBar();
  renderShortage();
}

function _filterBySelectedOrders(items) {
  if (typeof _selectedOrders === 'undefined') return items;
  if (!_selectedOrders.size) return [];
  return items.filter(item =>
    (item.orders || []).some(o => _selectedOrders.has(o.order_id))
  ).map(item => {
    // 按选中的订单重新计算 total_needed
    const selectedOrders = (item.orders || []).filter(o => _selectedOrders.has(o.order_id));
    const needed = selectedOrders.reduce((s, o) => s + (o.quantity || 0), 0);
    return { ...item, total_needed: needed, orders: selectedOrders };
  });
}

function renderShortage() {
  const items = _filterBySelectedOrders(_shortageData).map(item => {
    const stock = _calcStockForItem(item);
    const shortage = Math.max(0, item.total_needed - stock);
    return { ...item, current_stock: stock, shortage };
  });

  const relevant = items.filter(item => item.shortage > 0 || item.current_stock < item.total_needed);
  const gathered = relevant.filter(i =>  _shortageGathered.has(i.item_id));
  const pending  = relevant.filter(i => !_shortageGathered.has(i.item_id));
  const toShow   = _shortageShowAll ? [...pending, ...gathered] : pending;

  document.getElementById('shortageBody').innerHTML = toShow.length
    ? toShow.map(item => {
      const done = _shortageGathered.has(item.item_id);
      const bundles = item.bundle_groups || [];
      return `<tr style="${done ? 'opacity:.45' : ''}">
        <td><img class="item-img" src="/api/items/${item.item_id}/image" onerror="this.style.opacity=.2"
          style="${done ? 'filter:grayscale(1)' : ''}"></td>
        <td>
          <div style="font-weight:500;${done ? 'text-decoration:line-through;color:var(--text3)' : ''}">${item.name_zh||item.item_id}</div>
          ${bundles.length ? `<div style="margin-top:2px">${bundles.map(b =>
            `<span style="font-size:10px;padding:1px 5px;border-radius:3px;background:rgba(168,85,247,.15);border:1px solid rgba(168,85,247,.3);color:#a855f7">📦 ${b}</span>`
          ).join(' ')}</div>` : ''}
        </td>
        <td style="font-size:13px;color:var(--text2)">${item.name_en||''}</td>
        <td class="col-num" style="color:var(--text2)">${item.total_needed}</td>
        <td class="col-num" style="color:var(--accent2)">${item.current_stock}</td>
        <td class="col-num" style="font-weight:700;color:${done?'var(--success)':'var(--danger)'}">
          ${done ? '✓' : '-'+item.shortage}
        </td>
        <td style="font-size:12px;color:var(--text2)">
          ${item.orders.map(o => {
            const idx = _orderIdToIdx[o.order_id];
            const label = o.customer_name || ('#' + (idx !== undefined ? idx : o.order_id));
            return `<span style="margin-right:4px">${label}</span>`;
          }).join('')}
        </td>
        <td>
          ${done
            ? '<span style="display:inline-flex;align-items:center;gap:3px;padding:4px 10px;border-radius:4px;font-size:12px;font-weight:600;background:var(--success-light);color:var(--success);border:1px solid rgba(52,211,153,.3)">✓ 已集齐</span>'
            : `<button class="btn small" onclick="markShortageGathered('${item.item_id}')" style="border-color:var(--accent);color:var(--accent)">集齐</button>`
          }
        </td>
      </tr>`;
    }).join('')
    : '<tr><td colspan="8" class="empty">暂无缺货物品 ✓</td></tr>';
}

// ── 存货分布 ──

async function loadInstock() {
  const data = await api('/api/orders/instock');
  _instockData = data || [];
  renderInstock();
}

function renderInstock() {
  const items = _filterBySelectedOrders(_instockData).map(item => {
    const filteredAccounts = (item.accounts || []).filter(a => _selectedAccounts.has(a.account_id));
    const excludes = _itemAccountExcludes[item.item_id];
    const activeAccounts = filteredAccounts.filter(a => !(excludes && excludes.has(a.account_id)));
    const activeStock = activeAccounts.reduce((s, a) => s + a.quantity, 0);
    const satisfied = activeStock >= item.total_needed || _shortageGathered.has(item.item_id);
    return { ...item, _allAccounts: filteredAccounts, accounts: activeAccounts, total_stock: activeStock, satisfied };
  }).filter(item => item._allAccounts.length > 0);

  // 账号排序统一（按 _stockAccounts 的顺序）
  const accOrder = Object.fromEntries(_stockAccounts.map((a,i) => [a.account_id, i]));
  items.forEach(item => {
    item._allAccounts.sort((a,b) => (accOrder[a.account_id]??99) - (accOrder[b.account_id]??99));
  });

  // 已满足/已集齐的排到末尾
  items.sort((a,b) => (a.satisfied?1:0) - (b.satisfied?1:0));

  document.getElementById('instockBody').innerHTML = items.length
    ? items.map(item => {
      const bundles = item.bundle_groups || [];
      const excludes = _itemAccountExcludes[item.item_id];
      const done = item.satisfied;
      return `<tr style="${done ? 'opacity:.45' : ''}">
        <td><img class="item-img" src="/api/items/${item.item_id}/image" onerror="this.style.opacity=.2"
          style="${done ? 'filter:grayscale(1)' : ''}"></td>
        <td>
          <div style="font-weight:500;${done ? 'text-decoration:line-through;color:var(--text3)' : ''}">${item.name_zh||item.item_id}</div>
          ${bundles.length ? `<div style="margin-top:2px">${bundles.map(b =>
            `<span style="font-size:10px;padding:1px 5px;border-radius:3px;background:rgba(168,85,247,.15);border:1px solid rgba(168,85,247,.3);color:#a855f7">📦 ${b}</span>`
          ).join(' ')}</div>` : ''}
        </td>
        <td class="col-num" style="color:var(--text2)">${item.total_needed}</td>
        <td class="col-num" style="color:${done ? 'var(--success)' : 'var(--accent2)'};font-weight:600">${item.total_stock}${done ? ' ✓' : ''}</td>
        <td style="font-size:12px">
          ${item._allAccounts.map(a => {
            const excluded = excludes && excludes.has(a.account_id);
            const enough = !excluded && a.quantity >= item.total_needed;
            return `<span onclick="toggleItemAccount('${item.item_id}',${a.account_id})" title="${excluded ? '点击选入' : '点击排除'}"
              style="display:inline-block;margin:1px 3px;padding:2px 8px;border-radius:4px;cursor:pointer;transition:opacity .15s;
              ${excluded
                ? 'opacity:.35;background:var(--bg3);border:1px dashed var(--border);text-decoration:line-through'
                : `background:${enough ? 'rgba(34,197,94,.12)' : 'var(--bg3)'};border:1px solid ${enough ? 'rgba(34,197,94,.35)' : 'var(--border)'}`
              }">
              <span style="color:${excluded ? 'var(--text3)' : enough ? '#16a34a' : 'var(--text2)'};font-weight:${enough ? '600' : '400'}">${a.account_name}</span>
              <span style="color:${excluded ? 'var(--text3)' : enough ? '#16a34a' : 'var(--accent2)'};font-weight:600;margin-left:4px">×${a.quantity}</span>
            </span>`;
          }).join('')}
        </td>
        <td>
          ${done || _shortageGathered.has(item.item_id)
            ? '<span style="display:inline-flex;align-items:center;gap:3px;padding:4px 10px;border-radius:4px;font-size:12px;font-weight:600;background:var(--success-light);color:var(--success);border:1px solid rgba(52,211,153,.3)">✓ 已集齐</span>'
            : `<button class="btn small" onclick="markShortageGathered('${item.item_id}')" style="border-color:var(--accent);color:var(--accent)">集齐</button>`
          }
        </td>
      </tr>`;
    }).join('')
    : '<tr><td colspan="6" class="empty">选中账号无相关库存</td></tr>';
}

// ── 导出 ──

function exportShortageText() {
  const filtered = _filterBySelectedOrders(_shortageData);
  const items = filtered.map(item => {
    const stock = _calcStockForItem(item);
    const shortage = Math.max(0, item.total_needed - stock);
    return { ...item, shortage };
  });
  const pending = items.filter(i => !_shortageGathered.has(i.item_id) && i.shortage > 0);
  if (!pending.length) { toast('当前没有缺货物品', 'success'); return; }

  // 按订单分组
  const orderMap = {};
  for (const item of pending) {
    for (const o of (item.orders || [])) {
      if (typeof _selectedOrders !== 'undefined' && _selectedOrders.size && !_selectedOrders.has(o.order_id)) continue;
      const key = o.order_id;
      if (!orderMap[key]) orderMap[key] = { order_id: o.order_id, customer: o.customer_name || `#${_orderIdToIdx[o.order_id] || o.order_id}`, items: [] };
      if (!orderMap[key].items.find(x => x.item_id === item.item_id)) {
        orderMap[key].items.push({ name: item.name_zh || item.item_id, shortage: item.shortage });
      }
    }
  }

  let text = '';
  const orders = Object.values(orderMap);
  for (const o of orders) {
    text += `【${o.customer}】\n`;
    for (const it of o.items) text += `  ${it.name}  ×${it.shortage}\n`;
    text += '\n';
  }

  document.getElementById('shortageModalTitle').textContent = '补货清单';
  const lineCount = Math.min(pending.length + 1, 20);
  document.getElementById('shortageModalBody').innerHTML = `
    <div style="margin-bottom:10px">
      <textarea id="shortageText" readonly style="width:100%;height:${lineCount * 24 + 20}px;font-size:13px;line-height:1.8;
        background:var(--bg2);color:var(--text1);border:1px solid var(--border);border-radius:6px;
        padding:10px;font-family:inherit;resize:vertical">${text.trim()}</textarea>
    </div>
    <div style="display:flex;gap:8px;justify-content:flex-end">
      <button class="btn" onclick="navigator.clipboard.writeText(document.getElementById('shortageText').value).then(()=>toast('已复制','success'))">📋 复制</button>
      <button class="btn" onclick="closeModal('shortageModal')">关闭</button>
    </div>`;
  document.getElementById('shortageModal').style.display = 'flex';
}