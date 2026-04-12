'use strict';

// ══════════ 新建订单（粘贴文本 → 解析确认）══════════
let _parsedOrders = [];  // [{customer, items: [{raw_name, quantity, matched, candidates, suggest_bundle}]}]

function openNewOrder() {
  _parsedOrders = [];
  document.getElementById('orderRawText').value = '';
  document.getElementById('parsedPreview').innerHTML = '';
  document.getElementById('parseStep').style.display = '';
  document.getElementById('confirmStep').style.display = 'none';
  openModal('orderModal');
}

/**
 * 把解析出的单价 (line.unit_price) 写入 state._itemPrices 作为售价；
 * 同时检查所有物品：如果保存的成本价 > 现在的售价，把成本置 0
 * （用户指出的：之前测试时胡乱设的脏数据要清掉）
 */
function _applyParsedPriceOverrides() {
  if (!state._itemPrices) state._itemPrices = {};

  // 第一步：用解析单价覆盖售价
  _parsedOrders.forEach(o => o.items.forEach(l => {
    if (l.unit_price == null || !l.matched) return;
    const pid = l.matched.item_id;
    const cur = state._itemPrices[pid] || { cost: 0, sell: 0 };
    state._itemPrices[pid] = { cost: cur.cost || 0, sell: l.unit_price };
  }));

  // 第二步：扫描本订单涉及的所有物品，cost > sell 则清空成本
  _parsedOrders.forEach(o => o.items.forEach(l => {
    if (!l.matched) return;
    const pid = l.matched.item_id;
    const pr = state._itemPrices[pid];
    if (!pr) return;
    if ((pr.cost || 0) > 0 && (pr.sell || 0) > 0 && pr.cost > pr.sell) {
      state._itemPrices[pid] = { cost: 0, sell: pr.sell };
    }
  }));
}

async function parseOrderText() {
  const text = document.getElementById('orderRawText').value.trim();
  if (!text) return toast('请先粘贴订单文本', 'error');
  const result = await api('/api/orders/parse', { method:'POST', body: JSON.stringify({text}) });
  if (result.error) return toast(result.error, 'error');

  // 新格式: {orders: [{customer, items}, ...]}
  _parsedOrders = Array.isArray(result.orders) ? result.orders : [];

  // 兼容旧格式 {items, customer}
  if (!_parsedOrders.length && Array.isArray(result.items)) {
    _parsedOrders = [{ customer: result.customer || '', items: result.items }];
  }

  const totalItems = _parsedOrders.reduce((s, o) => s + o.items.length, 0);
  if (!totalItems) return toast('未能解析出任何物品', 'error');

  // 加载物品已有价格
  state._itemPrices = await api('/api/item-prices') || {};

  // 应用规则：解析到的单价覆盖售价；成本 > 售价时清空成本
  _applyParsedPriceOverrides();

  renderParsedPreview();
  document.getElementById('parseStep').style.display = 'none';
  document.getElementById('confirmStep').style.display = '';
}

function renderParsedPreview() {
  const el = document.getElementById('parsedPreview');
  let html = '';

  // 统计未识别套餐数量，显示批量创建栏
  const suggestCount = _parsedOrders.reduce((s, o) => s + o.items.filter(l => l.suggest_bundle).length, 0);
  if (suggestCount > 0) {
    const names = _parsedOrders.flatMap(o => o.items.filter(l => l.suggest_bundle).map(l => l.suggest_bundle.bundle_alias));
    html += `<div style="background:rgba(251,191,36,.08);border:1px solid rgba(251,191,36,.25);border-radius:6px;padding:8px 12px;margin-bottom:8px;display:flex;align-items:center;justify-content:space-between">
      <div>
        <div style="font-size:13px;color:var(--warning);font-weight:600">发现 ${suggestCount} 个未识别的改装武器套餐</div>
        <div style="font-size:11px;color:var(--text3);margin-top:2px">${names.join('、')}</div>
      </div>
      <button class="btn small" onclick="createAllSuggestedBundles()"
        style="border-color:var(--warning);color:var(--warning);white-space:nowrap;flex-shrink:0">
        📦 批量创建 ${suggestCount} 个套餐
      </button>
    </div>`;
  }

  // 列标题
  html += `<div style="display:flex;align-items:center;gap:0;border-bottom:1px solid var(--border);padding:4px 0;font-size:11px;color:var(--text3);font-weight:600">
    <div style="flex:0 0 140px;padding:0 8px">订单名称</div>
    <div style="flex:0 0 36px;text-align:center">数量</div>
    <div style="flex:0 0 20px"></div>
    <div style="flex:1 1 0;min-width:0">匹配结果</div>
    <div style="flex:0 0 180px;display:flex;gap:6px;padding:0 4px">
      <div style="flex:1;text-align:right">成本</div>
      <div style="flex:1;text-align:right">售价</div>
      <div style="flex:0 0 28px"></div>
    </div>
  </div>`;

  _parsedOrders.forEach((order, oi) => {
    // 订单组标题
    const customerLabel = order.customer || '匿名客户';
    const itemCount = order.items.length;
    html += `<div style="background:var(--bg2);padding:8px 12px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:10">
      <div style="display:flex;align-items:center;gap:8px">
        <span style="font-size:13px;font-weight:600;color:var(--accent)">${order.customer ? '👤 ' + order.customer : '📋 匿名订单'}</span>
        <span style="font-size:11px;color:var(--text3)">${itemCount} 个物品</span>
      </div>
      <button class="btn small danger" onclick="_parsedOrders.splice(${oi},1);renderParsedPreview()" title="删除整个订单" style="font-size:10px;padding:2px 8px">删除订单</button>
    </div>`;

    // 该订单下的所有物品
    order.items.forEach((line, idx) => {
      const m = line.matched;
      const isUnique = m && (!line.candidates || line.candidates.length === 0);
      const needsManual = line._needs_manual;
      const borderColor = (!m || needsManual) ? 'var(--danger)' : isUnique ? 'rgba(52,211,153,.4)' : 'rgba(91,196,232,.4)';
      const uid = `${oi}_${idx}`;

      html += `<div class="parsed-row" id="prow_${uid}"
        style="display:flex;align-items:stretch;gap:0;border-bottom:1px solid var(--border);min-height:40px">

        <div style="flex:0 0 140px;display:flex;align-items:center;padding:3px 8px;border-right:1px solid var(--border)">
          <div>
            <div style="font-size:11px;font-weight:500;color:var(--accent);word-break:break-all;line-height:1.2">${line.raw_name}</div>
            ${line._is_coin ? `<div style="font-size:10px;color:#f59e0b;margin-top:2px">🪙 ${(line._coin_amount||0).toLocaleString()} 金币</div>` : ''}
            ${line._ai_parsed ? `<div style="font-size:9px;color:#a78bfa;margin-top:2px" title="此行由 AI 兜底解析（正则未识别）— 请核对数量">🤖 AI解析</div>` : ''}
            ${line._unparsed && !line._ai_parsed ? `<div style="font-size:9px;color:var(--danger);margin-top:2px" title="正则未识别且 AI 也没接管，按原文走匹配">⚠ 未识别</div>` : ''}
          </div>
        </div>

        <div style="flex:0 0 44px;display:flex;align-items:center;justify-content:center;padding:2px;border-right:1px solid var(--border)">
          <div style="text-align:center">
            <span style="font-size:12px;font-weight:600;color:var(--accent)">${line.quantity}</span>
            ${line._is_coin ? `<div style="font-size:9px;color:var(--text3)">伙伴鸭</div>` : ''}
            ${line.unit_price != null ? `<div style="font-size:9px;color:#f59e0b" title="从文本解析的单价">¥${line.unit_price}/个</div>` : ''}
          </div>
        </div>

        <div style="flex:0 0 20px;display:flex;align-items:center;justify-content:center;color:var(--text3);font-size:10px">→</div>

        <div style="flex:1 1 0;min-width:0;position:relative;display:flex;align-items:stretch;overflow:hidden">
          <div onclick="toggleCandidates('${uid}')"
            style="cursor:pointer;flex:1;background:var(--bg3);border:1.5px solid ${borderColor};
                   border-radius:5px;margin:2px 0;display:flex;align-items:stretch;overflow:hidden">
            ${m ? `
              ${m.is_bundle
                ? `<span style="font-size:16px;display:flex;align-items:center;padding:0 6px;flex-shrink:0">📦</span>`
                : `<img src="/api/items/${m.item_id}/image" onerror="this.style.opacity=.2"
                    style="width:30px;height:30px;object-fit:contain;flex-shrink:0;background:var(--bg2);padding:1px;align-self:center">`
              }
              <div style="flex:1;min-width:0;display:flex;align-items:center;padding:0 6px;overflow:hidden">
                <div style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
                  ${(() => {
                    const mhl = !m.is_bundle ? highlightMatch(line.raw_name, m.name_en) : {matched:'',ratio:1};
                    const mIcon = m._ai_matched ? '🤖' : mhl.ratio >= 0.8 ? '✅' : mhl.ratio >= 0.5 ? '⚠️' : mhl.ratio > 0 ? '❓' : '';
                    let coinInfo = '';
                    if (line._is_coin && line._actual_value) {
                      coinInfo = ` <span style="font-size:10px;padding:1px 6px;border-radius:3px;background:rgba(245,158,11,.12);color:#f59e0b;border:1px solid rgba(245,158,11,.2)">实交 ${line._actual_value.toLocaleString()} 金币</span>`;
                    }
                    const manualBadge = needsManual ? `<span style="font-size:10px;color:var(--danger);margin-left:4px" title="AI也无法确认，请手动核对">⚠需核对</span>` : '';
                    return `<span style="font-size:12px;font-weight:600;color:var(--accent2)">${m.name_zh || m.item_id}</span>
                      ${m.is_bundle ? ' <span style="font-size:10px;color:var(--text3)">套餐</span>' : ''}
                      <span style="font-size:11px"> ${m.is_bundle ? '' : mhl.matched}</span>
                      ${mIcon ? `<span style="font-size:10px">${mIcon}</span>` : ''}${coinInfo}${manualBadge}`;
                  })()}
                </div>
              </div>
              <div style="display:flex;align-items:center;padding:0 4px;flex-shrink:0">
                ${line.candidates && line.candidates.length > 0
                  ? `<span style="font-size:10px;color:var(--accent2)">${line.candidates.length} 候选 ▾</span>`
                  : `<span style="font-size:10px;color:var(--success)">✓</span>`
                }
              </div>
            ` : `<div style="display:flex;align-items:center;padding:0 10px"><span style="color:var(--danger);font-size:12px">${needsManual ? '🤖 AI未识别，请手动处理' : '⚠ 未匹配'}</span></div>`}
          </div>

          <div id="cands_${uid}" style="display:none;position:fixed;
            background:var(--bg2);border:1px solid var(--border);border-radius:6px;z-index:99999;
            max-height:360px;overflow:hidden;box-shadow:0 8px 24px rgba(0,0,0,.7)">
            ${(line.candidates && line.candidates.length > 0) ? `
            <div style="max-height:220px;overflow-y:auto">
            ${line.candidates.map((c, ci) => {
              const chl = !c.is_bundle ? highlightMatch(line.raw_name, c.name_en) : {matched:'',ratio:0};
              const cIcon = chl.ratio >= 0.8 ? '✅' : chl.ratio >= 0.5 ? '⚠️' : chl.ratio > 0 ? '❓' : '';
              return `
              <div class="ac-item" style="padding:5px 10px" onmousedown="selectCandidate(${oi},${idx},${ci})">
                ${c.is_bundle
                  ? '<span style="font-size:16px;flex-shrink:0">📦</span>'
                  : `<img src="/api/items/${c.item_id}/image" onerror="this.style.opacity=.2" style="width:28px;height:28px;object-fit:contain;flex-shrink:0;border-radius:3px">`
                }
                <div style="flex:1;min-width:0">
                  <div style="display:flex;align-items:baseline;gap:6px">
                    <span style="font-size:12px;font-weight:600">${c.name_zh||c.item_id}</span>
                    <span style="font-size:12px">${c.is_bundle ? '套餐' : chl.matched}</span>
                    ${cIcon ? `<span style="font-size:10px">${cIcon}</span>` : ''}
                  </div>
                </div>
                <span style="font-size:10px;color:var(--text3);flex-shrink:0;margin-left:4px">${c.score ? c.score+'分' : ''}</span>
              </div>`;
            }).join('')}
            </div>` : `<div style="padding:6px 10px;font-size:11px;color:var(--text3);border-bottom:1px solid var(--border)">没有自动候选，请手动搜索 ↓</div>`}
            <div style="border-top:1px solid var(--border);padding:6px 8px;background:var(--bg3)">
              <input type="text" placeholder="🔍 手动搜索物品名..." style="width:100%;font-size:12px;padding:5px 8px;background:var(--bg2);border:1px solid var(--border);border-radius:4px;color:var(--text)"
                onclick="event.stopPropagation()"
                oninput="candManualSearch(this,'${uid}',${oi},${idx})"
                onkeydown="if(event.key==='Enter'){event.preventDefault();const c=document.getElementById('candsearch_${uid}'),f=c&&c.querySelector('.ac-item');if(f)f.dispatchEvent(new MouseEvent('mousedown',{bubbles:true}))}">
              <div id="candsearch_${uid}" style="max-height:160px;overflow-y:auto;margin-top:4px"></div>
            </div>
          </div>

          ${line.suggest_bundle ? `
          <span style="align-self:center;margin-left:4px;flex-shrink:0;font-size:10px;color:var(--warning)" title="需要创建套餐: ${line.suggest_bundle.bundle_alias}">📦</span>` : ''}
        </div>

        ${(() => {
          const pid = m ? m.item_id : '';
          const pr = pid && state._itemPrices ? (state._itemPrices[pid] || {}) : {};
          const cost = pr.cost || 0;
          const sell = pr.sell || 0;
          return `
        <div style="flex:0 0 190px;display:flex;align-items:center;gap:8px;padding:0 6px">
          <div style="flex:0 0 38%">
            <input type="number" class="ghost-input parsed-cost" data-uid="${uid}" value="${cost||''}" min="0" step="0.1"
              placeholder="-" onfocus="this.select()" onblur="updateParsedPrice('${uid}')"
              onkeydown="if(event.key==='Enter'){event.preventDefault();this.blur();const s=this.closest('div').nextElementSibling?.querySelector('.parsed-sell');if(s)setTimeout(()=>s.focus(),50)}">
          </div>
          <div style="flex:0 0 38%">
            <input type="number" class="ghost-input parsed-sell" data-uid="${uid}" value="${sell||''}" min="0" step="0.1"
              placeholder="-" onfocus="this.select()" onblur="updateParsedPrice('${uid}')"
              onkeydown="if(event.key==='Enter'){event.preventDefault();this.blur()}">
          </div>
          <button class="btn small danger" onclick="_parsedOrders[${oi}].items.splice(${idx},1);if(!_parsedOrders[${oi}].items.length)_parsedOrders.splice(${oi},1);renderParsedPreview()"
            style="flex:1;font-size:12px;padding:3px 0;display:flex;align-items:center;justify-content:center;line-height:1">×</button>
        </div>`;
        })()}
      </div>`;
    });
  });

  // 汇总行
  let totalCost = 0, totalSell = 0, totalQty = 0;
  _parsedOrders.forEach(o => o.items.forEach(l => {
    const pid = l.matched ? l.matched.item_id : '';
    const pr = pid && state._itemPrices ? (state._itemPrices[pid] || {}) : {};
    totalCost += (pr.cost || 0) * l.quantity;
    totalSell += (pr.sell || 0) * l.quantity;
    totalQty  += l.quantity;
  }));
  html += `<div style="display:flex;align-items:center;gap:0;border-top:2px solid var(--border);padding:6px 0;font-size:13px;font-weight:600">
    <div style="flex:0 0 140px;padding:0 8px;color:var(--text3)">合计</div>
    <div style="flex:0 0 36px;text-align:center;color:var(--text1)" class="col-num">${totalQty}</div>
    <div style="flex:0 0 20px"></div>
    <div style="flex:1 1 0;min-width:0"></div>
    <div style="flex:0 0 180px;display:flex;gap:6px;padding:0 4px;font-variant-numeric:tabular-nums">
      <div id="parsedTotalCost" style="flex:1;text-align:right;color:var(--text2)">${totalCost ? fmtPrice(totalCost) : '-'}</div>
      <div id="parsedTotalSell" style="flex:1;text-align:right;color:var(--accent2)">${totalSell ? fmtPrice(totalSell) : '-'}</div>
      <div style="flex:0 0 28px"></div>
    </div>
  </div>`;

  el.innerHTML = html;
}

/** 更新解析预览中的价格，并实时更新全局价格缓存和汇总 */
function updateParsedPrice(uid) {
  const costEl = document.querySelector(`.parsed-cost[data-uid="${uid}"]`);
  const sellEl = document.querySelector(`.parsed-sell[data-uid="${uid}"]`);
  if (!costEl || !sellEl) return;

  const [oi, idx] = uid.split('_').map(Number);
  const line = _parsedOrders[oi]?.items?.[idx];
  if (!line?.matched) return;
  const pid = line.matched.item_id;

  const cost = parseFloat(costEl.value) || 0;
  const sell = parseFloat(sellEl.value) || 0;

  if (!state._itemPrices) state._itemPrices = {};
  state._itemPrices[pid] = { cost, sell };

  // 重新计算汇总
  let tc = 0, ts = 0;
  _parsedOrders.forEach(o => o.items.forEach(l => {
    const p = l.matched ? (state._itemPrices[l.matched.item_id] || {}) : {};
    tc += (p.cost || 0) * l.quantity;
    ts += (p.sell || 0) * l.quantity;
  }));
  const tcEl = document.getElementById('parsedTotalCost');
  const tsEl = document.getElementById('parsedTotalSell');
  if (tcEl) tcEl.textContent = tc ? fmtPrice(tc) : '-';
  if (tsEl) tsEl.textContent = ts ? fmtPrice(ts) : '-';
}

function toggleCandidates(uid) {
  const dd = document.getElementById('cands_' + uid);
  if (!dd) return;
  document.querySelectorAll('[id^="cands_"]').forEach(el => {
    if (el.id !== 'cands_' + uid) el.style.display = 'none';
  });
  if (dd.style.display !== 'none') { dd.style.display = 'none'; return; }

  const trigger = event.currentTarget;
  const rect = trigger.getBoundingClientRect();
  dd.style.position = 'fixed';
  dd.style.left  = rect.left + 'px';
  dd.style.width = Math.max(rect.width, 400) + 'px';
  dd.style.display = 'block';

  requestAnimationFrame(() => {
    const ddRect = dd.getBoundingClientRect();
    if (rect.bottom + ddRect.height > window.innerHeight - 10) {
      dd.style.top  = Math.max(10, rect.top - ddRect.height - 4) + 'px';
    } else {
      dd.style.top  = (rect.bottom + 4) + 'px';
    }
  });

  const closeHandler = () => { dd.style.display = 'none'; cleanup(); };
  const clickHandler = (e) => { if (!dd.contains(e.target) && e.target !== trigger) { closeHandler(); } };
  const cleanup = () => {
    document.removeEventListener('mousedown', clickHandler);
    (document.querySelector('#parsedPreview')?.parentElement || document).removeEventListener('scroll', closeHandler, true);
    window.removeEventListener('scroll', closeHandler, true);
  };
  setTimeout(() => {
    document.addEventListener('mousedown', clickHandler);
    (document.querySelector('#parsedPreview')?.parentElement || document).addEventListener('scroll', closeHandler, true);
    window.addEventListener('scroll', closeHandler, true);
  }, 50);
}

function selectCandidate(oi, idx, ci) {
  const line = _parsedOrders[oi].items[idx];
  line.matched = line.candidates[ci];
  const uid = `${oi}_${idx}`;
  const dd = document.getElementById('cands_' + uid);
  if (dd) dd.style.display = 'none';
  renderParsedPreview();
}

/** 候选框底部的手动搜索 */
let _candSearchTimer = null;
function candManualSearch(input, uid, oi, idx) {
  clearTimeout(_candSearchTimer);
  const q = input.value.trim();
  const container = document.getElementById('candsearch_' + uid);
  if (!q) { container.innerHTML = ''; return; }
  _candSearchTimer = setTimeout(async () => {
    const items = await api(`/api/items?q=${encodeURIComponent(q)}`);
    if (!items || !items.length) { container.innerHTML = '<div style="padding:4px 8px;font-size:11px;color:var(--text3)">无结果</div>'; return; }
    container.innerHTML = items.slice(0, 6).map(it => `
      <div class="ac-item" style="padding:4px 8px" onmousedown="selectCandManual(${oi},${idx},'${it.item_id}','${(it.name_zh||'').replace(/'/g,"\\'")}','${(it.name_en||'').replace(/'/g,"\\'")}')">
        <img src="/api/items/${it.item_id}/image" onerror="this.style.opacity=.2" style="width:24px;height:24px;object-fit:contain;flex-shrink:0;border-radius:3px">
        <div style="flex:1">
          <span style="font-size:12px;font-weight:500">${it.name_zh||it.item_id}</span>
          <span style="font-size:12px;color:var(--text2);margin-left:4px">${it.name_en||''}</span>
        </div>
      </div>
    `).join('');
  }, 200);
}

async function selectCandManual(oi, idx, itemId, nameZh, nameEn) {
  const line = _parsedOrders[oi].items[idx];
  line.matched = { item_id: itemId, name_zh: nameZh, name_en: nameEn, score: 100, image_url: `/api/items/${itemId}/image` };
  // 关闭候选框
  const uid = `${oi}_${idx}`;
  const dd = document.getElementById('cands_' + uid);
  if (dd) dd.style.display = 'none';
  renderParsedPreview();

  // 立即把 raw_name → itemId 写成别名，方便用户看到即时反馈
  // （后端在 create_order 时也会做一次保底，这里是为了 UX）
  try {
    const rawAlias = (line.raw_name || '').trim();
    if (rawAlias && rawAlias !== nameZh && rawAlias.toLowerCase() !== (nameEn || '').toLowerCase()) {
      const res = await api(`/api/items/${itemId}/aliases`, {
        method: 'POST',
        body: JSON.stringify({ alias: rawAlias }),
      });
      if (res && !res.error) {
        toast(`已关联别名：${rawAlias} → ${nameZh}`, 'success');
      }
    }
  } catch (e) {
    // 静默：别名关联失败不影响订单流程
    console.warn('alias link failed', e);
  }
}

/** 收集所有未识别的套餐，批量跳转到套餐页逐个创建 */
async function createAllSuggestedBundles() {
  const suggestions = [];
  _parsedOrders.forEach(order => {
    order.items.forEach(line => {
      if (line.suggest_bundle) {
        suggestions.push({
          name:           line.suggest_bundle.bundle_name,
          alias:          line.suggest_bundle.bundle_alias,
          weapon_item_id: line.suggest_bundle.weapon_item_id,
          weapon_name_zh: line.suggest_bundle.weapon_name_zh,
        });
      }
    });
  });
  if (!suggestions.length) return toast('没有需要创建的套餐', 'error');

  await confirmOrder(true);

  state._pendingBundleQueue = suggestions;
  state._pendingBundleCreate = suggestions[0];

  closeModal('orderModal');
  showPage('bundles');
  setTimeout(() => {
    openBundleEditor();
    toast(`共 ${suggestions.length} 个套餐待创建，保存后自动弹出下一个`, 'success');
  }, 400);
}

/** 确认创建所有订单（按客户分组，每组一个订单） */
async function confirmOrder(silent) {
  const rawText = document.getElementById('orderRawText').value;
  let created = 0;
  const createdIds = [];  // 收集新建订单 ID，用于创建后自动选中

  for (const order of _parsedOrders) {
    const items = order.items
      .filter(l => l.matched)
      .map(l => {
        const pid = l.matched.item_id;
        const pr = state._itemPrices ? (state._itemPrices[pid] || {}) : {};
        // 文本里解析到的单价（如 "2女王1.2一个"）优先作为售价
        const parsedPrice = (l.unit_price != null) ? l.unit_price : null;
        return {
          item_id:    pid,
          raw_name:   l.raw_name,
          quantity:   l.quantity,
          is_bundle:  l.matched.is_bundle || false,
          bundle_id:  l.matched.bundle_id,
          cost_price: pr.cost || 0,
          sell_price: parsedPrice != null ? parsedPrice : (pr.sell || 0),
        };
      });
    if (!items.length) continue;

    const res = await api('/api/orders', {
      method: 'POST',
      body: JSON.stringify({
        items,
        customer_name: order.customer || '',
        raw_text: rawText
      })
    });
    if (!res.error) {
      created++;
      if (res.id) createdIds.push(res.id);
    }
  }

  if (created === 0 && !silent) return toast('没有可创建的订单', 'error');

  if (!silent) {
    closeModal('orderModal');
    toast(`已创建 ${created} 个订单`, 'success');
  } else if (created > 0) {
    toast(`已保存 ${created} 个订单`, 'success');
  }

  // 确保在待处理标签页，并自动选中刚创建的订单
  if (createdIds.length) {
    state.orders.activeTab = 'pending';
  }
  await loadOrders(createdIds.length ? { selectIds: createdIds } : undefined);
  await loadShortage();
}