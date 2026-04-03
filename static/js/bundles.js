// ══════════ 套餐 ══════════
async function loadBundles() {
  const [bundles, sources] = await Promise.all([
    api('/api/bundles'),
    api('/api/bundles/sources'),
  ]);
  state.bundles.all     = bundles;
  state.bundles.sources = sources;
  renderBundleTags();
  filterBundles();
}

function renderBundleTags() {
  const tag = state.bundles.activeTag;
  const bar = document.getElementById('bundleTagBar');

  // 从套餐名里提取模块名
  const baseNames = new Set();
  state.bundles.all.forEach(b => {
    if (b.source !== 'manual') {
      const base = _bundleBaseName(b.name);
      baseNames.add(base);
    }
  });

  // 分组：工作台类 vs 项目类 vs 远征类
  const sorted = [...baseNames].sort();
  // 判断来源：如果该 baseName 下的套餐 source 是 hideout 就归工作台，projects 就归项目
  const sourceOf = (baseName) => {
    const b = state.bundles.all.find(b => _bundleBaseName(b.name) === baseName);
    return b ? b.source : '';
  };
  const stations    = sorted.filter(n => sourceOf(n) === 'hideout');
  const expeditions = sorted.filter(n => sourceOf(n) === 'projects' && /远征|expedition|season/i.test(n));
  const projects    = sorted.filter(n => sourceOf(n) === 'projects' && !/远征|expedition|season/i.test(n));
  const others      = sorted.filter(n => !stations.includes(n) && !expeditions.includes(n) && !projects.includes(n));

  const sep = '<span style="width:1px;height:16px;background:var(--border2);flex-shrink:0;margin:0 4px"></span>';
  const btn = (id, label) => `<button class="tag-btn${tag===id?' active':''}" onclick="setBundleTag('${id.replace(/'/g,"\\'")}')">${label}</button>`;

  bar.innerHTML = [
    btn('__custom__', '自定义'),
    stations.length ? sep : '',
    ...stations.map(n => btn(n, n)),
    projects.length ? sep : '',
    ...projects.map(n => btn(n, n)),
    expeditions.length ? sep : '',
    ...expeditions.map(n => btn(n, n)),
    others.length ? sep : '',
    ...others.map(n => btn(n, n)),
  ].join('');

  // 鼠标拖拽横向滚动（区分点击和拖拽）
  let _dragging = false, _startX = 0, _scrollStart = 0, _moved = false;
  bar.style.cursor = 'grab';
  bar.addEventListener('mousedown', (e) => {
    _dragging = true; _moved = false; _startX = e.clientX; _scrollStart = bar.scrollLeft;
    bar.style.cursor = 'grabbing';
  });
  document.addEventListener('mousemove', (e) => {
    if (!_dragging) return;
    const dx = e.clientX - _startX;
    if (Math.abs(dx) > 3) _moved = true;
    bar.scrollLeft = _scrollStart - dx;
  });
  document.addEventListener('mouseup', () => {
    _dragging = false; bar.style.cursor = 'grab';
  });
  // 拖拽过就阻止按钮点击
  bar.addEventListener('click', (e) => {
    if (_moved) { e.stopPropagation(); e.preventDefault(); _moved = false; }
  }, true);
}

function setBundleTag(tag) {
  state.bundles.activeTag = (state.bundles.activeTag === tag) ? '' : tag;
  renderBundleTags();
  filterBundles();
}

/** 提取套餐的系列基础名（去掉 Lv/阶段后缀 以及 " - 阶段名" 后缀） */
function _bundleBaseName(name) {
  return name
    .replace(/\s+-\s+.+$/, '')                          // "战利品展示架 - 凶暴的敌兽" → "战利品展示架"
    .replace(/\s+(Lv\d+(-\d+)?|阶段\d+(-\d+)?)$/i, '') // "装备工作台 Lv1" → "装备工作台"
    .trim();
}

/** 提取套餐的阶段名 */
function _bundlePhaseName(name) {
  // " - 1. 阶段名" 或 " - 阶段名" 格式
  const dashMatch = name.match(/\s+-\s+(.+)$/);
  if (dashMatch) return dashMatch[1];
  // "Lv1" 格式
  const lvMatch = name.match(/\s+(Lv\d+(-\d+)?|阶段\d+(-\d+)?)$/i);
  if (lvMatch) return lvMatch[1];
  return '';
}

/** 提取套餐的排序序号（单阶段在前，组合在后） */
function _bundleSortKey(name) {
  // Lv 格式: "Lv1" → 101(单), "Lv1-2" → 10102(组合)
  const lvMatch = name.match(/Lv(\d+)(?:-(\d+))?/i);
  if (lvMatch) {
    const start = parseInt(lvMatch[1]);
    const end = lvMatch[2] ? parseInt(lvMatch[2]) : start;
    return (start !== end ? 10000 : 0) + start * 100 + end;
  }
  // " - N. phaseName" 格式（项目单阶段）
  const dashNum = name.match(/\s+-\s+(\d+)\.\s/);
  if (dashNum) { const n = parseInt(dashNum[1]); return n * 100 + n; }
  return 0;
}

/** 判断套餐是否为组合（Lv1-2 格式） */
function _isComboBundle(name) {
  return /Lv\d+-\d+/i.test(name);
}

function filterBundles() {
  const tag = state.bundles.activeTag;
  let list  = state.bundles.all;

  if (!tag) {
    // 无选中 = 全部
  } else if (tag === '__custom__') {
    list = list.filter(b => b.source === 'manual');
  } else {
    list = list.filter(b => _bundleBaseName(b.name) === tag);
  }

  // 搜索栏过滤
  const q = (document.getElementById('bundleSearchInput')?.value || '').trim().toLowerCase();
  if (q) {
    list = list.filter(b => {
      if (b.name.toLowerCase().includes(q)) return true;
      if ((b.aliases || []).some(a => a.alias.toLowerCase().includes(q))) return true;
      if ((b.description || '').toLowerCase().includes(q)) return true;
      return false;
    });
  }
  renderBundles(list);
}

function renderBundles(list) {
  const countEl = document.getElementById('bundleCount');
  if (countEl) countEl.textContent = `共 ${list.length} 条`;
  const typeLabels = {item:'物品',service:'服务',mixed:'混合'};
  const typeColors = {item:'var(--accent)',service:'#e67e22',mixed:'#9b59b6'};
  const tag = state.bundles.activeTag;
  const isSeriesView = tag && tag !== '__custom__';

  if (!list.length) {
    document.getElementById('bundlesBody').innerHTML = '<tr><td colspan="6" class="empty">暂无套餐</td></tr>';
    return;
  }

  // 所有套餐（含组合）都从 DB 获取，按 baseName 分组显示
  let groups;
  if (isSeriesView) {
    const sorted = [...list].sort((a, b) => _bundleSortKey(a.name) - _bundleSortKey(b.name));
    groups = [{ baseName: tag, bundles: sorted, _isGroup: true }];
  } else {
    const map = new Map();
    list.forEach(b => {
      const base = b.source === 'manual' ? '__manual_' + b.id : _bundleBaseName(b.name);
      if (!map.has(base)) map.set(base, []);
      map.get(base).push(b);
    });
    groups = [...map.entries()].map(([baseName, bundles]) => ({
      baseName,
      bundles: bundles.sort((a, b) => _bundleSortKey(a.name) - _bundleSortKey(b.name)),
      _isGroup: bundles.length > 1 && !baseName.startsWith('__manual_'),
    }));
  }

  let html = '';
  let globalIdx = 0;
  for (const group of groups) {
    // 多条目分组：显示标题
    if (group._isGroup) {
      html += `<tr class="bundle-group-header">
        <td colspan="6" style="padding:10px 12px 4px;border-bottom:none">
          <span style="font-weight:600;font-size:13px;color:var(--text1)">${group.baseName}</span>
          <span style="font-size:11px;color:var(--text3);margin-left:8px">${group.bundles.length} 条</span>
        </td>
      </tr>`;
    }

    for (const b of group.bundles) {
      globalIdx++;
      const bType = b.type || 'item';
      const isCombo = _isComboBundle(b.name);

      // 别名和操作列 — 所有套餐都是真实 DB 记录，都有 id
      const aliasHtml = (b.aliases||[]).map(a =>
        `<span class="alias-tag">${a.alias}<span class="alias-del" onclick="deleteBundleAlias(${a.id},${b.id})">✕</span></span>`
      ).join('') + `<span onclick="addBundleAliasInline(${b.id})" style="cursor:pointer;color:var(--text3);font-size:12px;margin-left:4px">+</span>`;
      const actionHtml = `<div style="display:flex;gap:4px">
        <button class="btn small" onclick="openBundleEditor(${b.id})">编辑</button>
        <button class="btn small danger" onclick="deleteBundle(${b.id})">删</button>
      </div>`;

      let contentHtml = '';
      if (bType === 'service') {
        contentHtml = `<span style="font-size:12px;color:#e67e22;font-weight:600">${b.price != null ? '¥' + b.price : ''}</span>`;
        if (b.description) contentHtml += ` <span style="font-size:11px;color:var(--text3);margin-left:4px">${b.description}</span>`;
      } else {
        contentHtml = (b.items||[]).length
          ? (b.items||[]).map(it =>
            `<span class="item-tag" style="padding:2px 6px">
              <img src="/api/items/${it.item_id}/image" style="width:20px;height:20px;object-fit:contain" onerror="this.style.opacity=.2">
              ${it.name_zh||it.item_id}
              <span style="color:var(--accent);font-weight:600">×${it.quantity}</span>
            </span>`
          ).join('')
          : '<span style="font-size:11px;color:var(--text3)">未配置物品</span>';
        if (bType === 'mixed' && b.price != null) {
          contentHtml += ` <span style="font-size:12px;color:#9b59b6;font-weight:600;margin-left:6px">+ ¥${b.price}</span>`;
        }
      }

      const typeTag = bType !== 'item'
        ? `<span style="font-size:10px;color:${typeColors[bType]};border:1px solid ${typeColors[bType]};border-radius:3px;padding:0 4px;margin-left:4px">${typeLabels[bType]}</span>`
        : '';

      // 分组内显示阶段名，否则显示完整名
      const displayName = group._isGroup ? (_bundlePhaseName(b.name) || b.name) : b.name;
      const indent = group._isGroup ? 'padding-left:24px' : '';
      const comboStyle = isCombo ? 'background:var(--bg2)' : '';

      html += `<tr style="${comboStyle}">
        <td style="color:var(--text3);font-size:12px;text-align:center">${globalIdx}</td>
        <td style="font-weight:500;${indent}">${displayName}${typeTag}</td>
        <td>${aliasHtml}</td>
        <td style="line-height:1.8">${contentHtml}</td>
        <td><span style="font-size:11px;color:var(--text3)">${{hideout:'基础',projects:'项目',manual:'自定义'}[b.source]||b.source}</span></td>
        <td>${actionHtml}</td>
      </tr>`;
    }
  }
  document.getElementById('bundlesBody').innerHTML = html;
}

function setBundleType(type) {
  state.bundle.editingType = type;
  // 更新按钮样式
  document.querySelectorAll('#bundleTypeSelector .btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.type === type);
  });
  // 切换区域显示
  const itemsSec = document.getElementById('bundleItemsSection');
  const priceSec = document.getElementById('bundleServiceSection');
  const descSec  = document.getElementById('bundleDescSection');
  itemsSec.style.display = (type === 'service') ? 'none' : '';
  priceSec.style.display = (type === 'item') ? 'none' : '';
  descSec.style.display  = (type === 'item') ? 'none' : '';
}

async function openBundleEditor(id) {
  state.bundle.editingId = id || null;
  // 队列进度显示
  const queue = state._pendingBundleQueue;
  const pending = state._pendingBundleCreate;
  let title = id ? '编辑套餐' : '新建套餐';
  if (!id && queue && queue.length > 0) {
    const total = queue.length + (pending ? 0 : 0);  // queue includes current
    const currentIdx = total - queue.length + 1;
    title = `新建套餐 (${queue.length} 个待创建)`;
    if (pending) {
      title += ` — ${pending.alias}`;
    }
  }
  document.getElementById('bundleEditorTitle').textContent = title;
  const editor = document.getElementById('bundleItemsEditor');
  editor.innerHTML = '';

  // 清除之前的配件推荐区
  const existingSugg = document.getElementById('modSuggestions');
  if (existingSugg) existingSugg.remove();

  // 重置服务字段
  document.getElementById('bundlePrice').value = '';
  document.getElementById('bundleDescription').value = '';

  if (id) {
    const b = await api(`/api/bundles/${id}`);
    document.getElementById('bundleName').value = b.name;
    setBundleType(b.type || 'item');
    if (b.price != null) document.getElementById('bundlePrice').value = b.price;
    if (b.description) document.getElementById('bundleDescription').value = b.description;
    (b.items||[]).forEach(it => addBundleItemRow(it.item_id, it.name_zh, it.quantity));
  } else {
    document.getElementById('bundleName').value = '';
    setBundleType('item');

    // 检查是否从订单页跳转过来（有待创建的套餐信息）
    const pending = state._pendingBundleCreate;
    if (pending) {
      document.getElementById('bundleName').value = pending.name;
      if (pending.weapon_item_id) {
        addBundleItemRow(pending.weapon_item_id, pending.weapon_name_zh || '', 1);
      }
      // 加载并展示 Modification 类型的物品作为配件推荐
      loadModificationSuggestions();
    }
  }

  // 初始化物品浏览器
  _bib.search = ''; _bib.group = ''; _bib.subtype = ''; _bib.rarity = '';
  await _bibLoadItems();
  _bibRenderFilterBar();
  _bibRenderGrid();
  _bibUpdateEmpty();

  openModal('bundleEditorModal');
}

/** 加载 Modification 类型物品，在套餐编辑器中展示为快速添加区 */
async function loadModificationSuggestions() {
  const items = await api('/api/items?type=Modification');
  if (!items || !items.length) return;
  // 过滤掉蓝图
  const mods = items.filter(i => !i.item_id.includes('blueprint'));
  if (!mods.length) return;

  const container = document.createElement('div');
  container.id = 'modSuggestions';
  container.style = 'margin-top:12px;padding-top:12px;border-top:1px solid var(--border)';
  container.innerHTML = `
    <div style="font-size:11px;color:var(--text3);margin-bottom:8px;font-weight:600">配件快速添加 <span style="font-weight:400">（点击添加到套餐）</span></div>
    <div style="display:flex;flex-wrap:wrap;gap:4px;max-height:200px;overflow-y:auto">
      ${mods.map(m => `
        <span class="item-tag" style="cursor:pointer;transition:all .12s"
          onclick="addBundleItemRow('${m.item_id}','${(m.name_zh||m.item_id).replace(/'/g,"\\'")}',1);this.style.opacity='.3';this.style.pointerEvents='none'"
          title="${m.item_id}">
          <img src="/api/items/${m.item_id}/image" style="width:18px;height:18px;object-fit:contain" onerror="this.style.opacity=.2">
          ${m.name_zh||m.item_id}
        </span>
      `).join('')}
    </div>`;

  // 插入到"+ 添加物品"按钮之后
  const addBtn = document.querySelector('#bundleEditorModal .btn.small[onclick="addBundleItemRow()"]');
  if (addBtn) {
    addBtn.parentNode.insertBefore(container, addBtn.nextSibling);
  }
}

// ── 套餐物品浏览器（照搬库存页筛选模式） ──

const _bib = {
  allItems: [],    // 全量物品缓存
  search:   '',
  group:    '',    // 武器/装备/材料/消耗品/其他
  subtype:  '',
  rarity:   '',
  loaded:   false,
};

/** 库存页的分组 & 稀有度常量（复用） */
const _BIB_TYPE_GROUPS = [
  { label:'武器',   types:['Assault Rifle','Battle Rifle','SMG','LMG','Shotgun','Sniper Rifle','Pistol','Hand Cannon'] },
  { label:'装备',   types:['Shield','Augment','Modification'] },
  { label:'材料',   types:['Basic Material','Material','Refined Material','Topside Material','Nature','Recyclable'] },
  { label:'消耗品', types:['Ammunition','Quick Use'] },
  { label:'其他',   types:['Key','Blueprint','Trinket','Special','Outfit','Cosmetic','BackpackCharm','Misc'] },
];
const _BIB_RARITIES = [
  { value:'Legendary', label:'传说', color:'#b45309' },
  { value:'Epic',      label:'史诗', color:'#7c3aed' },
  { value:'Rare',      label:'稀有', color:'#1d4ed8' },
  { value:'Uncommon',  label:'优秀', color:'#15803d' },
  { value:'Common',    label:'普通', color:'var(--text3)' },
];
const _BIB_TYPE_LABELS = {
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

function _bibMatchesGroup(item, groupLabel) {
  const grp = _BIB_TYPE_GROUPS.find(g => g.label === groupLabel);
  if (!grp) return false;
  if (groupLabel === '武器' && item.is_weapon) return true;
  if (groupLabel !== '武器' && item.is_weapon) return false;
  return grp.types.includes(item.type);
}

async function _bibLoadItems() {
  if (_bib.loaded && _bib.allItems.length) return;
  _bib.allItems = await api('/api/items') || [];
  _bib.loaded = true;
}

function _bibFilter() {
  let list = _bib.allItems;
  if (_bib.search) {
    const q = _bib.search.toLowerCase();
    list = list.filter(it =>
      (it.name_zh || '').toLowerCase().includes(q) ||
      (it.name_en || '').toLowerCase().includes(q) ||
      it.item_id.includes(q)
    );
  }
  if (_bib.subtype) {
    list = list.filter(it => it.type === _bib.subtype);
  } else if (_bib.group) {
    list = list.filter(it => _bibMatchesGroup(it, _bib.group));
  }
  if (_bib.rarity) {
    list = list.filter(it => it.rarity === _bib.rarity);
  }
  return list;
}

function _bibRenderFilterBar() {
  const bar = document.getElementById('bundleItemFilterBar');
  if (!bar) return;

  const groupBtns = _BIB_TYPE_GROUPS.map(g =>
    `<button class="tag-btn${_bib.group === g.label ? ' active' : ''}"
      onclick="bibSetGroup('${g.label}')" style="font-size:11px;padding:2px 8px">${g.label}</button>`
  ).join('');

  const rarityBtns = _BIB_RARITIES.map(r =>
    `<button class="tag-btn${_bib.rarity === r.value ? ' active' : ''}"
      onclick="bibSetRarity('${r.value}')"
      style="font-size:11px;padding:2px 8px;${_bib.rarity === r.value ? '' : 'color:'+r.color}">${r.label}</button>`
  ).join('');

  let subtypeHtml = '';
  if (_bib.group) {
    const grp = _BIB_TYPE_GROUPS.find(g => g.label === _bib.group);
    if (grp && grp.types.length > 1) {
      subtypeHtml = `
        <div style="display:flex;flex-wrap:wrap;gap:3px;margin-top:6px;padding-top:6px;border-top:1px solid var(--border)">
          <button class="tag-btn${!_bib.subtype ? ' active' : ''}"
            onclick="bibSetSubtype('')" style="font-size:11px;padding:2px 8px">全部</button>
          ${grp.types.map(t =>
            `<button class="tag-btn${_bib.subtype === t ? ' active' : ''}"
              onclick="bibSetSubtype('${t}')" style="font-size:11px;padding:2px 8px">${_BIB_TYPE_LABELS[t] || t}</button>`
          ).join('')}
        </div>`;
    }
  }

  bar.innerHTML = `
    <div style="display:flex;gap:4px;align-items:center;flex-wrap:wrap">
      <div class="search-wrap" style="width:150px">
        <span class="search-icon">⌕</span>
        <input type="text" placeholder="搜索..." value="${('' + (_bib.search || '')).replace(/"/g, '&quot;')}"
          oninput="bibSetSearch(this.value)" style="font-size:12px">
      </div>
      <span style="width:1px;height:14px;background:var(--border2)"></span>
      <button class="tag-btn${!_bib.group ? ' active' : ''}" onclick="bibSetGroup('')" style="font-size:11px;padding:2px 8px">全部</button>
      ${groupBtns}
      <span style="width:1px;height:14px;background:var(--border2)"></span>
      ${rarityBtns}
    </div>
    ${subtypeHtml}
  `;
}

function _bibRenderGrid() {
  const grid = document.getElementById('bundleItemGrid');
  if (!grid) return;

  const items = _bibFilter();
  if (!items.length) {
    grid.innerHTML = '<div style="padding:30px;text-align:center;color:var(--text3);font-size:12px">无匹配物品</div>';
    return;
  }

  const selectedIds = new Set();
  document.querySelectorAll('#bundleItemsEditor .bundle-chip').forEach(el => {
    if (el.dataset.itemId) selectedIds.add(el.dataset.itemId);
  });

  grid.innerHTML = `
    <div class="inv-tile-grid" style="grid-template-columns:repeat(auto-fill,minmax(54px,1fr));grid-auto-rows:54px;gap:4px;padding:6px">
      ${items.map(it => {
        const sel = selectedIds.has(it.item_id);
        const nameZh = (it.name_zh||it.item_id).replace(/'/g,"\\'");
        return `<div class="inv-tile" style="cursor:pointer;${sel ? 'opacity:.35;' : ''}"
          onclick="bibAddItem('${it.item_id}','${nameZh}')"
          data-tip="${it.name_zh||it.item_id}&#10;${it.name_en||''}&#10;${_BIB_TYPE_LABELS[it.type]||it.type||''} · ${it.rarity||''}">
          <img src="/api/items/${it.item_id}/image" onerror="this.style.opacity=.2">
        </div>`;
      }).join('')}
    </div>`;
}

function bibSetSearch(val) { _bib.search = val; _bibRenderGrid(); }
function bibSetGroup(g) {
  _bib.group = _bib.group === g ? '' : g;
  _bib.subtype = '';
  _bibRenderFilterBar(); _bibRenderGrid();
}
function bibSetSubtype(t) {
  _bib.subtype = _bib.subtype === t ? '' : t;
  _bibRenderFilterBar(); _bibRenderGrid();
}
function bibSetRarity(r) {
  _bib.rarity = _bib.rarity === r ? '' : r;
  _bibRenderFilterBar(); _bibRenderGrid();
}

/** 从网格点击添加物品到已选列表 */
function bibAddItem(item_id, name_zh) {
  const existing = document.querySelector(`#bundleItemsEditor .bundle-chip[data-item-id="${item_id}"]`);
  if (existing) {
    const qtyEl = existing.querySelector('.bundle-qty');
    if (qtyEl) qtyEl.value = parseInt(qtyEl.value || 1) + 1;
    existing.style.outline = '2px solid var(--accent)';
    setTimeout(() => { existing.style.outline = ''; }, 400);
    return;
  }
  _addBundleChip(item_id, name_zh, 1);
  _bibUpdateEmpty();
  _bibRenderGrid();
}

function _bibUpdateEmpty() {
  const editor = document.getElementById('bundleItemsEditor');
  const empty  = document.getElementById('bundleItemsEmpty');
  if (!editor || !empty) return;
  empty.style.display = editor.children.length ? 'none' : '';
}

/** 添加已选物品 chip */
function _addBundleChip(item_id, name_zh, qty) {
  const editor = document.getElementById('bundleItemsEditor');
  const div = document.createElement('div');
  div.className = 'bundle-chip';
  div.dataset.itemId = item_id;
  div.innerHTML = `
    <img src="/api/items/${item_id}/image" style="width:24px;height:24px;object-fit:contain;flex-shrink:0;border-radius:4px" onerror="this.style.opacity=.2">
    <span style="font-size:12px;color:var(--text1);white-space:nowrap">${name_zh}</span>
    <input type="hidden" data-item-id="${item_id}">
    <span style="font-size:11px;color:var(--text3)">×</span>
    <input type="number" value="${qty}" min="1" style="width:38px;text-align:center;font-size:12px;padding:2px 4px" class="bundle-qty">
    <span onclick="this.closest('.bundle-chip').remove();_bibUpdateEmpty();_bibRenderGrid()" style="cursor:pointer;color:var(--danger);font-size:11px;flex-shrink:0;padding:0 2px">✕</span>`;
  editor.appendChild(div);
}

/** 兼容旧调用 — 从订单页/配件推荐等仍可通过此函数添加物品 */
function addBundleItemRow(item_id='', name_zh='', qty=1) {
  if (item_id) {
    _addBundleChip(item_id, name_zh, qty);
  }
  // 空调用忽略（不再需要空行）
}

async function saveBundle() {
  const name = document.getElementById('bundleName').value.trim();
  if (!name) return toast('套餐名不能为空', 'error');
  const bundleType = state.bundle.editingType || 'item';
  const priceVal = document.getElementById('bundlePrice').value;
  const price = priceVal !== '' ? parseFloat(priceVal) : null;
  const description = document.getElementById('bundleDescription').value.trim();

  const rows  = document.querySelectorAll('#bundleItemsEditor .bundle-chip');
  const rawItems = [];
  for (const row of rows) {
    const hidden = row.querySelector('input[data-item-id]');
    const qty    = parseInt(row.querySelector('.bundle-qty')?.value) || 1;
    const iid    = hidden?.dataset?.itemId || row.dataset?.itemId;
    if (iid) rawItems.push({ item_id: iid, quantity: qty });
  }
  // 去重：相同 item_id 合并数量
  const merged = {};
  for (const it of rawItems) {
    if (merged[it.item_id]) {
      merged[it.item_id].quantity += it.quantity;
    } else {
      merged[it.item_id] = { ...it };
    }
  }
  const items = Object.values(merged);
  if (bundleType === 'item' && !items.length) return toast('物品套餐请添加至少一个物品', 'error');
  if (bundleType !== 'item' && price == null) return toast('请设置套餐售价', 'error');
  const id  = state.bundle.editingId;
  const payload = {name, items, type: bundleType, price, description};
  const res = id
    ? await api(`/api/bundles/${id}`, { method:'PUT', body: JSON.stringify(payload) })
    : await api('/api/bundles', { method:'POST', body: JSON.stringify(payload) });
  if (res.error) return toast(res.error, 'error');

  // 如果有待添加的别名（从订单页跳过来的）
  const pending = state._pendingBundleCreate;
  if (pending && pending.alias && !id && res.id) {
    await api(`/api/bundles/${res.id}/aliases`, {
      method:'POST', body: JSON.stringify({ alias: pending.alias })
    });
    toast(`套餐已创建，别名「${pending.alias}」已自动添加`, 'success');
  } else {
    toast(id ? '套餐已更新' : '套餐已创建', 'success');
  }

  state._pendingBundleCreate = null;
  closeModal('bundleEditorModal');
  loadBundles();

  // 检查队列：是否还有更多待创建的套餐
  const queue = state._pendingBundleQueue;
  if (queue && queue.length > 0) {
    // 移除刚完成的（第一个）
    queue.shift();
    if (queue.length > 0) {
      // 还有下一个，自动弹出
      state._pendingBundleCreate = queue[0];
      setTimeout(() => {
        openBundleEditor();
        toast(`还有 ${queue.length} 个套餐待创建`, 'success');
      }, 500);
    } else {
      // 全部完成
      state._pendingBundleQueue = null;
      toast('所有套餐已创建完毕！可以回到订单页用 🔄 重新匹配了', 'success');
    }
  }
}

async function deleteBundle(id) {
  if (!confirm('确认删除此套餐？')) return;
  await api(`/api/bundles/${id}`, { method:'DELETE' });
  toast('已删除');
  loadBundles();
}

async function addBundleAliasInline(bundleId) {
  const alias = prompt('输入套餐别名：');
  if (!alias?.trim()) return;
  const res = await api(`/api/bundles/${bundleId}/aliases`, {
    method:'POST', body: JSON.stringify({ alias: alias.trim() })
  });
  if (res.error) return toast(res.error, 'error');
  toast('别名已添加', 'success');
  loadBundles();
}

async function deleteBundleAlias(aliasId, bundleId) {
  await api(`/api/bundle-aliases/${aliasId}`, { method:'DELETE' });
  toast('已删除');
  loadBundles();
}