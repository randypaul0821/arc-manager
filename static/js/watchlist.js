// ══════════ 库存监控 ══════════

// 物品类型中文翻译
const TYPE_ZH = {
  'Ammunition':'弹药', 'Assault Rifle':'突击步枪', 'Augment':'增强装备',
  'Basic Material':'基础材料', 'Battle Rifle':'战斗步枪', 'Blueprint':'蓝图',
  'Hand Cannon':'手炮', 'Key':'钥匙', 'LMG':'轻机枪',
  'Misc':'杂项', 'Modification':'改装配件', 'Nature':'自然物',
  'Pistol':'手枪', 'Quick Use':'快速消耗', 'Recyclable':'可回收物',
  'Refined Material':'精炼材料', 'SMG':'冲锋枪', 'Shield':'护盾',
  'Shotgun':'霰弹枪', 'Sniper Rifle':'狙击步枪', 'Special':'特殊物品',
  'Topside Material':'地表材料', 'Trinket':'饰品', 'Weapon':'武器',
  'Grenade':'手雷', 'Tool':'工具', 'Consumable':'消耗品',
  'Attachment':'配件', 'Equipment':'装备', 'Resource':'资源',
};
function typeZh(t) { return TYPE_ZH[t] || t; }

function setInvTab(tab) {
  document.getElementById('invTab_stock').classList.toggle('active', tab === 'stock');
  document.getElementById('invTab_watch').classList.toggle('active', tab === 'watch');
  document.getElementById('invStockSection').style.display = tab === 'stock' ? '' : 'none';
  document.getElementById('invWatchSection').style.display = tab === 'watch' ? '' : 'none';
  document.getElementById('invStockBar').style.display = tab === 'stock' ? 'flex' : 'none';
  document.getElementById('invWatchBar').style.display  = tab === 'watch' ? 'flex' : 'none';
  if (tab === 'watch') {
    loadWatchAccounts();
    loadWatchAlerts();
  }
}

// ── 账号下拉 ──
async function loadWatchAccounts() {
  const accounts = await api('/api/accounts') || [];
  const sel = document.getElementById('watchAccountFilter');
  const cur = sel?.value || '';
  if (sel) {
    sel.innerHTML = '<option value="">全部账号</option>' +
      accounts.map(a => `<option value="${a.id}">${escHtml(a.name)}</option>`).join('');
    sel.value = cur;
  }
  const rSel = document.getElementById('watchRuleAccount');
  if (rSel) {
    rSel.innerHTML = accounts.map(a => `<option value="${a.id}">${escHtml(a.name)}</option>`).join('');
  }
}

// ── 告警列表 ──
let _watchAlerts = [];

async function loadWatchAlerts() {
  const aid = document.getElementById('watchAccountFilter')?.value || '';
  const url = aid ? `/api/watch/alerts?account_id=${aid}` : '/api/watch/alerts';
  _watchAlerts = await api(url) || [];
  renderWatchAlerts();
}

function renderWatchAlerts() {
  const el = document.getElementById('watchAlertsList');
  if (!_watchAlerts.length) {
    el.innerHTML = `<div class="card" style="padding:40px;text-align:center;color:var(--text3)">
      <div style="font-size:16px;margin-bottom:8px">暂无监控规则</div>
      <div style="font-size:13px">点击右上角「+ 添加监控」设置物品、类型或套餐的库存告警</div>
    </div>`;
    return;
  }

  const groups = {};
  _watchAlerts.forEach(a => {
    const key = a.account_name;
    if (!groups[key]) groups[key] = { account_id: a.account_id, items: [] };
    groups[key].items.push(a);
  });

  let html = '';
  for (const [accName, group] of Object.entries(groups)) {
    const alertCount = group.items.filter(i => i.status === 'alert').length;
    const okCount = group.items.filter(i => i.status === 'ok').length;

    html += `<div class="card" style="margin-bottom:16px">
      <div style="padding:12px 16px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between">
        <div style="display:flex;align-items:center;gap:8px">
          <span style="font-size:14px;font-weight:600;color:var(--text1)">${accName}</span>
          ${alertCount ? `<span style="font-size:11px;padding:2px 8px;border-radius:10px;background:rgba(240,68,68,.12);color:var(--danger);font-weight:600">${alertCount} 告警</span>` : ''}
          ${okCount ? `<span style="font-size:11px;padding:2px 8px;border-radius:10px;background:rgba(34,197,94,.12);color:var(--success);font-weight:600">${okCount} 正常</span>` : ''}
        </div>
      </div>
      <table><tbody>`;

    for (const item of group.items) {
      const isAlert = item.status === 'alert';
      const isBundle = item.rule_type === 'bundle';
      const rowId = `watch_${item.rule_id}_${item.target_id.replace(/[^a-zA-Z0-9_]/g,'')}`;
      const hasDetail = (isBundle && item.components) || (!isBundle && isAlert && item.other_accounts?.some(oa => oa.account_id !== item.account_id && oa.quantity > 0));

      html += `<tr style="${isAlert ? 'background:rgba(240,68,68,.04)' : ''}">
        <td style="width:40px">
          ${isBundle ? '<span style="font-size:18px">📦</span>'
            : `<img class="item-img" src="${item.image_url}" onerror="this.style.opacity=.2">`}
        </td>
        <td>
          <div style="font-weight:500;color:${isAlert ? 'var(--danger)' : 'var(--text1)'}">${item.target_name}</div>
          ${item.target_en ? `<div style="font-size:11px;color:var(--text3)">${item.target_en}</div>` : ''}
          ${item.type_rule ? `<div style="font-size:10px;color:var(--text3)">类型: ${typeZh(item.type_rule)}</div>` : ''}
        </td>
        <td class="col-num" style="width:70px;color:var(--text2)">阈值 ${item.threshold}</td>
        <td class="col-num" style="width:70px;color:${isAlert ? 'var(--danger)' : 'var(--success)'}">
          ${isBundle ? (isAlert ? '⚠ 缺料' : '✓ 充足') : `库存 ${item.current}`}
        </td>
        <td class="col-num" style="width:70px;font-weight:700;color:${isAlert ? 'var(--danger)' : 'var(--success)'}">
          ${isAlert ? '-' + item.shortage : '✓'}
        </td>
        <td style="width:80px">
          <div style="display:flex;gap:4px">
            ${hasDetail ? `<button class="btn small" onclick="toggleWatchDetail('${rowId}')" style="font-size:10px;padding:1px 4px">展开</button>` : ''}
            <button class="btn small danger" onclick="deleteWatchRule(${item.rule_id})" style="font-size:10px;padding:1px 4px">删</button>
          </div>
        </td>
      </tr>`;

      if (isBundle && item.components) {
        html += `<tr id="${rowId}" style="display:none"><td colspan="6" style="padding:0">
          <div style="padding:8px 16px 8px 56px;background:var(--bg2);border-top:1px solid var(--border)">
            <div style="font-size:11px;color:var(--text3);margin-bottom:6px">套餐组件（×${item.threshold} 组）</div>
            <table style="width:100%"><tbody>
            ${item.components.map(c => {
              const cAlert = c.shortage > 0;
              const otherHtml = (c.other_accounts || [])
                .filter(oa => oa.account_id !== item.account_id && oa.quantity > 0)
                .map(oa => `<span style="display:inline-block;margin:1px 2px;padding:1px 6px;border-radius:3px;font-size:11px;background:var(--bg3);border:1px solid var(--border)">${oa.account_name} ×${oa.quantity}</span>`)
                .join('');
              return `<tr style="${cAlert ? 'background:rgba(240,68,68,.06)' : ''}">
                <td style="width:28px"><img class="item-img" src="${c.image_url}" style="width:24px;height:24px" onerror="this.style.opacity=.2"></td>
                <td style="font-size:12px;font-weight:500;color:${cAlert ? 'var(--danger)' : 'var(--text1)'}">${c.name_zh}</td>
                <td class="col-num" style="font-size:12px;width:60px;color:var(--text2)">需 ${c.need}</td>
                <td class="col-num" style="font-size:12px;width:60px;color:${cAlert ? 'var(--danger)' : 'var(--success)'}">有 ${c.have}</td>
                <td class="col-num" style="font-size:12px;width:60px;font-weight:600;color:${cAlert ? 'var(--danger)' : 'var(--success)'}">${cAlert ? '-'+c.shortage : '✓'}</td>
                <td style="font-size:11px">${otherHtml || '<span style="color:var(--text3)">—</span>'}</td>
              </tr>`;
            }).join('')}
            </tbody></table>
          </div>
        </td></tr>`;
      }

      if (!isBundle && isAlert && item.other_accounts) {
        const others = item.other_accounts.filter(oa => oa.account_id !== item.account_id && oa.quantity > 0);
        if (others.length) {
          html += `<tr id="${rowId}" style="display:none"><td colspan="6" style="padding:0">
            <div style="padding:6px 16px 6px 56px;background:var(--bg2);border-top:1px solid var(--border);font-size:12px">
              <span style="color:var(--text3)">其他账号:</span>
              ${others.map(oa =>
                `<span style="display:inline-block;margin:1px 3px;padding:2px 8px;border-radius:4px;background:var(--bg3);border:1px solid var(--border)">${oa.account_name} <b style="color:var(--accent2)">×${oa.quantity}</b></span>`
              ).join('')}
            </div>
          </td></tr>`;
        }
      }
    }
    html += '</tbody></table></div>';
  }
  el.innerHTML = html;
}

function toggleWatchDetail(rowId) {
  const row = document.getElementById(rowId);
  if (row) row.style.display = row.style.display === 'none' ? '' : 'none';
}

async function deleteWatchRule(ruleId) {
  await api(`/api/watch/rule/${ruleId}`, { method: 'DELETE' });
  loadWatchAlerts();
}

// ══════════ 添加规则弹窗 ══════════
let _wrType = 'item';
let _wrSelectedItems = [];

// 物品模式的筛选状态
const _wrFilter = {
  group: '',       // 当前大类（武器/装备/材料...）
  subtype: '',     // 当前子类型
  rarity: '',      // 当前稀有度
  search: '',      // 搜索关键词
  results: [],     // 当前过滤结果
};

// 大类分组（复用 inventory.js 的分组结构）
const WR_TYPE_GROUPS = [
  { label:'武器',   types:['Assault Rifle','Battle Rifle','SMG','LMG','Shotgun','Sniper Rifle','Pistol','Hand Cannon'] },
  { label:'装备',   types:['Shield','Augment','Modification'] },
  { label:'材料',   types:['Basic Material','Material','Refined Material','Topside Material','Nature','Recyclable'] },
  { label:'消耗品', types:['Ammunition','Quick Use'] },
  { label:'其他',   types:['Key','Blueprint','Trinket','Special','Outfit','Cosmetic','BackpackCharm','Misc'] },
];
const WR_RARITIES = [
  { value:'Legendary', label:'传说', color:'#b45309' },
  { value:'Epic',      label:'史诗', color:'#7c3aed' },
  { value:'Rare',      label:'稀有', color:'#1d4ed8' },
  { value:'Uncommon',  label:'优秀', color:'#15803d' },
  { value:'Common',    label:'普通', color:'var(--text3)' },
];

async function openWatchRuleEditor() {
  _wrType = 'item';
  _wrSelectedItems = [];
  Object.assign(_wrFilter, { group:'', subtype:'', rarity:'', search:'', results:[] });
  await loadWatchAccounts();
  document.getElementById('watchRuleThreshold').value = 1;
  document.getElementById('watchRuleModal').style.display = 'flex';
  setWatchRuleType('item');
}

function setWatchRuleType(type) {
  _wrType = type;
  document.getElementById('wrType_item').classList.toggle('active', type === 'item');
  document.getElementById('wrType_type').classList.toggle('active', type === 'type');
  document.getElementById('wrType_bundle').classList.toggle('active', type === 'bundle');
  Object.assign(_wrFilter, { group:'', subtype:'', rarity:'', search:'', results:[] });
  _wrRenderFilter();
  _wrRenderResults();
  _wrRenderSelectedBar();
}

// ── 阈值保存反馈 ──
function wrThresholdFeedback(el) {
  el.style.borderColor = 'var(--success)';
  el.style.boxShadow = '0 0 0 2px rgba(34,197,94,.25)';
  const check = document.getElementById('wrThresholdCheck');
  if (check) check.style.opacity = '1';
  setTimeout(() => {
    el.style.borderColor = 'var(--border)';
    el.style.boxShadow = 'none';
    if (check) check.style.opacity = '0';
  }, 1500);
}

// ── 筛选栏渲染 ──
function _wrRenderFilter() {
  const sec = document.getElementById('wrFilterSection');
  if (!sec) return;

  if (_wrType === 'item') {
    const groupBtns = WR_TYPE_GROUPS.map(g =>
      `<button class="tag-btn${_wrFilter.group === g.label ? ' active' : ''}"
        onclick="wrSetGroup('${g.label}')">${g.label}</button>`
    ).join('');

    let subtypeBtns = '';
    if (_wrFilter.group) {
      const grp = WR_TYPE_GROUPS.find(g => g.label === _wrFilter.group);
      if (grp && grp.types.length > 1) {
        subtypeBtns = `<div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:8px">
          <button class="tag-btn${!_wrFilter.subtype ? ' active' : ''}"
            onclick="wrSetSubtype('')" style="font-size:11px;padding:3px 10px">全部</button>
          ${grp.types.map(t =>
            `<button class="tag-btn${_wrFilter.subtype === t ? ' active' : ''}"
              onclick="wrSetSubtype('${t}')" style="font-size:11px;padding:3px 10px">${typeZh(t)}</button>`
          ).join('')}
        </div>`;
      }
    }

    const rarityBtns = WR_RARITIES.map(r =>
      `<button class="tag-btn${_wrFilter.rarity === r.value ? ' active' : ''}"
        onclick="wrSetRarity('${r.value}')"
        style="font-size:11px;padding:3px 10px;${_wrFilter.rarity === r.value ? '' : 'color:'+r.color}">${r.label}</button>`
    ).join('');

    sec.innerHTML = `
      <div style="display:flex;flex-wrap:wrap;gap:4px;align-items:center">
        <span style="font-size:11px;color:var(--text3);margin-right:2px">分类</span>
        <button class="tag-btn${!_wrFilter.group ? ' active' : ''}" onclick="wrSetGroup('')">全部</button>
        ${groupBtns}
        <span style="width:1px;height:16px;background:var(--border2);margin:0 4px"></span>
        <span style="font-size:11px;color:var(--text3);margin-right:2px">稀有度</span>
        <button class="tag-btn${!_wrFilter.rarity ? ' active' : ''}" onclick="wrSetRarity('')"
          style="font-size:11px;padding:3px 10px">全部</button>
        ${rarityBtns}
      </div>
      ${subtypeBtns}
      <div style="margin-top:8px">
        <input type="text" id="wrItemSearch" placeholder="搜索物品名称..." autocomplete="off"
          value="${_wrFilter.search.replace(/"/g,'&quot;')}"
          style="width:100%;font-size:13px;padding:6px 10px;border-radius:6px;border:1px solid var(--border);background:var(--bg2);color:var(--text1)"
          oninput="wrSetSearch(this.value)">
      </div>`;

  } else if (_wrType === 'type') {
    sec.innerHTML = `
      <div style="font-size:12px;color:var(--text2);margin-bottom:4px">
        选择物品类型
        <span style="color:var(--text3);font-size:11px">（勾选=监控整个类型 · 点名称=选具体物品）</span>
      </div>`;

  } else if (_wrType === 'bundle') {
    sec.innerHTML = `
      <div style="font-size:12px;color:var(--text2)">选择要监控的套餐</div>`;
  }
}

// ── 筛选操作 ──
function wrSetGroup(g) {
  _wrFilter.group = _wrFilter.group === g ? '' : g;
  _wrFilter.subtype = '';
  _wrRenderFilter();
  _wrLoadFilteredItems();
}

function wrSetSubtype(t) {
  _wrFilter.subtype = _wrFilter.subtype === t ? '' : t;
  _wrRenderFilter();
  _wrLoadFilteredItems();
}

function wrSetRarity(r) {
  _wrFilter.rarity = _wrFilter.rarity === r ? '' : r;
  _wrRenderFilter();
  _wrLoadFilteredItems();
}

let _wrSearchTimer;
function wrSetSearch(q) {
  _wrFilter.search = q;
  clearTimeout(_wrSearchTimer);
  _wrSearchTimer = setTimeout(() => _wrLoadFilteredItems(), 200);
}

async function _wrLoadFilteredItems() {
  if (_wrType !== 'item') return;

  const params = new URLSearchParams();
  if (_wrFilter.search) params.set('q', _wrFilter.search);
  if (_wrFilter.rarity) params.set('rarity', _wrFilter.rarity);

  // API 只支持单个 type 精确匹配，所以只在选了具体子类型时传 type
  if (_wrFilter.subtype) {
    params.set('type', _wrFilter.subtype);
  }

  const items = await api('/api/items?' + params.toString()) || [];

  // 选了大类但没选子类型时，客户端过滤
  let filtered = items;
  if (_wrFilter.group && !_wrFilter.subtype) {
    const grp = WR_TYPE_GROUPS.find(g => g.label === _wrFilter.group);
    if (grp) {
      const typeSet = new Set(grp.types);
      filtered = items.filter(it => typeSet.has(it.type));
    }
  }

  _wrFilter.results = filtered;
  _wrRenderResults();
}

// ── 结果区渲染 ──
function _wrRenderResults() {
  const area = document.getElementById('wrResultsArea');
  if (!area) return;

  if (_wrType === 'item') {
    _wrRenderItemResults(area);
  } else if (_wrType === 'type') {
    _wrRenderTypeResults(area);
  } else if (_wrType === 'bundle') {
    _wrRenderBundleResults(area);
  }
}

function _wrRenderItemResults(area) {
  const items = _wrFilter.results;

  if (!_wrFilter.group && !_wrFilter.rarity && !_wrFilter.search) {
    area.innerHTML = '<div style="padding:40px;text-align:center;color:var(--text3);font-size:13px">选择分类或稀有度筛选物品，或直接搜索物品名称</div>';
    return;
  }

  if (!items.length) {
    area.innerHTML = '<div style="padding:40px;text-align:center;color:var(--text3);font-size:13px">无匹配结果</div>';
    return;
  }

  const selectedIds = new Set(_wrSelectedItems.map(i => i.id));

  area.innerHTML = `
    <div style="font-size:11px;color:var(--text3);margin-bottom:8px">共 ${items.length} 个物品，点击星标添加到监控</div>
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(100px,1fr));gap:6px">
      ${items.map(it => {
        const sel = selectedIds.has(it.item_id);
        return `<div class="wr-item-card${sel ? ' wr-selected' : ''}" data-id="${it.item_id}"
          onclick="wrToggleItem(event,'${it.item_id}','${(it.name_zh||it.item_id).replace(/'/g,"\\'")}')"
          style="display:flex;flex-direction:column;align-items:center;padding:8px 4px;border-radius:6px;
            border:1px solid ${sel ? 'var(--accent)' : 'var(--border)'};cursor:pointer;
            background:${sel ? 'rgba(99,102,241,.08)' : 'var(--bg2)'};text-align:center;gap:4px;
            position:relative;transition:border-color .15s,background .15s">
          <span style="position:absolute;top:4px;right:4px;font-size:14px;color:${sel ? 'var(--accent)' : 'var(--border2)'};transition:color .15s">${sel ? '★' : '☆'}</span>
          <img src="/api/items/${it.item_id}/image" style="width:40px;height:40px;object-fit:contain;border-radius:4px" onerror="this.style.opacity=.2">
          <span style="font-size:10px;color:var(--text1);line-height:1.2;word-break:break-all;max-width:90px">${it.name_zh||it.item_id}</span>
          <span style="font-size:9px;color:var(--text3)">${typeZh(it.type)||''}</span>
        </div>`;
      }).join('')}
    </div>`;
}

// 点击星标切换选择（不重置滚动位置）
function wrToggleItem(event, itemId, nameZh) {
  event.stopPropagation();
  const idx = _wrSelectedItems.findIndex(i => i.id === itemId);
  if (idx > -1) {
    _wrSelectedItems.splice(idx, 1);
  } else {
    _wrSelectedItems.push({ id: itemId, name: nameZh });
  }

  // 局部更新卡片状态，不重建整个列表（避免滚动重置）
  const card = document.querySelector(`.wr-item-card[data-id="${itemId}"]`);
  if (card) {
    const sel = idx === -1; // 刚添加
    card.classList.toggle('wr-selected', sel);
    card.style.borderColor = sel ? 'var(--accent)' : 'var(--border)';
    card.style.background = sel ? 'rgba(99,102,241,.08)' : 'var(--bg2)';
    const star = card.querySelector('span');
    if (star) {
      star.textContent = sel ? '★' : '☆';
      star.style.color = sel ? 'var(--accent)' : 'var(--border2)';
    }
  }

  _wrRenderSelectedBar();
}

async function _wrRenderTypeResults(area) {
  const types = await api('/api/watch/item-types') || [];
  area.innerHTML = `
    <div style="display:flex;flex-wrap:wrap;gap:6px">
      ${types.map(t => `<div style="display:inline-flex;align-items:center;gap:4px;padding:5px 12px;border-radius:6px;border:1px solid var(--border);font-size:12px;background:var(--bg2)">
        <input type="checkbox" class="wr-type-cb" value="${t}">
        <span onclick="openTypeItemPicker('${t.replace(/'/g,"\\'")}')" style="cursor:pointer;color:var(--accent);text-decoration:underline">${typeZh(t)}</span>
      </div>`).join('')}
    </div>`;
}

async function _wrRenderBundleResults(area) {
  const bundles = await api('/api/bundles') || [];
  area.innerHTML = `
    <div style="border:1px solid var(--border);border-radius:6px">
      ${bundles.map(b => {
        const alias = b.aliases?.[0]?.alias || '';
        const label = alias || b.name;
        const itemCount = b.items?.length || 0;
        const itemPreview = (b.items||[]).slice(0,5).map(it =>
          `<img src="/api/items/${it.item_id}/image" style="width:20px;height:20px;object-fit:contain;border-radius:2px" onerror="this.style.opacity=.2">`
        ).join('');
        return `<div style="display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid var(--border);font-size:12px">
          <input type="checkbox" class="wr-bundle-cb" value="${b.id}">
          <span style="font-size:16px">📦</span>
          <div style="flex:1;min-width:0">
            <div style="font-weight:500">${label}</div>
            ${alias ? `<div style="font-size:11px;color:var(--text3)">${b.name}</div>` : ''}
          </div>
          <div style="display:flex;gap:2px;flex-shrink:0">${itemPreview}</div>
          <span style="color:var(--text3);flex-shrink:0;font-size:11px">${itemCount} 件</span>
        </div>`;
      }).join('')}
    </div>`;
}

// ── 类型物品子选弹窗 ──
async function openTypeItemPicker(typeName) {
  const items = await api('/api/items?type=' + encodeURIComponent(typeName)) || [];
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.style.cssText = 'display:flex;z-index:10001';
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };

  overlay.innerHTML = `
    <div class="modal" style="max-width:700px;max-height:80vh;display:flex;flex-direction:column">
      <h2 style="margin-bottom:8px;flex-shrink:0">${typeZh(typeName)}</h2>
      <div style="margin-bottom:8px;display:flex;gap:8px;flex-shrink:0">
        <button class="btn small" onclick="this.closest('.modal').querySelectorAll('.wr-typepick-cb').forEach(c=>c.checked=true)">全选</button>
        <button class="btn small" onclick="this.closest('.modal').querySelectorAll('.wr-typepick-cb').forEach(c=>c.checked=false)">全不选</button>
        <span style="font-size:12px;color:var(--text3);margin-left:auto;align-self:center">共 ${items.length} 个物品</span>
      </div>
      <div style="flex:1;overflow-y:auto;display:grid;grid-template-columns:repeat(auto-fill,minmax(90px,1fr));gap:6px;padding:4px">
        ${items.map(it => `
          <label style="display:flex;flex-direction:column;align-items:center;padding:6px;border-radius:6px;border:1px solid var(--border);cursor:pointer;background:var(--bg2);text-align:center;gap:3px;position:relative">
            <input type="checkbox" class="wr-typepick-cb" value="${it.item_id}" style="position:absolute;top:4px;left:4px">
            <img src="/api/items/${it.item_id}/image" style="width:36px;height:36px;object-fit:contain;border-radius:4px;margin-top:4px" onerror="this.style.opacity=.2">
            <span style="font-size:10px;color:var(--text1);line-height:1.2;word-break:break-all">${it.name_zh||it.item_id}</span>
          </label>
        `).join('')}
      </div>
      <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px;flex-shrink:0">
        <button class="btn" onclick="confirmTypeItemPick(this.closest('.modal-overlay'))">确认选择</button>
        <button class="btn" onclick="this.closest('.modal-overlay').remove()">取消</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
}

function confirmTypeItemPick(overlay) {
  const checked = [...overlay.querySelectorAll('.wr-typepick-cb:checked')];
  checked.forEach(cb => {
    const nameEl = cb.closest('label')?.querySelector('span');
    const name = nameEl?.textContent || cb.value;
    if (!_wrSelectedItems.find(i => i.id === cb.value)) {
      _wrSelectedItems.push({ id: cb.value, name });
    }
  });
  _wrRenderSelectedBar();
  overlay.remove();
}

// ── 已选栏 ──
function _wrRenderSelectedBar() {
  const bar = document.getElementById('wrSelectedBar');
  const el = document.getElementById('wrSelectedItems');
  if (!bar || !el) return;

  if (_wrSelectedItems.length) {
    bar.style.display = '';
    el.innerHTML = `<span style="font-size:11px;color:var(--text3);margin-right:4px">已选 ${_wrSelectedItems.length} 项:</span>` +
      _wrSelectedItems.map(i =>
        `<span style="display:inline-flex;align-items:center;gap:4px;padding:3px 8px;border-radius:4px;background:rgba(99,102,241,.1);border:1px solid rgba(99,102,241,.3);font-size:12px;color:var(--accent)">
          ${i.name}
          <span onclick="wrRemoveItem('${i.id}')" style="cursor:pointer;color:var(--danger);font-size:10px">✕</span>
        </span>`
      ).join('');
  } else {
    bar.style.display = 'none';
    el.innerHTML = '';
  }
}

function wrRemoveItem(itemId) {
  _wrSelectedItems = _wrSelectedItems.filter(i => i.id !== itemId);
  _wrRenderSelectedBar();

  // 同步更新结果区的卡片外观（不重建列表）
  const card = document.querySelector(`.wr-item-card[data-id="${itemId}"]`);
  if (card) {
    card.classList.remove('wr-selected');
    card.style.borderColor = 'var(--border)';
    card.style.background = 'var(--bg2)';
    const star = card.querySelector('span');
    if (star) { star.textContent = '☆'; star.style.color = 'var(--border2)'; }
  }
}

// ── 保存规则 ──
async function saveWatchRule() {
  const accountId = document.getElementById('watchRuleAccount').value;
  const threshold = parseInt(document.getElementById('watchRuleThreshold').value) || 1;
  if (!accountId) return toast('请选择账号', 'error');

  const rules = [];

  if (_wrType === 'item') {
    if (!_wrSelectedItems.length) return toast('请选择至少一个物品', 'error');
    _wrSelectedItems.forEach(i => rules.push({ rule_type: 'item', target_id: i.id, threshold }));

  } else if (_wrType === 'type') {
    const typeChecked = [...document.querySelectorAll('.wr-type-cb:checked')].map(cb => cb.value);
    typeChecked.forEach(t => rules.push({ rule_type: 'type', target_id: t, threshold }));
    _wrSelectedItems.forEach(i => rules.push({ rule_type: 'item', target_id: i.id, threshold }));
    if (!rules.length) return toast('请选择至少一个类型或物品', 'error');

  } else if (_wrType === 'bundle') {
    const checked = [...document.querySelectorAll('.wr-bundle-cb:checked')].map(cb => cb.value);
    if (!checked.length) return toast('请选择至少一个套餐', 'error');
    checked.forEach(bid => rules.push({ rule_type: 'bundle', target_id: bid, threshold }));
  }

  const res = await api(`/api/watch/rules/${accountId}/batch`, {
    method: 'POST', body: JSON.stringify({ rules })
  });
  if (res?.ok) {
    toast(`已添加 ${res.added} 条监控规则`, 'success');
    _wrSelectedItems = [];
    closeModal('watchRuleModal');
    loadWatchAlerts();
  }
}