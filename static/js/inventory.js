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

/** 稀有度排序（高→低） */
const INV_RARITY_ORDER = { Legendary:0, Epic:1, Rare:2, Uncommon:3, Common:4, '':9 };

/** 稀有度 UI 标签（筛选条用） */
const INV_RARITIES = [
  { value:'Legendary', label:'传说', color:'#b45309' },
  { value:'Epic',      label:'史诗', color:'#7c3aed' },
  { value:'Rare',      label:'稀有', color:'#1d4ed8' },
  { value:'Uncommon',  label:'优秀', color:'#15803d' },
  { value:'Common',    label:'普通', color:'var(--text3)' },
];

const INV_PALETTE = [
  { bg:'rgba(12,35,64,.95)',  text:'#60a8f0', border:'#1a5a9e' },
  { bg:'rgba(10,46,24,.95)',  text:'#44d090', border:'#158a50' },
  { bg:'rgba(58,24,8,.95)',   text:'#f08050', border:'#b03818' },
  { bg:'rgba(40,8,42,.95)',   text:'#cc60d0', border:'#802888' },
  { bg:'rgba(58,44,0,.95)',   text:'#f0c030', border:'#b08010' },
  { bg:'rgba(0,48,48,.95)',   text:'#38c0c0', border:'#0e8080' },
  { bg:'rgba(50,12,28,.95)',  text:'#f05880', border:'#a02050' },
  { bg:'rgba(24,32,0,.95)',   text:'#98c038', border:'#508010' },
  { bg:'rgba(0,24,40,.95)',   text:'#38a0d0', border:'#0c6888' },
  { bg:'rgba(30,12,0,.95)',   text:'#c08038', border:'#784010' },
  { bg:'rgba(0,24,0,.95)',    text:'#58b858', border:'#187818' },
  { bg:'rgba(28,0,32,.95)',   text:'#8058c8', border:'#401888' },
];

const INV_TYPE_LABELS = {
  'Assault Rifle':'突击步枪', 'Battle Rifle':'战斗步枪', 'SMG':'冲锋枪',
  'LMG':'轻机枪', 'Shotgun':'霰弹枪', 'Sniper Rifle':'狙击步枪',
  'Pistol':'手枪', 'Hand Cannon':'手炮', 'Shield':'护盾', 'Augment':'强化模组',
  'Modification':'武器配件', 'Basic Material':'基础材料', 'Material':'材料',
  'Refined Material':'精炼材料', 'Topside Material':'地表材料',
  'Nature':'自然材料', 'Recyclable':'可回收品', 'Ammunition':'弹药',
  'Quick Use':'快速使用品', 'Key':'钥匙', 'Blueprint':'蓝图',
  'Trinket':'小物件', 'Special':'特殊物品', 'Outfit':'服装',
  'Cosmetic':'装饰品', 'BackpackCharm':'背包挂饰', 'Misc':'杂项',
};

const INV_TYPE_GROUPS = [
  { label:'武器',   types:['Assault Rifle','Battle Rifle','SMG','LMG','Shotgun','Sniper Rifle','Pistol','Hand Cannon'] },
  { label:'装备',   types:['Shield','Augment','Modification'] },
  { label:'材料',   types:['Basic Material','Material','Refined Material','Topside Material','Nature','Recyclable'] },
  { label:'消耗品', types:['Ammunition','Quick Use'] },
  { label:'其他',   types:['Key','Blueprint','Trinket','Special','Outfit','Cosmetic','BackpackCharm','Misc'] },
];

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

  inv.accounts.forEach((a, i) => { inv.colorIdx[a.id] = i; });

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
    list = list.filter(it =>
      (it.name_zh || '').toLowerCase().includes(q) ||
      (it.name_en || '').toLowerCase().includes(q) ||
      it.item_id.includes(q)
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

  // 从 gameItems 中匹配（包括库存中没有的）
  const matches = (inv.gameItems || []).filter(g =>
    (g.name_zh || '').toLowerCase().includes(q) ||
    (g.name_en || '').toLowerCase().includes(q) ||
    g.item_id.includes(q)
  ).slice(0, 15);

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
  for (const g of matches) {
    if (g.recipe && Object.keys(g.recipe).length && !inv.craftCache[g.item_id]) {
      api(`/api/craft/craftable?item_id=${g.item_id}`).then(data => {
        if (data && data.accounts) {
          inv.craftCache[g.item_id] = data;
          invShowDropdown(); // 刷新下拉
        }
      });
      break; // 一次只加载一个，避免并发过多
    }
  }
}

function invSelectSearchItem(itemId) {
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

// 点击外部关闭下拉
document.addEventListener('click', e => {
  const dd = document.getElementById('invSearchDropdown');
  if (dd && !e.target.closest('.search-wrap')) dd.style.display = 'none';
});

// 加载搜索结果中有 recipe 的物品的合成数据
let _craftLoadTimer = null;
function _invLoadCraftData() {
  clearTimeout(_craftLoadTimer);
  if (!inv.search) return;
  // 防抖：300ms 后执行
  _craftLoadTimer = setTimeout(async () => {
    const filtered = inv.items.filter(it =>
      (it.name_zh || '').toLowerCase().includes(inv.search.toLowerCase()) ||
      (it.name_en || '').toLowerCase().includes(inv.search.toLowerCase()) ||
      it.item_id.includes(inv.search.toLowerCase())
    );
    // 找出有 recipe 的物品（从 gameItems 中查找）
    for (const it of filtered) {
      if (inv.craftCache[it.item_id]) continue; // 已有缓存
      const gameItem = inv.gameItems.find(g => g.item_id === it.item_id);
      if (!gameItem || !gameItem.recipe || !Object.keys(gameItem.recipe).length) continue;
      // 异步加载
      const data = await api(`/api/craft/craftable?item_id=${it.item_id}`);
      if (data && data.accounts) {
        inv.craftCache[it.item_id] = data;
        _invRenderRow3(); // 刷新显示
      }
    }
  }, 300);
}

// ─── 7. 第二栏：账号选择器 ───────────────────────────────────

function _invRenderRow2() {
  // 渲染到侧边栏子菜单
  const sidebar = document.getElementById('invAccSub');
  if (!sidebar) return;

  const allSel = inv.selAccs.length === inv.accounts.length;
  sidebar.innerHTML = `
    <div class="nav-sub-item${allSel ? ' active' : ''}" onclick="invToggleAllAcc()">全部</div>
    ${inv.accounts.map(a => {
      const c   = _color(a.id);
      const sel = inv.selAccs.includes(a.id);
      return `<div class="nav-sub-item${sel ? ' active' : ''}" onclick="invToggleAcc(${a.id})"
        style="${sel ? 'color:'+c.text : ''}"
      >${_esc(a.name)}</div>`;
    }).join('')}
  `;
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
  _invRenderCardMode(el);
}

// ─── 9. 卡片模式（主视图，默认展示所有选中账号）──────────────

function _invRenderCardMode(container) {
  const accData = inv.selAccs.map(id => inv.accounts.find(a => a.id === id)).filter(Boolean);

  if (!accData.length) {
    container.innerHTML = '<div class="empty" style="padding:48px">请在上方选择至少一个账号</div>';
    return;
  }

  // 动态计算：每列至少能展示4个物品（minmax(58px,1fr)×4 + gap×3 + padding×2 ≈ 270px）
  const COL_MIN_W = 270, GAP = 10, PAD = 10;
  const availW = container.clientWidth - PAD * 2;
  const maxFit = Math.max(1, Math.floor((availW + GAP) / (COL_MIN_W + GAP)));
  const scrollable = accData.length > maxFit;

  container.innerHTML = `
    <div id="inv-card-wrap"
      style="display:flex;gap:${GAP}px;padding:${PAD}px;height:100%;box-sizing:border-box;
        overflow-x:${scrollable ? 'auto' : 'hidden'};overflow-y:hidden;
        align-items:stretch;user-select:none;cursor:${scrollable ? 'grab' : 'default'}">
      ${accData.map(acc => _buildAccColumn(acc, maxFit)).join('')}
    </div>`;

  if (scrollable) _initDragScroll('inv-card-wrap');
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
  items = _sortItems(items, 'game');

  // 统计 badge
  const failBundles = inv.bundles.filter(b => {
    if (!rules.some(r => r.rule_type === 'bundle' && Number(r.target_id) === b.id)) return false;
    return !(b.items || []).every(bi => {
      const invItem = inv.items.find(i => i.item_id === bi.item_id);
      return (_getAccItemQty(invItem || { accounts:[] }, acc.id) || 0) >= bi.quantity;
    });
  }).length;

  // 能放下则 flex 自适应，否则固定最小宽度用于横向滚动
  const colFlex = inv.selAccs.length <= maxFit ? 'flex:1;min-width:0' : 'flex:0 0 270px';

  return `
    <div class="inv-col" style="${colFlex};border:1px solid ${c.border}">
      <div class="inv-col-header" style="background:${c.bg};border-bottom:1px solid ${c.border}">
        <div class="inv-col-header-row1">
          <span class="inv-col-title" style="color:${c.text}">${_esc(acc.name)}</span>
          ${failBundles > 0 ? `<span class="inv-alert-badge green">套 ${failBundles}</span>` : ''}
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
      <div style="flex:1;overflow-y:auto;background:var(--bg1)">
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
      <img src="/api/items/${item.item_id}/image" onerror="this.style.opacity=.2">
      ${showQty}
      ${craftLabel}
      ${_isStarredFor(item.item_id, rules) ? '<span class="tile-star">★</span>' : ''}
      ${bname ? '<span class="tile-bundle">套</span>' : ''}
      ${lvl ? `<span class="tile-dot" style="background:${lvl === 'red' ? 'var(--danger)' : 'var(--warning)'}"></span>` : ''}
    </div>`;
}

function _initDragScroll(id) {
  const el = document.getElementById(id);
  if (!el) return;
  let dragging = false, startX = 0, scrollStart = 0;
  el.addEventListener('mousedown', e => {
    dragging = true; startX = e.clientX; scrollStart = el.scrollLeft;
    el.style.cursor = 'grabbing';
  });
  el.addEventListener('mousemove', e => {
    if (!dragging) return;
    e.preventDefault();
    el.scrollLeft = scrollStart - (e.clientX - startX);
  });
  const stop = () => { dragging = false; el.style.cursor = 'grab'; };
  el.addEventListener('mouseup', stop);
  el.addEventListener('mouseleave', stop);
}

// ─── 窗口 resize 时重新计算列布局 ──────────────────────────────
let _invResizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(_invResizeTimer);
  _invResizeTimer = setTimeout(() => _invRenderRow3(), 150);
});