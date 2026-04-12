'use strict';

// ══════════════════════════════════════════════════════════════
//  inventory.js — 库存模块（纯卡片模式）
// ══════════════════════════════════════════════════════════════

// ─── 1. 常量 ─────────────────────────────────────────────────

/** 游戏官方物品种类排序顺序 */
const INV_TYPE_ORDER = [
  'Augment','Shield',
  'Assault Rifle','Battle Rifle','SMG','LMG','Shotgun','Sniper Rifle','Pistol','Hand Cannon',
  'Modification',
  'Quick Use',
  'Recyclable','Topside Material','Refined Material','Basic Material','Material','Nature',
  'Ammunition','Key','Blueprint',
  'Trinket','Special','Outfit','Cosmetic','BackpackCharm','Misc',
];
const _typeIdx = {};
INV_TYPE_ORDER.forEach((t, i) => { _typeIdx[t] = i; });

// INV_TYPE_LABELS, INV_TYPE_GROUPS, INV_RARITIES, INV_RARITY_ORDER, INV_PALETTE
// 已移至 common.js 统一定义

/** 判断物品属于哪个分类组（is_weapon 的归入武器，不看 type） */
function itemMatchesGroup(item, groupLabel) {
  const grp = INV_TYPE_GROUPS.find(g => g.label === groupLabel);
  if (!grp) return false;
  if (groupLabel === '武器' && item.is_weapon) return true;
  if (groupLabel !== '武器' && item.is_weapon) return false; // is_weapon 不归其他组
  return grp.types.includes(item.type);
}

// ─── 2. 模块状态 ──────────────────────────────────────────────

const inv = {
  items:     [],   // /api/inventory
  gameItems: [],   // /api/items — 全量物品库
  accounts:  [],
  bundles:   [],
  rules:     {},   // { accId: Rule[] }

  selAccs:  [],          // 选中的账号ID（默认全选）
  search:   '',
  group:    '',          // 大类别筛选：武器/装备/材料/消耗品/其他
  subtype:  '',          // 子类别筛选：如 Assault Rifle
  rarity:   '',          // 稀有度筛选：Legendary/Epic/Rare/Uncommon/Common
  sortQty:  '',          // 按数量排序：''(默认种类)|'asc'|'desc'

  colorIdx: {},

  // 集齐状态 { accId: Set([itemId, ...]) }，loadInventory 时清除
  gathered: {},

  // 合成数据缓存 { item_id: { accounts: [{account_id, craftable, ...}] } }
  craftCache: {},
};

// ─── 3. 数据层 ────────────────────────────────────────────────

async function loadInventory() {
  const [items, accounts, bundles, gameItems] = await Promise.all([
    api('/api/inventory'),
    api('/api/accounts'),
    api('/api/bundles').catch(() => []),
    api('/api/items').catch(() => []),
  ]);

  inv.items     = items     || [];
  inv.gameItems = gameItems || [];
  inv.accounts  = (accounts || []).filter(a => a.active);
  inv.bundles   = bundles   || [];
  inv.rules     = {};
  inv.gathered  = {};  // 数据刷新，清除集齐状态

  // 一次性构建 item_id → aliases 映射，避免每次过滤重建（性能）
  inv.aliasMap = {};
  for (const g of inv.gameItems) {
    if (g.aliases && g.aliases.length) inv.aliasMap[g.item_id] = g.aliases;
  }

  ensureColorIndex(inv.accounts);

  // 默认全选所有账号
  if (!inv.selAccs.length) {
    inv.selAccs = inv.accounts.map(a => a.id);
  }
  // 预加载所有账号的关注规则（缺货面板和呼吸灯依赖此数据）
  await Promise.all(inv.accounts.map(a => _loadRules(a.id)));

  _invRenderPage();
}

async function _loadRules(accId) {
  if (!accId || inv.rules[accId]) return;
  inv.rules[accId] = await api(`/api/watch/rules/${accId}`).catch(() => []) || [];
}

async function _reloadRules(accId) {
  inv.rules[accId] = await api(`/api/watch/rules/${accId}`).catch(() => []) || [];
}

// ─── 4. 纯工具函数 ────────────────────────────────────────────

function _esc(str) {
  return String(str ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function _color(accId) {
  return INV_PALETTE[(inv.colorIdx[accId] ?? 0) % INV_PALETTE.length];
}

function _slotPct(acc) {
  return acc.max_slots ? Math.min(100, Math.round(acc.used_slots / acc.max_slots * 100)) : 0;
}

function _fmtLastSync(iso) {
  if (!iso) return { text: '未同步', stale: true };
  const t = new Date(iso).getTime();
  if (isNaN(t)) return { text: '未同步', stale: true };
  const diffMs = Date.now() - t;
  const mins = Math.floor(diffMs / 60000);
  let text;
  if (mins < 1)       text = '刚刚';
  else if (mins < 60) text = `${mins}分钟前`;
  else if (mins < 1440) text = `${Math.floor(mins / 60)}小时前`;
  else                  text = `${Math.floor(mins / 1440)}天前`;
  return { text, stale: mins > 30 };
}

function _refreshLastSyncLabels() {
  document.querySelectorAll('.inv-last-sync').forEach(el => {
    const iso = el.getAttribute('data-last-sync') || '';
    const ls = _fmtLastSync(iso);
    el.innerHTML = ls.text + (ls.stale ? '<span class="inv-stale-icon" title="超过30分钟未更新">⚠</span>' : '');
  });
}

// 每 30 秒自动刷新一次"最后更新时间"标签（仅启动一次）
if (!window._invLastSyncTimer) {
  window._invLastSyncTimer = setInterval(_refreshLastSyncLabels, 30000);
}

// 每 60 秒轮询账号同步时间：若后台已完成新的同步，自动重新加载库存（仅库存页可见时）
if (!window._invAutoReloadTimer) {
  window._invAutoReloadTimer = setInterval(async () => {
    const page = document.getElementById('page-inventory');
    if (!page || !page.classList.contains('active')) return;
    try {
      const accounts = await api('/api/accounts');
      const newSig = (accounts || []).filter(a => a.active)
        .map(a => `${a.id}:${a.last_sync || ''}`).sort().join('|');
      const oldSig = (inv.accounts || [])
        .map(a => `${a.id}:${a.last_sync || ''}`).sort().join('|');
      if (newSig && newSig !== oldSig) loadInventory();
    } catch (e) {}
  }, 60000);
}

function _slotColor(acc) {
  if (!acc.max_slots) return 'var(--text3)';
  const r = acc.used_slots / acc.max_slots;
  return r >= 1 ? 'var(--danger)' : r >= 0.8 ? 'var(--warning)' : 'var(--text2)';
}

function _alertLevel(qty, rule) {
  if (!rule || !rule.threshold) return null;
  if (qty < rule.threshold)       return 'red';
  if (qty < rule.threshold * 1.5) return 'yellow';
  return null;
}

function _isStarredFor(itemId, rules) {
  return rules.some(r => r.rule_type === 'item' && r.target_id === itemId);
}

function _isStarredAny(item) {
  return Object.values(inv.rules).some(rules =>
    rules.some(r => r.rule_type === 'item' && r.target_id === item.item_id)
  );
}

function _bundledItemMap(accId, rules) {
  const map = {};
  const watchedIds = new Set(
    rules.filter(r => r.rule_type === 'bundle').map(r => Number(r.target_id))
  );
  inv.bundles.filter(b => watchedIds.has(b.id)).forEach(b => {
    (b.items || []).forEach(bi => { map[bi.item_id] = b.name; });
  });
  return map;
}

function _getAccItemQty(item, accId) {
  return ((item.accounts || []).find(a => a.account_id === accId) || {}).quantity;
}

/** 获取物品的种类排序索引，isWeapon的非武器类型归入武器组末尾 */
const _WEAPON_TYPES = new Set(['Assault Rifle','Battle Rifle','SMG','LMG','Shotgun','Sniper Rifle','Pistol','Hand Cannon']);
function _getTypeIdx(item) {
  // is_weapon 但 type 不在标准武器列表（如 Special 类型的武器），排在 Hand Cannon 后面
  if (item.is_weapon && !_WEAPON_TYPES.has(item.type)) {
    return (_typeIdx['Hand Cannon'] ?? 9) + 0.5;
  }
  return _typeIdx[item.type] ?? 99;
}

/** 排序：按种类（游戏顺序）→ 稀有度（高→低）→ 名称 */
function _sortByType(a, b) {
  const ta = _getTypeIdx(a);
  const tb = _getTypeIdx(b);
  if (ta !== tb) return ta - tb;
  const ra = INV_RARITY_ORDER[a.rarity] ?? 9;
  const rb = INV_RARITY_ORDER[b.rarity] ?? 9;
  if (ra !== rb) return ra - rb;
  return (a.name_zh || a.item_id).localeCompare(b.name_zh || b.item_id, 'zh');
}

/** 排序：按稀有度（高→低）→ 种类 → 名称 */
function _sortByRarity(a, b) {
  const ra = INV_RARITY_ORDER[a.rarity] ?? 9;
  const rb = INV_RARITY_ORDER[b.rarity] ?? 9;
  if (ra !== rb) return ra - rb;
  const ta = _getTypeIdx(a);
  const tb = _getTypeIdx(b);
  if (ta !== tb) return ta - tb;
  return (a.name_zh || a.item_id).localeCompare(b.name_zh || b.item_id, 'zh');
}

function _sortItems(items, sort) {
  const arr = [...items];
  return sort === 'type' ? arr.sort(_sortByType) : arr.sort(_sortByRarity);
}

function _filterItems(items, search, accId, rules) {
  let list = items;
  if (search) {
    const q = search.toLowerCase();
    const aliasMap = inv.aliasMap || {};  // 在 loadInventory 时已构建
    list = list.filter(it =>
      (it.name_zh || '').toLowerCase().includes(q) ||
      (it.name_en || '').toLowerCase().includes(q) ||
      it.item_id.includes(q) ||
      (aliasMap[it.item_id] || []).some(a => (a.alias || '').toLowerCase().includes(q))
    );
  }
  if (inv.subtype) {
    list = list.filter(it => it.type === inv.subtype);
  } else if (inv.group) {
    list = list.filter(it => itemMatchesGroup(it, inv.group));
  }
  if (inv.rarity) {
    list = list.filter(it => it.rarity === inv.rarity);
  }
  return list;
}

// ─── 4b. 缺货计算 & 集齐 ──────────────────────────────────────

/**
 * 计算指定账号的物品关注缺口（仅物品关注，不含套餐）。
 * 返回 [{ item_id, name_zh, name_en, image_url, total_needed, current, shortage }]
 */
/**
 * 判断物品在该账号下的物品关注状态：'ok' | 'short' | 'watched' | null
 */
function _getWatchStatus(itemId, accId, rules) {
  const itemRule = rules.find(r => r.rule_type === 'item' && r.target_id === itemId);
  if (!itemRule) return null;

  if (!itemRule.threshold) return 'watched'; // 有关注但没设阈值

  const invItem = inv.items.find(i => i.item_id === itemId);
  const current = invItem ? (_getAccItemQty(invItem, accId) || 0) : 0;
  return current >= itemRule.threshold ? 'ok' : 'short';
}


// ─── 5. 入口 & 顶层路由 ──────────────────────────────────────

function _invRenderPage() {
  _invRenderRow1();
  _invRenderRow2();
  _invRenderRow3();
}

// ─── 6. 第一栏：视图标签 + 排序 + 搜索 ──────────────────────

function _invRenderRow1() {
  const el = document.getElementById('inv-row1');
  if (!el) return;

  // 大类按钮
  const groupBtns = INV_TYPE_GROUPS.map(g =>
    `<button class="tag-btn${inv.group === g.label ? ' active' : ''}"
      onclick="invSetGroup('${g.label}')">${g.label}</button>`
  ).join('');

  // 稀有度按钮
  const rarityBtns = INV_RARITIES.map(r =>
    `<button class="tag-btn${inv.rarity === r.value ? ' active' : ''}"
      onclick="invSetRarity('${r.value}')"
      style="font-size:11px;padding:3px 10px;${inv.rarity === r.value ? '' : 'color:'+r.color}">${r.label}</button>`
  ).join('');

  // 子类型按钮（选中大类后展开）
  let subtypeHtml = '';
  if (inv.group) {
    const grp = INV_TYPE_GROUPS.find(g => g.label === inv.group);
    if (grp && grp.types.length > 1) {
      subtypeHtml = `
        <div style="display:flex;flex-wrap:wrap;gap:4px;padding:0 16px 6px">
          <button class="tag-btn${!inv.subtype ? ' active' : ''}"
            onclick="invSetSubtype('')" style="font-size:11px;padding:3px 10px">全部</button>
          ${grp.types.map(t =>
            `<button class="tag-btn${inv.subtype === t ? ' active' : ''}"
              onclick="invSetSubtype('${t}')" style="font-size:11px;padding:3px 10px">${INV_TYPE_LABELS[t] || t}</button>`
          ).join('')}
        </div>`;
    }
  }

  el.innerHTML = `
    <div style="display:flex;flex-wrap:wrap;gap:4px;align-items:center;padding:6px 16px">
      <div class="search-wrap" style="width:240px;margin-right:8px;position:relative">
        <span class="search-icon">⌕</span>
        <input type="text" id="invSearchInput" placeholder="搜索物品..." value="${_esc(inv.search)}"
          oninput="invSetSearch(this.value)" onfocus="invShowDropdown()" autocomplete="off">
        <div id="invSearchDropdown" class="ac-dropdown" style="display:none;max-height:320px"></div>
      </div>
      <span style="font-size:11px;color:var(--text3);margin-right:2px">分类</span>
      <button class="tag-btn${!inv.group ? ' active' : ''}" onclick="invSetGroup('')">全部</button>
      ${groupBtns}
      <span style="width:1px;height:16px;background:var(--border2);margin:0 4px"></span>
      <span style="font-size:11px;color:var(--text3);margin-right:2px">稀有度</span>
      <button class="tag-btn${!inv.rarity ? ' active' : ''}" onclick="invSetRarity('')"
        style="font-size:11px;padding:3px 10px">全部</button>
      ${rarityBtns}
      <span style="width:1px;height:16px;background:var(--border2);margin:0 4px"></span>
      <button class="tag-btn${inv.sortQty ? ' active' : ''}" onclick="invToggleSortQty()"
        style="font-size:11px;padding:3px 10px" title="点击切换按数量排序">
        数量 ${inv.sortQty === 'asc' ? '↑' : inv.sortQty === 'desc' ? '↓' : ''}
      </button>
    </div>
    ${subtypeHtml}
  `;
}

function invSetGroup(g) {
  inv.group = inv.group === g ? '' : g;
  inv.subtype = '';
  _invRenderRow1();
  _invRenderRow3();
}

function invSetSubtype(t) {
  inv.subtype = inv.subtype === t ? '' : t;
  _invRenderRow1();
  _invRenderRow3();
}

function invSetRarity(r) {
  inv.rarity = inv.rarity === r ? '' : r;
  _invRenderRow1();
  _invRenderRow3();
}

function invToggleSortQty() {
  // 循环：'' → 'asc' → 'desc' → ''
  inv.sortQty = inv.sortQty === '' ? 'asc' : inv.sortQty === 'asc' ? 'desc' : '';
  _invRenderRow1();
  _invRenderRow3();
}

// ── 搜索选择历史（localStorage 持久化）──
const _SEARCH_PICKS_KEY = 'inv_search_picks';
const _SEARCH_PICKS_MAX_KEYS = 100;
const _SEARCH_PICKS_MAX_PER_KEY = 10;

function _loadSearchPicks() {
  try { return JSON.parse(localStorage.getItem(_SEARCH_PICKS_KEY)) || {}; }
  catch { return {}; }
}

function _saveSearchPick(query, itemId) {
  const q = (query || '').toLowerCase().trim();
  if (!q || !itemId) return;
  const picks = _loadSearchPicks();
  // 该关键词的历史：去重后插到最前
  const list = picks[q] || [];
  const idx = list.indexOf(itemId);
  if (idx > -1) list.splice(idx, 1);
  list.unshift(itemId);
  picks[q] = list.slice(0, _SEARCH_PICKS_MAX_PER_KEY);
  // LRU 淘汰：超过上限时删最旧的关键词
  const keys = Object.keys(picks);
  if (keys.length > _SEARCH_PICKS_MAX_KEYS) {
    keys.slice(0, keys.length - _SEARCH_PICKS_MAX_KEYS).forEach(k => delete picks[k]);
  }
  try { localStorage.setItem(_SEARCH_PICKS_KEY, JSON.stringify(picks)); } catch {}
}

function invSetSearch(val) {
  inv.search = val;
  _invRenderRow3();
  _invLoadCraftData();
  invShowDropdown();
}

function invShowDropdown() {
  const dd = document.getElementById('invSearchDropdown');
  if (!dd) return;
  const q = (inv.search || '').toLowerCase().trim();
  if (!q) { dd.style.display = 'none'; return; }

  // 从 gameItems 中匹配（包括库存中没有的）— 别名也要参与搜索
  let matches = (inv.gameItems || []).filter(g =>
    (g.name_zh || '').toLowerCase().includes(q) ||
    (g.name_en || '').toLowerCase().includes(q) ||
    g.item_id.includes(q) ||
    (g.aliases || []).some(a => (a.alias || '').toLowerCase().includes(q))
  );

  // 按用户历史选择排序：最近选过的排最前
  const picks = (_loadSearchPicks()[q] || []);
  if (picks.length) {
    const pickIdx = {};
    picks.forEach((id, i) => { pickIdx[id] = i; });
    matches.sort((a, b) => {
      const pa = pickIdx[a.item_id] ?? 9999;
      const pb = pickIdx[b.item_id] ?? 9999;
      return pa - pb;
    });
  }
  matches = matches.slice(0, 15);

  if (!matches.length) { dd.style.display = 'none'; return; }

  dd.style.display = '';
  dd.innerHTML = matches.map(g => {
    // 查库存
    const invItem = inv.items.find(i => i.item_id === g.item_id);
    const total = invItem ? invItem.total : 0;
    const hasRecipe = g.recipe && Object.keys(g.recipe).length > 0;
    // 合成缓存
    const craftData = inv.craftCache[g.item_id];
    let craftTotal = 0;
    if (craftData && craftData.accounts) {
      craftTotal = craftData.accounts.reduce((s, a) => s + (a.craftable || 0), 0);
    }
    return `<div class="ac-item" onclick="invSelectSearchItem('${g.item_id}')">
      <img src="/api/items/${g.item_id}/image" style="width:28px;height:28px;object-fit:contain;border-radius:4px;background:var(--bg2)" onerror="this.style.opacity=.2">
      <div style="flex:1;min-width:0">
        <div style="font-size:13px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${g.name_zh || g.item_id}</div>
        <div style="font-size:11px;color:var(--text3)">${g.name_en || ''}</div>
      </div>
    </div>`;
  }).join('');

  // 对有 recipe 但没缓存的物品异步加载合成数据
  // 注意：原版会递归自调 invShowDropdown 刷新整个下拉，这在异步链里可能引发重复渲染。
  // 改为只在搜索词没变时重新调用一次（由用户视角自然触发再渲染）。
  const snapshotQ = q;
  for (const g of matches) {
    if (g.recipe && Object.keys(g.recipe).length && !inv.craftCache[g.item_id]) {
      api(`/api/craft/craftable?item_id=${g.item_id}`).then(data => {
        if (data && data.accounts) {
          inv.craftCache[g.item_id] = data;
        }
        // 只有当用户搜索词没变（同一上下文）时才重绘下拉，避免与新的搜索竞态
        if (snapshotQ === (inv.search || '').toLowerCase().trim()) {
          const dd2 = document.getElementById('invSearchDropdown');
          if (dd2 && dd2.style.display !== 'none') invShowDropdown();
        }
      });
      break; // 一次只加载一个，避免并发过多
    }
  }
}

function invSelectSearchItem(itemId) {
  // 记录选择历史（用当前搜索词，而非选中后的物品名）
  const currentQuery = (inv.search || '').toLowerCase().trim();
  if (currentQuery) _saveSearchPick(currentQuery, itemId);

  const g = (inv.gameItems || []).find(i => i.item_id === itemId);
  if (g) {
    inv.search = g.name_zh || g.item_id;
    const input = document.getElementById('invSearchInput');
    if (input) input.value = inv.search;
  }
  document.getElementById('invSearchDropdown').style.display = 'none';
  _invRenderRow3();
  _invLoadCraftData();
}

// 点击外部关闭下拉（幂等：脚本意外重载也不会重复绑定）
if (!window.__invDropdownClickBound) {
  window.__invDropdownClickBound = true;
  document.addEventListener('click', e => {
    const dd = document.getElementById('invSearchDropdown');
    if (dd && !e.target.closest('.search-wrap')) dd.style.display = 'none';
  });
}

// 加载搜索结果中有 recipe 的物品的合成数据
// 修复：不再 per-item 全量重建网格 — 那会在用户 hover 时导致 inv-tile 被销毁、
// globalTip 的 _tipEl 引用悬空、tooltip 残留在屏幕上。
// 改为：批量加载完后只重建一次。
let _craftLoadTimer = null;
let _craftLoadAbort = 0;  // 递增计数器，新一轮加载时使旧 promise 失效
function _invLoadCraftData() {
  clearTimeout(_craftLoadTimer);
  if (!inv.search) return;
  const myToken = ++_craftLoadAbort;
  _craftLoadTimer = setTimeout(async () => {
    const q = inv.search.toLowerCase();
    const filtered = inv.items.filter(it =>
      (it.name_zh || '').toLowerCase().includes(q) ||
      (it.name_en || '').toLowerCase().includes(q) ||
      it.item_id.includes(q)
    );
    // 找出所有需要查合成的物品 id（去缓存、去重、有 recipe）
    const todo = [];
    for (const it of filtered) {
      if (inv.craftCache[it.item_id]) continue;
      const gi = inv.gameItems.find(g => g.item_id === it.item_id);
      if (!gi || !gi.recipe || !Object.keys(gi.recipe).length) continue;
      todo.push(it.item_id);
    }
    if (!todo.length) return;

    // 并发加载，但只在全部完成后重建一次网格
    const results = await Promise.all(
      todo.map(id => api(`/api/craft/craftable?item_id=${id}`).catch(() => null))
    );
    // 如果用户已经触发了新一轮加载（搜索词又变了），丢弃旧结果
    if (myToken !== _craftLoadAbort) return;

    let anyUpdated = false;
    todo.forEach((id, i) => {
      const data = results[i];
      if (data && data.accounts) {
        inv.craftCache[id] = data;
        anyUpdated = true;
      }
    });
    if (anyUpdated) _invRenderRow3();
  }, 300);
}

// ─── 7. 第二栏：账号选择器 ───────────────────────────────────

function _invRenderRow2() {
  // 渲染到侧边栏子菜单
  const sidebar = document.getElementById('invAccSub');
  if (!sidebar) return;

  sidebar.innerHTML = `
    ${inv.accounts.map(a => {
      const c   = _color(a.id);
      const sel = inv.selAccs.includes(a.id);
      return `<div class="nav-sub-item${sel ? ' active' : ''}" onclick="invToggleAcc(${a.id})"
        style="${sel ? 'color:'+c.text : ''}"
      >${_esc(a.name)}</div>`;
    }).join('')}
  `;
}

// 点击侧栏"库存"标签时调用 — 选中所有账号并打开库存页
function invShowAllAndOpen() {
  inv.selAccs = inv.accounts.map(a => a.id);
  // 让 showPage 处理子菜单展开/收起（重复点击时 toggle）
  showPage('inventory');
  _invRenderRow2();
  _invRenderRow3();
}

function invToggleAcc(id) {
  const idx = inv.selAccs.indexOf(id);
  if (idx > -1) inv.selAccs.splice(idx, 1);
  else          inv.selAccs.push(id);
  _invRenderRow2();
  _invRenderRow3();
}

function invToggleAllAcc() {
  if (inv.selAccs.length === inv.accounts.length) {
    inv.selAccs = [];
  } else {
    inv.selAccs = inv.accounts.map(a => a.id);
  }
  _invRenderRow2();
  _invRenderRow3();
}

function invDeselectAcc(id) {
  inv.selAccs = inv.selAccs.filter(x => x !== id);
  _invRenderRow2();
  _invRenderRow3();
}

async function invSyncAcc(id, btn) {
  if (btn) { btn.disabled = true; btn.textContent = '…'; btn.style.opacity = '.5'; }
  const res = await api(`/api/accounts/${id}/sync`, { method:'POST' });
  toast(res.ok ? '同步成功' : '同步失败', res.ok ? 'success' : 'error');
  if (btn) { btn.disabled = false; btn.textContent = '↻'; btn.style.opacity = ''; }
  if (res.ok) loadInventory();
}

// ─── 8. 第三栏路由 ───────────────────────────────────────────

function _invRenderRow3() {
  const el = document.getElementById('inv-row3');
  if (!el) return;
  // DOM 重建前主动复位全局 tooltip — 否则正在 hover 的 inv-tile 被销毁后
  // 浏览器不会触发 mouseout，#globalTip 会卡在屏幕上残留
  if (typeof window.hideGlobalTip === 'function') window.hideGlobalTip();
  _invRenderCardMode(el);
}

// ─── 9. 卡片模式（主视图，默认展示所有选中账号）──────────────

// 每列最小宽度：保证至少显示4个物品
// 4×58(item) + 3×6(gap) + 2×8(padding) + 2×1(border) + ~17(scrollbar) = 285，取 290 留余量
const COL_MIN_W = 290;

function _invRenderCardMode(container) {
  const accData = inv.selAccs.map(id => inv.accounts.find(a => a.id === id)).filter(Boolean);

  if (!accData.length) {
    container.innerHTML = '<div class="empty" style="padding:48px">请在上方选择至少一个账号</div>';
    return;
  }

  const GAP = 10, PAD = 10;
  const availW = container.clientWidth - PAD * 2;
  const maxFit = Math.max(1, Math.floor((availW + GAP) / (COL_MIN_W + GAP)));
  const scrollable = accData.length > maxFit;

  container.innerHTML = `
    <div id="inv-card-wrap"
      style="display:flex;gap:${GAP}px;padding:${PAD}px;height:100%;box-sizing:border-box;
        overflow-x:auto;overflow-y:hidden;
        align-items:stretch;user-select:none">
      ${accData.map(acc => _buildAccColumn(acc, maxFit)).join('')}
    </div>`;

  // 总是绑定拖动（内部由主轴自动判定横/纵方向）
  _initDragScroll('inv-card-wrap');
  _refreshLastSyncLabels();
}

function _buildAccColumn(acc, maxFit) {
  const c       = _color(acc.id);
  const rules   = inv.rules[acc.id] || [];
  const bundled = _bundledItemMap(acc.id, rules);
  const pct     = _slotPct(acc);
  const sc      = _slotColor(acc);
  const gathered = inv.gathered[acc.id] || new Set();

  // 获取该账号有库存的物品
  let items = inv.items.filter(it => (_getAccItemQty(it, acc.id) || 0) > 0);

  // 搜索时：追加库存为0但可合成的物品
  if (inv.search) {
    const q = inv.search.toLowerCase();
    const existIds = new Set(items.map(i => i.item_id));
    for (const [itemId, craftData] of Object.entries(inv.craftCache)) {
      if (existIds.has(itemId)) continue;
      const accCraft = (craftData.accounts || []).find(a => a.account_id === acc.id);
      if (!accCraft || accCraft.craftable <= 0) continue;
      // 从 gameItems 获取物品信息
      const gi = inv.gameItems.find(g => g.item_id === itemId);
      if (!gi) continue;
      if (!(gi.name_zh || '').toLowerCase().includes(q) &&
          !(gi.name_en || '').toLowerCase().includes(q) &&
          !gi.item_id.includes(q)) continue;
      // 构造一个虚拟 inventory item 供显示
      items.push({
        item_id: itemId, name_zh: gi.name_zh, name_en: gi.name_en,
        rarity: gi.rarity, type: gi.type, is_weapon: gi.is_weapon,
        total: 0, accounts: [{ account_id: acc.id, account_name: acc.name, quantity: 0 }],
        _craftOnly: true,
      });
    }
  }

  // 过滤（全部/关注/其它 + 搜索）
  items = _filterItems(items, inv.search, acc.id, rules);

  // 排序
  if (inv.sortQty) {
    const dir = inv.sortQty === 'asc' ? 1 : -1;
    items = [...items].sort((a, b) => {
      const qa = _getAccItemQty(a, acc.id) || 0;
      const qb = _getAccItemQty(b, acc.id) || 0;
      if (qa !== qb) return (qa - qb) * dir;
      return _sortByType(a, b);
    });
  } else {
    items = _sortItems(items, 'game');
  }

  // 统计 badge
  const failBundles = inv.bundles.filter(b => {
    if (!rules.some(r => r.rule_type === 'bundle' && Number(r.target_id) === b.id)) return false;
    return !(b.items || []).every(bi => {
      const invItem = inv.items.find(i => i.item_id === bi.item_id);
      return (_getAccItemQty(invItem || { accounts:[] }, acc.id) || 0) >= bi.quantity;
    });
  }).length;

  // 每列最少显示4个物品宽度，能放下则自适应拉伸，放不下则横向滚动
  const colFlex = inv.selAccs.length <= maxFit ? `flex:1;min-width:${COL_MIN_W}px` : `flex:0 0 ${COL_MIN_W}px`;

  return `
    <div class="inv-col" style="${colFlex};border:1px solid ${c.border}">
      <div class="inv-col-header" style="background:${c.bg};border-bottom:1px solid ${c.border}">
        <div class="inv-col-header-row1">
          <span class="inv-col-title" style="color:${c.text}">${_esc(acc.name)}</span>
          ${failBundles > 0 ? `<span class="inv-alert-badge green">套 ${failBundles}</span>` : ''}
          <span class="inv-last-sync" data-last-sync="${acc.last_sync || ''}" title="最后更新: ${acc.last_sync || '从未同步'}"></span>
          <button class="inv-col-close" style="color:${c.text}"
            onclick="invDeselectAcc(${acc.id})">×</button>
        </div>
        <div class="inv-slot-row">
          <span class="inv-slot-label" style="color:${sc}">${acc.used_slots || 0}/${acc.max_slots || 0}</span>
          <div class="inv-slot-bar-wrap">
            <div class="inv-slot-bar" style="background:${sc};width:${pct}%"></div>
          </div>
          <span class="inv-slot-count" style="color:${c.text}">${items.length} 件</span>
          <button class="inv-col-close" style="color:${c.text};font-size:13px;font-weight:400;margin-left:4px" id="inv-sync-${acc.id}"
            onclick="event.stopPropagation();invSyncAcc(${acc.id},this)" title="同步库存">↻</button>
        </div>
      </div>
      <div class="inv-col-scroll" style="flex:1;overflow-y:auto;background:var(--bg1);user-select:none">
        <div class="inv-tile-grid">
          ${items.map(it => _buildCardTile(it, acc.id, rules, bundled, gathered)).join('') ||
            '<div class="empty" style="padding:24px;grid-column:1/-1">暂无物品</div>'}
        </div>
      </div>
    </div>`;
}

function _buildCardTile(item, accId, rules, bundled, gathered) {
  const qty   = _getAccItemQty(item, accId) || 0;
  const rule  = rules.find(r => r.rule_type === 'item' && r.target_id === item.item_id);
  const lvl   = _alertLevel(qty, rule);
  const bname = bundled[item.item_id] || null;
  const isGathered = gathered && gathered.has(item.item_id);

  // 关注状态（含套餐展开）
  const watchStatus = _getWatchStatus(item.item_id, accId, rules);
  // 呼吸灯：关注物品充足=绿闪，缺货=黄闪，全无=红闪（无库存但关注），集齐=灰
  let breatheClass = '';
  if (isGathered) {
    breatheClass = 'gathered';
  } else if (watchStatus === 'ok') {
    breatheClass = 'breathe-green';
  } else if (watchStatus === 'short') {
    breatheClass = qty > 0 ? 'breathe-yellow' : 'breathe-red';
  }

  const qtyColor = lvl === 'red' ? '#ff7070' : lvl === 'yellow' ? '#e8b830' : '#ccc';

  // 合成数量（如果有缓存数据）
  const craftData = inv.craftCache[item.item_id];
  let craftQty = 0;
  if (craftData && craftData.accounts) {
    const accCraft = craftData.accounts.find(a => a.account_id === accId);
    if (accCraft) craftQty = accCraft.craftable || 0;
  }

  const tooltip = [
    item.name_zh || item.item_id,
    item.name_en || '',
    INV_TYPE_LABELS[item.type] || item.type || '',
    item.rarity || '',
    `库存: ${qty}`,
    craftQty > 0 ? `可合成: ${craftQty}` : '',
    bname ? `套餐: ${bname}` : '',
    watchStatus === 'ok'    ? '✓ 关注物品充足' : '',
    watchStatus === 'short' ? '⚠ 关注物品缺货' : '',
  ].filter(Boolean).join('\n');

  // 库存0但可合成时，显示合成数作为主数字
  const showQty = qty > 0 ? `<span class="tile-qty" style="color:${qtyColor}">×${qty}</span>` :
                  craftQty > 0 ? `<span class="tile-qty" style="color:var(--accent)">⚒${craftQty}</span>` : `<span class="tile-qty" style="color:var(--text3)">×0</span>`;
  const craftLabel = qty > 0 && craftQty > 0 ? `<span class="tile-craft">+${craftQty}</span>` : '';

  return `
    <div class="inv-tile ${breatheClass}${qty === 0 && craftQty > 0 ? ' craft-only' : ''}" data-tip="${_esc(tooltip)}">
      <img src="/api/items/${item.item_id}/image" onerror="this.style.opacity=.2" draggable="false">
      ${showQty}
      ${craftLabel}
      ${_isStarredFor(item.item_id, rules) ? '<span class="tile-star">★</span>' : ''}
      ${bname ? '<span class="tile-bundle">套</span>' : ''}
      ${lvl ? `<span class="tile-dot" style="background:${lvl === 'red' ? 'var(--danger)' : 'var(--warning)'}"></span>` : ''}
    </div>`;
}

// ─── 拖动滚动（外层横向 + 列内纵向，按主轴自动判断）────────────
// 设计：
// - mousedown 立即记录起点，同时记住 outer（横向容器）和 col（落在哪个列的纵向滚动区）
// - mousemove 跨过阈值后，以当前 |dx| vs |dy| 判断主轴：
//     |dx| > |dy| → 横滚 outer.scrollLeft
//     |dy| > |dx| → 纵滚 col.scrollTop
// - 一次拖动只在第一次越过阈值时锁定主轴，之后保持不变（避免抖动切换）
// - mouseup 在 document 上，任何位置释放都能复位
// - 模块级状态 + 文档级监听器幂等绑定一次，避免每次重渲染累积 listener
let _dragState = null;  // { outer, col, x, y, outerStart, colStart, axis, moved }
const _DRAG_THRESHOLD = 3;

function _stopInvDrag() {
  if (_dragState) {
    if (_dragState.outer) _dragState.outer.style.cursor = '';
    if (_dragState.col)   _dragState.col.style.cursor   = '';
  }
  _dragState = null;
}

if (!window.__invDragBound) {
  window.__invDragBound = true;

  document.addEventListener('mousemove', e => {
    const s = _dragState;
    if (!s) return;
    if (s.outer && !s.outer.isConnected) { _stopInvDrag(); return; }
    const dx = e.clientX - s.x;
    const dy = e.clientY - s.y;
    // 第一次越过阈值：锁定主轴
    if (!s.moved) {
      const adx = Math.abs(dx), ady = Math.abs(dy);
      if (adx < _DRAG_THRESHOLD && ady < _DRAG_THRESHOLD) return;
      s.moved = true;
      // 主轴偏向：哪边先越过就用哪边。相等（对角）时默认横向。
      s.axis = adx >= ady ? 'x' : 'y';
      // 纵向但没有 col（极少数情况：mousedown 不在任何列上）→ 降级为横向
      if (s.axis === 'y' && !s.col) s.axis = 'x';
      const target = s.axis === 'x' ? s.outer : s.col;
      if (target) target.style.cursor = 'grabbing';
    }
    e.preventDefault();
    if (s.axis === 'x' && s.outer) {
      s.outer.scrollLeft = s.outerStart - dx;
    } else if (s.axis === 'y' && s.col) {
      s.col.scrollTop = s.colStart - dy;
    }
  });

  document.addEventListener('mouseup',   _stopInvDrag);
  window.addEventListener('blur',        _stopInvDrag);
  document.addEventListener('mouseleave',_stopInvDrag);
  document.addEventListener('dragstart', e => {
    if (_dragState && _dragState.outer && _dragState.outer.contains(e.target)) {
      e.preventDefault();
      _stopInvDrag();
    }
  });
}

function _shouldSkipDrag(e) {
  if (e.button !== 0) return true;
  if (e.target.closest('button, input, a, [onclick]')) return true;
  return false;
}

function _initDragScroll(id) {
  const outer = document.getElementById(id);
  if (!outer) return;
  // 只在外层容器绑定一次 mousedown；纵横由主轴判定
  outer.addEventListener('mousedown', e => {
    if (_shouldSkipDrag(e)) return;
    e.preventDefault();
    // 找到鼠标落点所在的列纵向滚动区（如果有）
    const col = e.target.closest('.inv-col-scroll') || null;
    _dragState = {
      outer,
      col,
      x: e.clientX,
      y: e.clientY,
      outerStart: outer.scrollLeft,
      colStart:   col ? col.scrollTop : 0,
      axis: null,
      moved: false,
    };
  });
}

// ─── 窗口 resize 时重新计算列布局（幂等绑定）───────────────────
if (!window.__invResizeBound) {
  window.__invResizeBound = true;
  let _invResizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(_invResizeTimer);
    _invResizeTimer = setTimeout(() => _invRenderRow3(), 150);
  });
}