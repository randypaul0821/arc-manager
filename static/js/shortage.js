'use strict';

// ══════════ 物品需求（合并版：补货 + 存货 + 合成） ══════════

const _shortageGathered = new Set();
const _orderIdToIdx     = {};
let   _shortageData     = [];
let   _bundleItemsMap   = {};
let   _shortageCraftCache = {};  // { item_id: { accounts: [{account_id, craftable, stock}] } }

// 拿货选择：{ item_id: Set<account_id> } — 记录每个物品从哪些账号拿货
const _shortagePickSources = {};

// ── 数据加载 ──

async function loadShortage() {
  // 确保账号颜色映射已初始化（用户可能未先访问库存页）
  if (!inv.colorIdx || !Object.keys(inv.colorIdx).length) {
    const accounts = await api('/api/accounts').catch(() => []);
    (accounts || []).filter(a => a.active).forEach((a, i) => { inv.colorIdx[a.id] = i; });
  }

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

  renderShortage();
  _loadCraftDataForShortage();
}

// 异步加载合成数据
async function _loadCraftDataForShortage() {
  const filtered = _filterBySelectedOrders(_shortageData);
  for (const item of filtered) {
    if (_shortageCraftCache[item.item_id]) continue;
    const data = await api(`/api/craft/craftable?item_id=${item.item_id}`);
    if (data && data.accounts) {
      _shortageCraftCache[item.item_id] = data;
      renderShortage(); // 每加载一个就刷新
    }
  }
}

// ── 集齐 ──

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
  renderOrdersFromCache();
}

// ── 拿货点击 ──

function togglePickSource(itemId, accountId) {
  if (!_shortagePickSources[itemId]) _shortagePickSources[itemId] = new Set();
  const s = _shortagePickSources[itemId];
  if (s.has(accountId)) s.delete(accountId);
  else s.add(accountId);

  // 即时更新标签样式
  const tag = document.getElementById(`stag_${itemId}_${accountId}`);
  if (tag) {
    const ci = (inv.colorIdx && inv.colorIdx[accountId] !== undefined) ? inv.colorIdx[accountId] : 0;
    const c = INV_PALETTE[ci % INV_PALETTE.length];
    if (s.has(accountId)) {
      tag.classList.add('picked');
      tag.style.background = c.bg;
    } else {
      tag.classList.remove('picked');
      tag.style.background = '';
    }
  }

  // 更新该行状态
  _updateRowStatus(itemId);

  // 联动高亮订单
  _highlightOrdersForItem(itemId);

  // 联动更新订单行物品标签
  renderOrdersFromCache();
}

function _updateRowStatus(itemId) {
  const statusEl = document.getElementById('sstat_' + itemId);
  if (!statusEl) return;

  const filtered = _filterBySelectedOrders(_shortageData);
  const item = filtered.find(i => i.item_id === itemId);
  if (!item) return;

  const picked = _shortagePickSources[itemId] || new Set();
  let provided = 0;
  for (const a of (item.account_stocks || [])) {
    if (!picked.has(a.account_id)) continue;
    provided += a.quantity;
    // 加上可合成
    const craft = _shortageCraftCache[itemId];
    if (craft && craft.accounts) {
      const ac = craft.accounts.find(x => x.account_id === a.account_id);
      if (ac) provided += ac.craftable || 0;
    }
  }

  const gap = Math.max(0, item.total_needed - provided);
  const done = _shortageGathered.has(itemId) || gap === 0;

  if (done) {
    statusEl.innerHTML = '<span style="color:var(--success);font-weight:600">✓ 齐</span>';
  } else if (picked.size === 0) {
    statusEl.innerHTML = `<span style="color:var(--text3)">待分配</span>`;
  } else {
    statusEl.innerHTML = `<span style="color:var(--danger);font-weight:600">缺 ${gap}</span>`;
  }
}

// ── 订单联动高亮 ──

function _highlightOrdersForItem(itemId) {
  // 清除之前的高亮
  document.querySelectorAll('tr[id^="orow_"]').forEach(r => r.classList.remove('item-highlight'));

  if (!itemId) return;
  const filtered = _filterBySelectedOrders(_shortageData);
  const item = filtered.find(i => i.item_id === itemId);
  if (!item) return;

  for (const o of (item.orders || [])) {
    const row = document.getElementById('orow_' + o.order_id);
    if (row) row.classList.add('item-highlight');
  }
}

// ── 过滤 ──

function _filterBySelectedOrders(items) {
  if (typeof _selectedOrders === 'undefined') return items;
  if (!_selectedOrders.size) return [];
  return items.filter(item =>
    (item.orders || []).some(o => _selectedOrders.has(o.order_id))
  ).map(item => {
    const selectedOrders = (item.orders || []).filter(o => _selectedOrders.has(o.order_id));
    const needed = selectedOrders.reduce((s, o) => s + (o.quantity || 0), 0);
    return { ...item, total_needed: needed, orders: selectedOrders };
  });
}

// 根据选中的拿货来源计算库存
function _calcStockForItem(item, useAllAccounts) {
  const picked = _shortagePickSources[item.item_id];
  if (picked && picked.size > 0) {
    // 用拿货选择计算
    return (item.account_stocks || [])
      .filter(a => picked.has(a.account_id))
      .reduce((s, a) => s + a.quantity, 0);
  }
  // 无选择时用全部账号
  return (item.account_stocks || []).reduce((s, a) => s + a.quantity, 0);
}

// ── 渲染 ──

function renderShortage() {
  const items = _filterBySelectedOrders(_shortageData);
  if (!items.length) {
    document.getElementById('shortageBody').innerHTML =
      '<tr><td colspan="6" class="empty">暂无物品需求</td></tr>';
    return;
  }

  // 已集齐排后面
  const sorted = [...items].sort((a, b) => {
    const aD = _shortageGathered.has(a.item_id) ? 1 : 0;
    const bD = _shortageGathered.has(b.item_id) ? 1 : 0;
    return aD - bD;
  });

  document.getElementById('shortageBody').innerHTML = sorted.map(item => {
    const done = _shortageGathered.has(item.item_id);
    const picked = _shortagePickSources[item.item_id] || new Set();

    // 计算状态
    let provided = 0;
    for (const a of (item.account_stocks || [])) {
      if (!picked.has(a.account_id)) continue;
      provided += a.quantity;
      const craft = _shortageCraftCache[item.item_id];
      if (craft && craft.accounts) {
        const ac = craft.accounts.find(x => x.account_id === a.account_id);
        if (ac) provided += ac.craftable || 0;
      }
    }
    const gap = Math.max(0, item.total_needed - provided);
    const fulfilled = done || gap === 0;

    // 状态显示
    let statusHtml;
    if (done) {
      statusHtml = '<span style="color:var(--success);font-weight:600">✓ 齐</span>';
    } else if (picked.size === 0) {
      statusHtml = '<span style="color:var(--text3)">待分配</span>';
    } else if (gap === 0) {
      statusHtml = '<span style="color:var(--success);font-weight:600">✓ 齐</span>';
    } else {
      statusHtml = `<span style="color:var(--danger);font-weight:600">缺 ${gap}</span>`;
    }

    // 各账号库存+合成标签（带颜色）
    const accStocks = item.account_stocks || [];
    const craftData = _shortageCraftCache[item.item_id];
    const accHtml = accStocks.map(a => {
      const isPicked = picked.has(a.account_id);
      let craftQty = 0;
      if (craftData && craftData.accounts) {
        const ac = craftData.accounts.find(x => x.account_id === a.account_id);
        if (ac) craftQty = ac.craftable || 0;
      }
      // 账号颜色（复用库存页调色板）
      const ci = (inv.colorIdx && inv.colorIdx[a.account_id] !== undefined) ? inv.colorIdx[a.account_id] : 0;
      const c = INV_PALETTE[ci % INV_PALETTE.length];

      return `<span class="shortage-acc-tag${isPicked ? ' picked' : ''}" id="stag_${item.item_id}_${a.account_id}"
        onclick="togglePickSource('${item.item_id}',${a.account_id})"
        style="border-color:${c.border};color:${c.text};${isPicked ? `background:${c.bg}` : ''}">
        <span style="color:${c.text};font-weight:500">${a.account_name}</span>
        <span style="font-weight:700;color:var(--text1)">×${a.quantity}</span>
        ${craftQty > 0 ? `<span style="color:var(--accent);font-weight:700">+${craftQty}</span>` : ''}
      </span>`;
    }).join('');

    // 来源订单（序号 + 客户名）
    const orderHtml = (item.orders || []).map(o => {
      const idx = _orderIdToIdx[o.order_id];
      const idxStr = idx !== undefined ? idx : o.order_id;
      const label = o.customer_name ? `#${idxStr} ${o.customer_name}` : `#${idxStr}`;
      return `<span style="font-size:12px;color:var(--text2);margin-right:6px">${label}</span>`;
    }).join('');

    return `<tr style="${fulfilled ? 'opacity:.45' : ''}"
      onmouseenter="_highlightOrdersForItem('${item.item_id}')"
      onmouseleave="_highlightOrdersForItem(null)">
      <td><img class="item-img" src="/api/items/${item.item_id}/image" onerror="this.style.opacity=.2"
        style="${fulfilled ? 'filter:grayscale(1)' : ''}"></td>
      <td>
        <div style="font-size:13px;font-weight:500;${fulfilled ? 'text-decoration:line-through;color:var(--text3)' : ''}">${item.name_zh || item.item_id}</div>
        <div style="font-size:13px;color:var(--text3);margin-top:1px">${item.name_en || ''}</div>
      </td>
      <td class="col-num" style="font-weight:600">${item.total_needed}</td>
      <td>${accHtml || '<span style="font-size:12px;color:var(--text3)">无库存</span>'}</td>
      <td class="col-num" id="sstat_${item.item_id}">${statusHtml}</td>
      <td>${orderHtml}</td>
    </tr>`;
  }).join('');
}

// ── 导出 ──

function exportShortageText() {
  const filtered = _filterBySelectedOrders(_shortageData);
  const pending = filtered.filter(i => !_shortageGathered.has(i.item_id));
  if (!pending.length) { toast('当前没有缺货物品', 'success'); return; }

  const orderMap = {};
  for (const item of pending) {
    for (const o of (item.orders || [])) {
      if (typeof _selectedOrders !== 'undefined' && _selectedOrders.size && !_selectedOrders.has(o.order_id)) continue;
      const key = o.order_id;
      const idx = _orderIdToIdx[o.order_id];
      if (!orderMap[key]) orderMap[key] = {
        customer: o.customer_name ? `${o.customer_name} #${idx || o.order_id}` : `#${idx || o.order_id}`,
        items: []
      };
      if (!orderMap[key].items.find(x => x.item_id === item.item_id)) {
        orderMap[key].items.push({ name: item.name_zh || item.item_id, needed: item.total_needed });
      }
    }
  }

  let text = '';
  for (const o of Object.values(orderMap)) {
    text += `【${o.customer}】\n`;
    for (const it of o.items) text += `  ${it.name}  ×${it.needed}\n`;
    text += '\n';
  }

  navigator.clipboard.writeText(text.trim()).then(() => toast('已复制到剪贴板', 'success'));
}
