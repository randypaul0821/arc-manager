'use strict';

// ══════════════════════════════════════════════════════════════
//  bundle_monitor.js — 重点关注页（物品关注 + 套餐关注）
// ══════════════════════════════════════════════════════════════

// INV_TYPE_LABELS, INV_TYPE_GROUPS, INV_RARITIES, INV_RARITY_ORDER, INV_PALETTE
// 已移至 common.js 统一定义

const bm = {
  accounts:[], bundles:[], inventory:[], gameItems:[],
  rules: {},
  gathered: new Set(),
  stockAccounts:[], selectedAccounts: new Set(),
  multiSelect: localStorage.getItem('bm_multi_select') === '1',
  s: { rightTab:'items', typeGroup:null, subType:null, rarity:'', showOnly:'all', search:'', bundleTag:null, accId:null },
};

async function loadBundleMonitor() {
  const [accounts, bundles, inventory, gameItems] = await Promise.all([
    api('/api/accounts').catch(() => []), api('/api/bundles').catch(() => []),
    api('/api/inventory').catch(() => []), api('/api/items').catch(() => []),
  ]);
  bm.accounts = (accounts||[]).filter(a => a.active);
  bm.bundles = bundles||[]; bm.inventory = inventory||[]; bm.gameItems = gameItems||[];
  bm.rules = {}; bm.gathered = new Set(); // Set<"accId_itemId">
  ensureColorIndex(bm.accounts);
  await Promise.all(bm.accounts.map(async a => {
    bm.rules[a.id] = await api('/api/watch/rules/' + a.id).catch(() => []) || [];
  }));
  if (!bm.s.accId && bm.accounts.length) bm.s.accId = bm.accounts[0].id;
  // 默认选中第一个有规则的账号
  if (!bm.selectedAccounts.size) {
    const first = bm.accounts.find(a => (bm.rules[a.id]||[]).length > 0);
    if (first) bm.selectedAccounts.add(first.id);
  }
  _bmRenderOverview();
  _bmLoadShortage();
}

function _bmEsc(s) { return String(s??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function _bmGetAccQty(itemId, accId) {
  const item = bm.inventory.find(i => i.item_id === itemId);
  return item ? ((item.accounts||[]).find(a => a.account_id === accId)||{}).quantity || 0 : 0;
}

// ═══ 概览（物品+套餐）═══

function _bmRenderOverview() {
  const el = document.getElementById('bmOverviewBody');
  if (!el) return;
  const rows = [];
  for (const acc of bm.accounts) {
    const rules = bm.rules[acc.id] || [];
    const itemRules = rules.filter(r => r.rule_type === 'item' && r.threshold > 0);
    const bundleRules = rules.filter(r => r.rule_type === 'bundle');
    if (!itemRules.length && !bundleRules.length) continue;

    const infos = [];
    const isSelected = bm.selectedAccounts.has(acc.id);
    for (const r of itemRules) {
      const qty = _bmGetAccQty(r.target_id, acc.id);
      const gathered = isSelected && bm.gathered.has(acc.id+'_'+r.target_id);
      const meta = bm.gameItems.find(g => g.item_id === r.target_id) || bm.inventory.find(i => i.item_id === r.target_id) || {};
      infos.push({ name: meta.name_zh||r.target_id, ok: gathered || qty >= r.threshold, shortage: Math.max(0, r.threshold-qty), type:'item', gathered });
    }
    for (const r of bundleRules) {
      const bid = Number(r.target_id), thr = r.threshold||1;
      const bundle = bm.bundles.find(b => b.id === bid);
      if (!bundle) continue;
      let sc = 0;
      for (const bi of (bundle.items||[])) {
        const gathered = isSelected && bm.gathered.has(acc.id+'_'+bi.item_id);
        if (!gathered && _bmGetAccQty(bi.item_id, acc.id) < bi.quantity*thr) sc++;
      }
      infos.push({ name: bundle.name, ok: sc===0, shortCount: sc, thr, type:'bundle' });
    }
    rows.push({ acc, infos, okCount: infos.filter(i=>i.ok).length, shortCount: infos.filter(i=>!i.ok).length });
  }
  if (!rows.length) { el.innerHTML = '<tr><td colspan="5" class="empty">暂无重点关注 — 点击右上角「⚙ 关注设置」添加</td></tr>'; _bmUpdateCheckAll(); return; }

  el.innerHTML = rows.map(({acc, infos, okCount, shortCount}) => {
    const tags = infos.map(i => {
      const bg = i.ok ? 'rgba(52,211,153,.12)' : 'rgba(240,68,68,.12)';
      const bd = i.ok ? 'rgba(52,211,153,.3)' : 'rgba(240,68,68,.3)';
      const tc = i.ok ? 'var(--success)' : 'var(--danger)';
      const icon = i.type==='bundle' ? '📦 ' : '';
      let suf;
      if (i.type==='bundle') {
        suf = ` ×${i.thr} ${i.ok?'✓':'⚠缺'+i.shortCount+'种'}`;
      } else {
        suf = i.gathered ? ' ✓已集齐' : (i.ok ? ' ✓' : ' ⚠缺'+i.shortage);
      }
      return `<span style="display:inline-flex;align-items:center;gap:3px;padding:2px 8px;border-radius:4px;font-size:11px;margin:2px;background:${bg};color:${tc};border:1px solid ${bd}">${icon}${_bmEsc(i.name)}${suf}</span>`;
    }).join('');
    const chk = bm.selectedAccounts.has(acc.id);
    return `<tr style="${chk?'':'opacity:.5'}">
      <td><input type="checkbox" ${chk?'checked':''} onchange="_bmToggleOverviewAcc(${acc.id},this.checked)" style="cursor:pointer;width:16px;height:16px"></td>
      <td style="font-weight:600;color:var(--text1);cursor:pointer" onclick="this.parentElement.querySelector('input[type=checkbox]').click()">${_bmEsc(acc.name)}</td>
      <td style="cursor:pointer" onclick="this.parentElement.querySelector('input[type=checkbox]').click()"><div style="display:flex;flex-wrap:wrap">${tags}</div></td>
      <td class="col-num" style="color:var(--success)">${okCount}</td>
      <td class="col-num" style="color:${shortCount>0?'var(--danger)':'var(--text3)'};font-weight:${shortCount>0?700:400}">${shortCount||'—'}</td>
    </tr>`;
  }).join('');
  _bmUpdateCheckAll();
}

// ═══ 概览 checkbox 控制 ═══

function _bmToggleOverviewAcc(id, checked) {
  if (bm.multiSelect) {
    // 多选模式：正常 toggle
    if (checked) bm.selectedAccounts.add(id); else bm.selectedAccounts.delete(id);
  } else {
    // 单选模式：只选当前，取消其他
    bm.selectedAccounts.clear();
    bm.selectedAccounts.add(id);
  }

  _bmRenderOverview();
  _bmLoadShortage();
}
function _bmToggleOverviewAll(checked) {
  // 全选不受多选开关影响
  const accIds = bm.accounts.filter(a => (bm.rules[a.id]||[]).length > 0).map(a => a.id);
  bm.selectedAccounts.clear();
  if (checked) accIds.forEach(id => bm.selectedAccounts.add(id));

  _bmRenderOverview();
  _bmLoadShortage();
}
function _bmToggleMultiSelect(checked) {
  bm.multiSelect = checked;
  localStorage.setItem('bm_multi_select', checked ? '1' : '0');
  // 切到单选模式时，只保留第一个选中的
  if (!checked && bm.selectedAccounts.size > 1) {
    const first = [...bm.selectedAccounts][0];
    bm.selectedAccounts.clear();
    bm.selectedAccounts.add(first);
    _bmRenderOverview();
    _bmLoadShortage();
    }
}
function _bmUpdateCheckAll() {
  const el = document.getElementById('bmOverviewCheckAll');
  if (!el) return;
  const accIds = bm.accounts.filter(a => (bm.rules[a.id]||[]).length > 0).map(a => a.id);
  el.checked = accIds.length > 0 && accIds.every(id => bm.selectedAccounts.has(id));
  el.indeterminate = !el.checked && accIds.some(id => bm.selectedAccounts.has(id));
  // 同步多选开关状态
  const ms = document.getElementById('bmMultiSelect');
  if (ms) ms.checked = bm.multiSelect;
}

// ═══ 补货清单 + 存货分布 ═══

let _bmShortageData=[];


function _bmLoadShortage() {
  if (!bm.stockAccounts.length) {
    const accMap = {};
    for (const item of bm.inventory) for (const a of (item.accounts||[])) if (!accMap[a.account_id]) accMap[a.account_id] = {account_id:a.account_id, account_name:a.account_name};
    for (const acc of bm.accounts) { const rs=bm.rules[acc.id]||[]; if (rs.length && !accMap[acc.id]) accMap[acc.id]={account_id:acc.id,account_name:acc.name}; }
    bm.stockAccounts = Object.values(accMap).sort((a,b) => a.account_name.localeCompare(b.account_name));
    if (!bm.selectedAccounts.size) {
      const first = bm.accounts.find(a => (bm.rules[a.id]||[]).length > 0);
      if (first) bm.selectedAccounts.add(first.id);
      else if (bm.stockAccounts.length) bm.selectedAccounts.add(bm.stockAccounts[0].account_id);
    }
  }

  const invMap={}, nameMap={};
  for (const it of bm.inventory) invMap[it.item_id]=it;
  for (const it of bm.gameItems) nameMap[it.item_id]=it;
  for (const it of bm.inventory) nameMap[it.item_id]=it;

  // 按账号生成独立行（不合并）
  _bmShortageData = [];
  const selAccs = bm.accounts.filter(a => bm.selectedAccounts.has(a.id));

  // 先收集所有选中账号对每个物品的关注，用于标注"也关注"
  const itemWatchMap = {}; // {item_id: [{acc_id, acc_name}]}
  for (const acc of selAccs) {
    const rules = bm.rules[acc.id]||[];
    const itemIds = new Set();
    for (const r of rules) {
      if (r.rule_type==='item' && r.threshold>0) itemIds.add(r.target_id);
      if (r.rule_type==='bundle') {
        const bundle = bm.bundles.find(b => b.id === Number(r.target_id));
        if (bundle) for (const bi of (bundle.items||[])) itemIds.add(bi.item_id);
      }
    }
    for (const id of itemIds) {
      if (!itemWatchMap[id]) itemWatchMap[id] = [];
      itemWatchMap[id].push({acc_id:acc.id, acc_name:acc.name});
    }
  }

  // 按物品汇总所有选中账号的需求
  const itemMap = {}; // { item_id: { ..., accounts: [{acc_id, acc_name, needed, stock, shortage}] } }
  for (const acc of selAccs) {
    const rules = bm.rules[acc.id]||[];
    const demand = {};
    const add = (id,qty,src) => { if(!demand[id]) demand[id]={needed:0,sources:[]}; demand[id].needed+=qty; demand[id].sources.push(src); };
    for (const r of rules) {
      if (r.rule_type==='bundle') {
        const bid=Number(r.target_id), thr=r.threshold||1, bundle=bm.bundles.find(b=>b.id===bid);
        if (!bundle) continue;
        for (const bi of (bundle.items||[])) add(bi.item_id, bi.quantity*thr, `📦${bundle.name} ×${thr}`);
      }
      if (r.rule_type==='item' && r.threshold>0) add(r.target_id, r.threshold, `★关注 ≥${r.threshold}`);
    }
    for (const [id,d] of Object.entries(demand)) {
      const meta = nameMap[id]||{};
      const stock = _bmGetAccQty(id, acc.id);
      const shortage = Math.max(0, d.needed - stock);
      if (!itemMap[id]) {
        itemMap[id] = { item_id:id, name_zh:meta.name_zh||id, name_en:meta.name_en||'', sources:[], accounts:[] };
      }
      itemMap[id].accounts.push({ acc_id:acc.id, acc_name:acc.name, needed:d.needed, stock, shortage });
      for (const s of d.sources) { if (!itemMap[id].sources.includes(s)) itemMap[id].sources.push(s); }
    }
  }
  // 补充未被关注但有库存的账号列数据
  for (const [id, item] of Object.entries(itemMap)) {
    const inv2 = invMap[id];
    if (!inv2) continue;
    for (const acc of selAccs) {
      if (item.accounts.some(a => a.acc_id === acc.id)) continue;
      const stock = _bmGetAccQty(id, acc.id);
      item.accounts.push({ acc_id:acc.id, acc_name:acc.name, needed:0, stock, shortage:0 });
    }
  }
  _bmShortageData = Object.values(itemMap);
  _bmRenderShortage();
}

// 获取账号的 INV_PALETTE 颜色（与库存页一致）
function _bmAccColor(accId) {
  const ci = (inv.colorIdx && inv.colorIdx[accId] !== undefined) ? inv.colorIdx[accId] : 0;
  return INV_PALETTE[ci % INV_PALETTE.length];
}

// 获取当前选中账号的有序列表（用于动态表头）
function _bmSelectedAccList() {
  return bm.accounts.filter(a => bm.selectedAccounts.has(a.id));
}

function _bmRenderShortage() {
  // 固定表头（和订单页物品需求表一致）
  document.getElementById('bmShortageHead').innerHTML = `<tr>
    <th style="width:40px"></th>
    <th style="width:160px">物品</th>
    <th style="width:50px" class="col-num">需求</th>
    <th>各账号库存 / 可合成</th>
    <th style="width:60px" class="col-num">状态</th>
    <th style="width:60px"></th>
  </tr>`;

  // 过滤：只展示有任一账号缺口的或已集齐的
  let show = _bmShortageData.filter(item =>
    item.accounts.some(a => a.shortage > 0) || item.accounts.some(a => bm.gathered.has(a.acc_id+'_'+item.item_id))
  );
  // 排序：未全部集齐在前，再按总缺口降序
  show.sort((a,b) => {
    const aDone = a.accounts.every(ac => ac.shortage === 0 || bm.gathered.has(ac.acc_id+'_'+a.item_id));
    const bDone = b.accounts.every(ac => ac.shortage === 0 || bm.gathered.has(ac.acc_id+'_'+b.item_id));
    if (aDone !== bDone) return aDone ? 1 : -1;
    const aShort = a.accounts.reduce((s,ac) => s + ac.shortage, 0);
    const bShort = b.accounts.reduce((s,ac) => s + ac.shortage, 0);
    return bShort - aShort;
  });

  document.getElementById('bmShortageBody').innerHTML = show.length
    ? show.map(item => {
      const allDone = item.accounts.every(a => a.shortage === 0 || bm.gathered.has(a.acc_id+'_'+item.item_id));
      const totalNeeded = Math.max(...item.accounts.map(a => a.needed));
      const totalShortage = item.accounts.reduce((s,a) => s + (bm.gathered.has(a.acc_id+'_'+item.item_id) ? 0 : a.shortage), 0);

      // 各账号库存标签（和订单页一致的 inline tag 样式，但不可点击）
      const accHtml = item.accounts.filter(a => a.stock > 0 || a.needed > 0).map(a => {
        const c = _bmAccColor(a.acc_id);
        return `<span style="display:inline-flex;align-items:center;gap:3px;margin:1px 2px;padding:2px 8px;border-radius:4px;font-size:12px;background:var(--bg3);border:1.5px solid ${c.border}">
          <span style="color:${c.text};font-weight:500">${_bmEsc(a.acc_name)}</span>
          <span style="font-weight:700;color:var(--text1)">×${a.stock}</span>
        </span>`;
      }).join('');

      // 状态
      let statusHtml;
      if (allDone) statusHtml = '<span style="color:var(--success);font-weight:600">✓ 齐</span>';
      else statusHtml = `<span style="color:var(--danger);font-weight:600">缺 ${totalShortage}</span>`;

      return `<tr style="${allDone?'opacity:.45':''}">
        <td><img class="item-img" src="/api/items/${item.item_id}/image" onerror="this.style.opacity=.2" style="${allDone?'filter:grayscale(1)':''}"></td>
        <td>
          <div style="font-size:13px;font-weight:500;${allDone?'text-decoration:line-through;color:var(--text3)':''}">${_bmEsc(item.name_zh)}</div>
          <div style="font-size:11px;color:var(--text3);margin-top:1px">${_bmEsc(item.name_en)}</div>
        </td>
        <td class="col-num" style="font-weight:600">${totalNeeded}</td>
        <td>${accHtml || '<span style="font-size:12px;color:var(--text3)">无库存</span>'}</td>
        <td class="col-num">${statusHtml}</td>
        <td>${allDone?'':`<button class="btn small" onclick="_bmMarkGatheredAll('${item.item_id}')" style="border-color:var(--accent);color:var(--accent)">集齐</button>`}</td>
      </tr>`;}).join('')
    : '<tr><td colspan="6" class="empty">暂无缺货物品 ✓</td></tr>';
}

function _bmMarkGatheredAll(itemId) {
  for (const acc of _bmSelectedAccList()) {
    bm.gathered.add(acc.id+'_'+itemId);
  }
  _bmRenderShortage();
  _bmRenderOverview();
}

function _bmMarkGathered(accId, itemId) {
  bm.gathered.add(accId+'_'+itemId);
  _bmRenderShortage();
  _bmRenderOverview();
}


function _bmExportShortage() {
  // 从新数据结构中按账号分组导出
  const groups = {};
  for (const item of _bmShortageData) {
    for (const a of item.accounts) {
      if (a.shortage <= 0 || bm.gathered.has(a.acc_id+'_'+item.item_id)) continue;
      if (!groups[a.acc_id]) groups[a.acc_id] = { name: a.acc_name, items: [] };
      groups[a.acc_id].items.push({ name_zh: item.name_zh, shortage: a.shortage, needed: a.needed });
    }
  }
  if (!Object.keys(groups).length) { toast('当前没有缺货物品','success'); return; }
  let text = '';
  for (const g of Object.values(groups)) {
    text += `【${g.name}】补货清单\n`;
    text += '----------------\n';
    for (const i of g.items) {
      const needPart = i.shortage < i.needed ? `/需${i.needed}` : '';
      text += `${i.name_zh} 缺${i.shortage}${needPart}\n`;
    }
    text += '\n';
  }
  text = text.trimEnd();

  const lines = text.trim().split('\n').length;
  document.getElementById('bmExportTitle').textContent='补货清单';
  document.getElementById('bmExportBody').innerHTML=`<div style="margin-bottom:10px"><textarea id="bmExportText" readonly style="width:100%;height:${Math.min(lines+1,25)*22+20}px;font-size:13px;line-height:1.8;background:var(--bg2);color:var(--text1);border:1px solid var(--border);border-radius:6px;padding:10px;font-family:inherit;resize:vertical">${text.trim()}</textarea></div>
    <div style="display:flex;gap:8px;justify-content:flex-end"><button class="btn" onclick="navigator.clipboard.writeText(document.getElementById('bmExportText').value).then(()=>toast('已复制','success'))">📋 复制</button><button class="btn" onclick="closeModal('bmExportModal')">关闭</button></div>`;
  openModal('bmExportModal');
}

// ═══ 视图切换 ═══

function _bmSwitchView(view, btn) {
  // 隐藏所有视图
  document.querySelectorAll('#page-bundle_monitor .bm-view').forEach(v => v.style.display = 'none');
  // 显示目标视图
  const target = document.getElementById('bm-view-' + view);
  if (target) target.style.display = 'flex';
  // 更新侧边栏子菜单 active 状态
  document.querySelectorAll('#bmSubNav .nav-sub-item').forEach(s => s.classList.remove('active'));
  if (btn) btn.classList.add('active');
  // 加载视图数据
  if (view === 'overview') { _bmRenderOverview(); _bmLoadShortage(); }
  if (view === 'restock') _bmLoadRestock();
  if (view === 'settings') _bmOpenSettings();
}

// ═══ 补货建议 ═══

let _bmRestockDays = 7;

function _bmSetRestockDays(days, btn) {
  _bmRestockDays = days;
  const bar = btn.parentElement;
  bar.querySelectorAll('.tag-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  _bmLoadRestock();
}

function _bmCopyRestock() {
  const el = document.getElementById('bmRestockText');
  if (el) navigator.clipboard.writeText(el.value).then(() => toast('已复制', 'success'));
}

async function _bmLoadRestock() {
  const el = document.getElementById('bmRestockContent');
  if (!el) return;
  el.innerHTML = '<div style="text-align:center;padding:40px;color:var(--text3)">分析中...</div>';

  const data = await api(`/api/restock-advice?days=14&restock_days=${_bmRestockDays}`);
  if (!data || !data.length) {
    el.innerHTML = '<div style="text-align:center;padding:40px;color:var(--text3)">当前库存充足，无需补货</div>';
    return;
  }

  const urgent = data.filter(i => i.level === 'urgent');
  const warning = data.filter(i => i.level === 'warning');
  let text = '';
  if (urgent.length) {
    text += '🔴 急补\n';
    for (const i of urgent) {
      text += `${i.name_zh} 日均${i.daily_avg} 库存${i.current_stock} 撑${i.days_left}天\n`;
      text += i.transfer ? `  补${i.restock_qty} ← ${i.transfer}\n` : `  补${i.restock_qty}\n`;
    }
    text += '\n';
  }
  if (warning.length) {
    text += '🟡 预补\n';
    for (const i of warning) {
      text += `${i.name_zh} 日均${i.daily_avg} 库存${i.current_stock} 撑${i.days_left}天\n`;
      text += i.transfer ? `  补${i.restock_qty} ← ${i.transfer}\n` : `  补${i.restock_qty}\n`;
    }
  }
  text = text.trimEnd();

  el.style.display = 'flex';
  el.style.flexDirection = 'column';
  el.innerHTML = `<textarea id="bmRestockText" readonly style="width:100%;flex:1;font-size:13px;line-height:1.8;background:var(--bg2);color:var(--text1);border:1px solid var(--border);border-radius:6px;padding:12px;font-family:inherit;resize:none">${text}</textarea>`;
}

// ═══ 关注设置（全页） ═══

async function _bmOpenSettings() {
  // 每次打开设置都重新拉取最新套餐和库存数据，保持与套餐库同步
  const [bundles, inventory] = await Promise.all([
    api('/api/bundles').catch(() => []), api('/api/inventory').catch(() => []),
  ]);
  bm.bundles = bundles || [];
  bm.inventory = inventory || [];
  _bmRenderSettingsShell();
}

function _bmRenderSettingsShell() {
  const el=document.getElementById('bmSettingsContent'); if(!el)return;
  if(!bm.accounts.length){el.innerHTML='<div class="empty">暂无账号</div>';return;}

  const rules=bm.rules[bm.s.accId]||[];
  const ic=rules.filter(r=>r.rule_type==='item').length;
  const bc=rules.filter(r=>r.rule_type==='bundle').length;

  el.innerHTML=`
    <div class="bm-acc-bar">
      <span style="font-size:11px;color:var(--text3);margin-right:2px">账号</span>
      ${bm.accounts.map(a=>{
        const sel=a.id===bm.s.accId, rs=bm.rules[a.id]||[];
        const cnt=rs.length;
        return `<button class="tag-btn${sel?' active':''}" onclick="_bmSettingsSetAcc(${a.id})">${_bmEsc(a.name)}${cnt?`<span class="acc-count">(${cnt})</span>`:''}</button>`;
      }).join('')}
    </div>
    <div class="bm-tab-bar">
      ${[['items',`★ 物品关注 (${ic})`],['bundles',`📦 套餐关注 (${bc})`]].map(([v,l])=>
        `<button class="bm-tab-btn${bm.s.rightTab===v?' active':''}" onclick="_bmSettingsSetTab('${v}')">${l}</button>`
      ).join('')}
    </div>
    <div id="bmSettingsInner" style="flex:1;overflow:hidden;display:flex;flex-direction:column">
      ${bm.s.rightTab==='items'?_bmBuildSettingsItems():_bmBuildSettingsBundles()}
    </div>`;
}

async function _bmSettingsSetAcc(id) {
  bm.s.accId=id;
  if(!bm.rules[id]) bm.rules[id]=await api('/api/watch/rules/'+id).catch(()=>[])||[];
  _bmRenderSettingsShell();
}
function _bmSettingsSetTab(tab) { bm.s.rightTab=tab; _bmRenderSettingsShell(); }
function _bmRefreshSettingsInner() {
  const el=document.getElementById('bmSettingsInner'); if(!el)return;
  el.innerHTML = bm.s.rightTab==='items' ? _bmBuildSettingsItems() : _bmBuildSettingsBundles();
}

// ─── 物品关注设置 ───

function _bmBuildSettingsItems() {
  const accId=bm.s.accId, rules=bm.rules[accId]||[];
  let items = bm.gameItems;
  if(bm.s.subType) items=items.filter(it=>it.type===bm.s.subType);
  else if(bm.s.typeGroup) items=items.filter(it=>itemMatchesGroup(it, bm.s.typeGroup));
  if(bm.s.rarity) items=items.filter(it=>it.rarity===bm.s.rarity);
  if(bm.s.search){const q=bm.s.search.toLowerCase();items=items.filter(it=>(it.name_zh||'').toLowerCase().includes(q)||(it.name_en||'').toLowerCase().includes(q)||(it.item_id||'').toLowerCase().includes(q));}
  if(bm.s.showOnly==='starred') items=items.filter(it=>rules.some(r=>r.rule_type==='item'&&r.target_id===it.item_id));
  if(bm.s.showOnly==='unstarred') items=items.filter(it=>!rules.some(r=>r.rule_type==='item'&&r.target_id===it.item_id));
  items=[...items].sort((a,b)=>{const ra=INV_RARITY_ORDER[a.rarity]??9,rb=INV_RARITY_ORDER[b.rarity]??9;return ra!==rb?ra-rb:(a.name_zh||'').localeCompare(b.name_zh||'','zh');});

  const curIds=items.map(it=>it.item_id);
  const allStar=curIds.length>0&&curIds.every(id=>rules.some(r=>r.rule_type==='item'&&r.target_id===id));
  const rarities=['Legendary','Epic','Rare','Uncommon','Common'];
  const rc={Legendary:'#b45309',Epic:'#7c3aed',Rare:'#1d4ed8',Uncommon:'#15803d',Common:'var(--text3)'};
  const rl={Legendary:'传说',Epic:'史诗',Rare:'稀有',Uncommon:'优秀',Common:'普通'};

  // 子类型标签按钮
  const group = bm.s.typeGroup ? INV_TYPE_GROUPS.find(g => g.label === bm.s.typeGroup) : null;
  let subtypeBtns = '';
  if (group && group.types.length > 1) {
    subtypeBtns = `<div style="display:flex;flex-wrap:wrap;gap:4px;padding:4px 20px 0;flex-shrink:0">
      <span style="font-size:11px;color:var(--text3);margin-right:2px;align-self:center">子类</span>
      <button class="tag-btn${!bm.s.subType?' active':''}" onclick="bm.s.subType=null;_bmRefreshSettingsInner()" style="font-size:11px;padding:3px 10px">全部</button>
      ${group.types.map(t=>`<button class="tag-btn${bm.s.subType===t?' active':''}" onclick="bm.s.subType='${t}';_bmRefreshSettingsInner()" style="font-size:11px;padding:3px 10px">${INV_TYPE_LABELS[t]||t}</button>`).join('')}
    </div>`;
  }

  return `<div class="bm-filter-bar">
    <div class="search-wrap" style="width:180px"><span class="search-icon">⌕</span>
      <input type="text" placeholder="搜索物品..." value="${_bmEsc(bm.s.search)}" oninput="bm.s.search=this.value;_bmRefreshSettingsInner()"></div>
    <span style="width:1px;height:16px;background:var(--border2)"></span>
    <span style="font-size:11px;color:var(--text3)">分类</span>
    <button class="tag-btn${!bm.s.typeGroup?' active':''}" onclick="bm.s.typeGroup=null;bm.s.subType=null;_bmRefreshSettingsInner()" style="font-size:11px;padding:3px 10px">全部</button>
    ${INV_TYPE_GROUPS.map(g=>`<button class="tag-btn${bm.s.typeGroup===g.label?' active':''}" onclick="bm.s.typeGroup=bm.s.typeGroup==='${g.label}'?null:'${g.label}';bm.s.subType=null;_bmRefreshSettingsInner()" style="font-size:11px;padding:3px 10px">${g.label}</button>`).join('')}
    <span style="width:1px;height:16px;background:var(--border2)"></span>
    <span style="font-size:11px;color:var(--text3)">稀有度</span>
    <button class="tag-btn${!bm.s.rarity?' active':''}" onclick="bm.s.rarity='';_bmRefreshSettingsInner()" style="font-size:11px;padding:3px 10px">全部</button>
    ${rarities.map(r=>`<button class="tag-btn${bm.s.rarity===r?' active':''}" onclick="bm.s.rarity=bm.s.rarity==='${r}'?'':'${r}';_bmRefreshSettingsInner()" style="font-size:11px;padding:3px 10px;${bm.s.rarity===r?'':'color:'+rc[r]}">${rl[r]}</button>`).join('')}
  </div>
  ${subtypeBtns}
  <div style="display:flex;align-items:center;gap:8px;padding:4px 20px;flex-shrink:0">
    ${[['all','全部'],['starred','已关注'],['unstarred','未关注']].map(([v,l])=>`<button class="tag-btn${bm.s.showOnly===v?' active':''}" onclick="bm.s.showOnly='${v}';_bmRefreshSettingsInner()" style="font-size:12px">${l}</button>`).join('')}
    <span style="margin-left:auto;display:flex;align-items:center;gap:8px">
      <button class="btn small${allStar?' danger':' success'}" onclick="_bmBatchToggleStar(${allStar?0:1})">${allStar?'取消全部':'全部关注'}</button>
      <span style="font-size:12px;color:var(--text3);white-space:nowrap">${items.length} 件</span>
    </span>
  </div>
  <div class="bm-content"><div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:6px">
    ${items.map(it=>{
      const rule=rules.find(r=>r.rule_type==='item'&&r.target_id===it.item_id);
      const starred=!!rule;
      const curQty=_bmGetAccQty(it.item_id,accId);
      return `<div class="bm-item-card${starred?' starred':''}">
        <div class="item-thumb"><img src="/api/items/${it.item_id}/image" onerror="this.style.opacity=.2"></div>
        <div class="item-body">
          <div class="item-name">${_bmEsc(it.name_zh||it.item_id)}</div>
          <div class="item-sub">${INV_TYPE_LABELS[it.type]||it.type||''} · ${it.rarity||''}${curQty?` · 库存 ${curQty}`:''}</div>
        </div>
        ${starred?`<input class="threshold-input" type="text" inputmode="numeric" value="${rule.threshold||''}" placeholder="—" title="预警数量" onblur="_bmUpdateThreshold(${rule.id},this.value,this)" onkeydown="if(event.key==='Enter')this.blur()">`:''}
        <span class="toggle-switch${starred?' on':''}" onclick="_bmToggleStar(event,'${it.item_id}')" title="${starred?'取消关注':'添加关注'}">
          <span class="toggle-knob"></span>
        </span>
      </div>`;}).join('')||'<div class="empty" style="grid-column:1/-1">暂无匹配物品</div>'}
  </div></div>`;
}

async function _bmToggleStar(event, itemId) {
  // 先播动画（跟账号页一样）
  const sw = event.currentTarget;
  sw.classList.toggle('on');

  const accId=bm.s.accId, rules=bm.rules[accId]||[];
  const rule=rules.find(r=>r.rule_type==='item'&&r.target_id===itemId);
  const contentEl=document.querySelector('#bmSettingsInner .bm-content');
  const scrollTop=contentEl?contentEl.scrollTop:0;
  if(rule){await api('/api/watch/rule/'+rule.id,{method:'DELETE'});bm.rules[accId]=rules.filter(r=>r.id!==rule.id);}
  else{const res=await api('/api/watch/rules/'+accId,{method:'POST',body:JSON.stringify({rule_type:'item',target_id:itemId,threshold:0})});if(res?.ok)bm.rules[accId]=await api('/api/watch/rules/'+accId).catch(()=>[])||[];}
  _bmRefreshSettingsInner();
  requestAnimationFrame(()=>{const el=document.querySelector('#bmSettingsInner .bm-content');if(el)el.scrollTop=scrollTop;});
}

async function _bmBatchToggleStar(star) {
  const accId=bm.s.accId, rules=bm.rules[accId]||[];
  const contentEl=document.querySelector('#bmSettingsInner .bm-content');
  const scrollTop=contentEl?contentEl.scrollTop:0;
  let items=bm.gameItems;
  if(bm.s.subType) items=items.filter(it=>it.type===bm.s.subType);
  else if(bm.s.typeGroup) items=items.filter(it=>itemMatchesGroup(it, bm.s.typeGroup));
  if(bm.s.rarity) items=items.filter(it=>it.rarity===bm.s.rarity);
  if(bm.s.search){const q=bm.s.search.toLowerCase();items=items.filter(it=>(it.name_zh||'').toLowerCase().includes(q)||(it.name_en||'').toLowerCase().includes(q)||(it.item_id||'').toLowerCase().includes(q));}
  if(bm.s.showOnly==='starred') items=items.filter(it=>rules.some(r=>r.rule_type==='item'&&r.target_id===it.item_id));
  if(bm.s.showOnly==='unstarred') items=items.filter(it=>!rules.some(r=>r.rule_type==='item'&&r.target_id===it.item_id));
  if(star){
    const nr=items.filter(it=>!rules.some(r=>r.rule_type==='item'&&r.target_id===it.item_id)).map(it=>({rule_type:'item',target_id:it.item_id,threshold:0}));
    if(nr.length){await api('/api/watch/rules/'+accId+'/batch',{method:'POST',body:JSON.stringify({rules:nr})});toast('已关注 '+nr.length+' 个物品','success');}
  }else{
    const td=rules.filter(r=>r.rule_type==='item'&&items.some(it=>it.item_id===r.target_id));
    for(const r of td) await api('/api/watch/rule/'+r.id,{method:'DELETE'});
    toast('已取消 '+td.length+' 个关注','success');
  }
  bm.rules[accId]=await api('/api/watch/rules/'+accId).catch(()=>[])||[];
  _bmRefreshSettingsInner();
  requestAnimationFrame(()=>{const el=document.querySelector('#bmSettingsInner .bm-content');if(el)el.scrollTop=scrollTop;});
}

async function _bmUpdateThreshold(ruleId, val, inputEl) {
  const thr=parseInt(val,10)||0;
  await api('/api/watch/rule/'+ruleId,{method:'PUT',body:JSON.stringify({threshold:thr})});
  for(const rules of Object.values(bm.rules)){const r=rules.find(r=>r.id===ruleId);if(r){r.threshold=thr;break;}}
  // 视觉反馈：短暂显示绿色边框确认已保存
  if(inputEl){
    inputEl.classList.add('saved');
    setTimeout(()=>inputEl.classList.remove('saved'),1200);
  }
}

// ─── 套餐关注设置 ───

function _bmBuildSettingsBundles() {
  const accId=bm.s.accId, rules=bm.rules[accId]||[];
  const watchedIds=new Set(rules.filter(r=>r.rule_type==='bundle').map(r=>Number(r.target_id)));

  // 用 _bundleBaseName 做正确的基础名提取（跟套餐库一致）
  const baseNames=new Set();
  bm.bundles.forEach(b=>{if(b.source!=='manual')baseNames.add(_bundleBaseName(b.name));});
  const sorted=[...baseNames].sort();

  // 按来源分组：工作台 | 项目 | 远征（跟套餐库一致）
  const sourceOf=(baseName)=>{const b=bm.bundles.find(b=>_bundleBaseName(b.name)===baseName);return b?b.source:'';};
  const stations=sorted.filter(n=>sourceOf(n)==='hideout');
  const expeditions=sorted.filter(n=>sourceOf(n)==='projects'&&/远征|expedition|season/i.test(n));
  const projects=sorted.filter(n=>sourceOf(n)==='projects'&&!/远征|expedition|season/i.test(n));
  const others=sorted.filter(n=>!stations.includes(n)&&!expeditions.includes(n)&&!projects.includes(n));

  const hasManual=bm.bundles.some(b=>b.source==='manual');
  const tag=bm.s.bundleTag;
  let filtered=bm.bundles;
  if(tag==='__custom__') filtered=bm.bundles.filter(b=>b.source==='manual');
  else if(tag) filtered=bm.bundles.filter(b=>b.source!=='manual'&&_bundleBaseName(b.name)===tag);

  // 计算某个 baseName 下当前账号已关注的套餐数
  const watchedCountOf=(baseName)=>{
    if(baseName==='__custom__') return bm.bundles.filter(b=>b.source==='manual'&&watchedIds.has(b.id)).length;
    return bm.bundles.filter(b=>b.source!=='manual'&&_bundleBaseName(b.name)===baseName&&watchedIds.has(b.id)).length;
  };
  const tb=(id,label)=>{
    const cnt=watchedCountOf(id);
    const badge=cnt>0?` <span style="color:var(--accent);font-weight:700">${cnt}</span>`:'';
    return `<button class="tag-btn${tag===id?' active':''}" onclick="bm.s.bundleTag=bm.s.bundleTag==='${id.replace(/'/g,"\\'")}'?null:'${id.replace(/'/g,"\\'")}';_bmRefreshSettingsInner()" style="font-size:12px">${_bmEsc(label)}${badge}</button>`;
  };
  const sep='<span style="width:1px;height:16px;background:var(--border2);flex-shrink:0;margin:0 2px"></span>';
  const groupLabel=(text)=>`<span style="font-size:10px;color:var(--text3);font-weight:600;margin:0 2px;white-space:nowrap">${text}</span>`;

  // 按阶段排序（单阶段在前，组合在后）— 直接显示 DB 套餐
  const sortedFiltered=[...filtered].sort((a,b)=>_bundleSortKey(a.name)-_bundleSortKey(b.name));
  const isSeriesView = tag && tag!=='__custom__';

  const rows=sortedFiltered.map(b=>{
    const watched=watchedIds.has(b.id), bItems=b.items||[];
    const satisfied=bItems.every(bi=>_bmGetAccQty(bi.item_id,accId)>=bi.quantity);
    const rule=rules.find(r=>r.rule_type==='bundle'&&Number(r.target_id)===b.id);
    const isCombo = _isComboBundle(b.name);
    const displayName = isSeriesView ? (_bundlePhaseName(b.name)||b.name) : b.name;
    return `<div class="bm-bundle-card${watched?' watched':''}" style="${isCombo?'background:var(--bg2)':''}" id="bm-br-${b.id}">
      <div class="bundle-left">
        <span class="toggle-switch${watched?' on':''}" onclick="_bmToggleBundleWatch(event,${b.id})"><span class="toggle-knob"></span></span>
        <span class="bundle-name" style="color:${watched?'var(--text1)':'var(--text3)'}">${_bmEsc(displayName)}</span>
      </div>
      <div class="bundle-items">${bItems.map(bi=>{
        const meta=bm.gameItems.find(g=>g.item_id===bi.item_id)||bm.inventory.find(i=>i.item_id===bi.item_id)||{};
        const qty=_bmGetAccQty(bi.item_id,accId), ok=qty>=bi.quantity;
        return `<div class="inv-bundle-component ${ok?'ok':'bad'}"><img src="/api/items/${bi.item_id}/image" onerror="this.style.opacity=.2"><span class="comp-name">${_bmEsc(meta.name_zh||bi.item_id)}</span><span class="comp-qty">${qty}/${bi.quantity}</span></div>`;
      }).join('')||'<span style="font-size:11px;color:var(--text3)">暂无物品</span>'}</div>
      <div class="bundle-right">
        ${watched&&!satisfied?'<span class="inv-alert-badge red" style="font-size:11px;padding:1px 8px">缺货</span>':''}
        ${watched&&satisfied?'<span style="color:var(--success);font-size:11px">✓</span>':''}
        ${watched&&rule?`<input type="number" value="${rule.threshold||1}" min="1" max="99" title="需要套数" style="width:42px;font-size:11px;padding:2px 4px;text-align:center" onblur="_bmUpdateThreshold(${rule.id},this.value,this)" onkeydown="if(event.key==='Enter')this.blur()">`:''}
      </div>
    </div>`;
  }).join('');

  // 构建分组标签栏：自定义 | 工作台 | 项目 | 远征
  const tagParts = [];
  if(hasManual) tagParts.push(tb('__custom__','自定义'));
  if(stations.length){if(tagParts.length)tagParts.push(sep);tagParts.push(groupLabel('工作台'));tagParts.push(...stations.map(n=>tb(n,n)));}
  if(projects.length){if(tagParts.length)tagParts.push(sep);tagParts.push(groupLabel('项目'));tagParts.push(...projects.map(n=>tb(n,n)));}
  if(expeditions.length){if(tagParts.length)tagParts.push(sep);tagParts.push(groupLabel('远征'));tagParts.push(...expeditions.map(n=>tb(n,n)));}
  if(others.length){if(tagParts.length)tagParts.push(sep);tagParts.push(...others.map(n=>tb(n,n)));}

  return `<div class="bm-filter-bar">
    ${tagParts.join('')}
    ${tag?`<button class="tag-btn" onclick="bm.s.bundleTag=null;_bmRefreshSettingsInner()" style="font-size:12px;color:var(--text3)">✕</button>`:''}
    <span style="font-size:12px;color:var(--text3);margin-left:auto;white-space:nowrap">${filtered.length} 个套餐</span>
  </div>
  <div id="bm-bundle-list" class="bm-content">${rows||'<div class="empty">还没有套餐</div>'}</div>`;
}

async function _bmToggleBundleWatch(event, bundleId) {
  event.currentTarget.classList.toggle('on');
  const accId=bm.s.accId, rules=bm.rules[accId]||[];
  const rule=rules.find(r=>r.rule_type==='bundle'&&Number(r.target_id)===bundleId);
  const listEl=document.getElementById('bm-bundle-list'), scrollTop=listEl?listEl.scrollTop:0;
  if(rule){await api('/api/watch/rule/'+rule.id,{method:'DELETE'});bm.rules[accId]=rules.filter(r=>r.id!==rule.id);}
  else{await api('/api/watch/rules/'+accId,{method:'POST',body:JSON.stringify({rule_type:'bundle',target_id:String(bundleId),threshold:1})});bm.rules[accId]=await api('/api/watch/rules/'+accId).catch(()=>[])||[];}
  _bmRefreshSettingsInner();
  requestAnimationFrame(()=>{const el=document.getElementById('bm-bundle-list');if(el)el.scrollTop=scrollTop;});
}