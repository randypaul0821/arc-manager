'use strict';

// ═══════════════════════════════════════
//  全局状态
// ═══════════════════════════════════════
const state = {
  inventory: { all: [], accounts: [], activeTag: '__all__' },
  bundles:   { all: [], sources: [], activeTag: '' },
  items:     { all: [], filtered: [] },
  orders:    { all: [] },
  accounts:  { all: [] },
  customers: { all: [] },
  bundle: { editingId: null },
  account: { editingId: null },
  orderParsed: [],
};

// ═══════════════════════════════════════
//  工具函数
// ═══════════════════════════════════════
function fmtPrice(n) {
  if (!n) return '0';
  if (n >= 10000) return (n/10000).toFixed(1).replace(/\.0$/,'') + 'w';
  return n.toLocaleString();
}

function fmtTime(s) {
  if (!s) return '—';
  return s.replace('T',' ').slice(0,16);
}

function escHtml(s) {
  if (!s) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

function toast(msg, type='', duration=0) {
  // 移除旧的
  document.getElementById('__toast')?.remove();
  const el = document.createElement('div');
  el.id = '__toast';
  el.className = 'toast' + (type ? ' '+type : '');
  el.textContent = msg;
  document.body.appendChild(el);
  // duration=0 使用默认值：error/info 5秒，其他 2.8秒
  const ms = duration || (type === 'error' || type === 'info' ? 5000 : 2800);
  setTimeout(() => {
    el.style.transition = 'top .3s ease-in';
    el.style.top = '-60px';
    setTimeout(() => el.remove(), 400);
  }, ms);
}

function closeModal(id) { document.getElementById(id).style.display = 'none'; }
function openModal(id)  { document.getElementById(id).style.display = 'flex'; }

function api(url, opts={}) {
  return fetch(url, { headers: {'Content-Type':'application/json'}, ...opts })
    .then(r => {
      if (!r.ok) {
        return r.json().catch(() => ({})).then(d => {
          const msg = d.error || `请求失败 (${r.status})`;
          return { error: msg };
        });
      }
      return r.json().catch(() => ({}));
    })
    .catch(e => { toast('网络错误: ' + e.message, 'error'); return {error: e.message}; });
}

// ═══════════════════════════════════════
//  英文名词级对比高亮
// ═══════════════════════════════════════
/**
 * 对比订单原文和匹配到的英文名，返回带高亮HTML
 * 智能处理：Mk.3 = Mk. 3, Blueprint 前缀, 括号内容, 前缀匹配(Master≈Mastery)
 */
function highlightMatch(rawName, matchedEn) {
  if (!rawName || !matchedEn) return { raw: rawName || '', matched: matchedEn || '', ratio: matchedEn ? 0 : 1 };

  // 结构性噪声词：只有真正的分类前缀，不影响匹配判断的词
  const noise = new Set(['blueprint','modded','weapon','expedition','material','plan']);

  function extractWords(s) {
    return s.toLowerCase()
      .replace(/[\[\]【】（）()''""`~.,;:!?]/g, ' ')
      .split(/[\s_]+/)
      .filter(w => w.length > 0);
  }

  function wordsMatch(a, b) {
    if (a === b) return true;
    if (a.length >= 4 && b.startsWith(a)) return true;
    if (b.length >= 4 && a.startsWith(b)) return true;
    return false;
  }

  const rawWords   = extractWords(rawName);
  const matchWords = extractWords(matchedEn);

  function isWordMatched(word, targetWords) {
    const w = word.toLowerCase().replace(/[\[\]【】（）()''""`~.,;:!?]/g, '');
    if (!w) return true;
    return targetWords.some(tw => wordsMatch(w, tw));
  }

  // 高亮 matchedEn：噪声词灰色，匹配词绿色，不匹配词橙色
  const matchedHtml = matchedEn.split(/(\s+)/).map(part => {
    if (!part.trim()) return part;
    const w = part.trim().toLowerCase().replace(/[\[\]（）()''""`~.,;:!?]/g, '');
    if (noise.has(w)) return `<span style="color:var(--text3)">${part}</span>`;
    const matched = isWordMatched(part, rawWords);
    return matched
      ? `<span style="color:#5ec484">${part}</span>`
      : `<span style="color:#f0a050">${part}</span>`;
  }).join('');

  // 匹配率：只算内容词（排除噪声词）
  const contentMatchWords = matchWords.filter(w => !noise.has(w));
  const contentRawWords   = rawWords.filter(w => !noise.has(w));
  const matchedCount = contentMatchWords.filter(w => contentRawWords.some(rw => wordsMatch(w, rw))).length;
  const ratio = contentMatchWords.length > 0 ? matchedCount / contentMatchWords.length : 1;

  return { raw: rawName, matched: matchedHtml, ratio };
}

// ═══════════════════════════════════════
//  页面切换
// ═══════════════════════════════════════
function showPage(name) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  document.getElementById('page-' + name)?.classList.add('active');
  document.querySelector(`[data-page="${name}"]`)?.classList.add('active');
  // 子菜单展开：active 的 nav-item 后面的 .nav-sub 会通过 CSS 自动显示
  if (name === 'dashboard') loadDashboard();
  if (name === 'inventory') loadInventory();
  if (name === 'bundle_monitor') loadBundleMonitor();
  if (name === 'orders')    {
    if (!state.orders.activeTab) state.orders.activeTab = 'pending';
    loadOrders().then(() => loadShortage());
  }
  if (name === 'bundles')   loadBundles();
  if (name === 'items')      loadItems();
  if (name === 'customers') loadCustomers();
  if (name === 'accounts')  { loadAccounts(); loadAiSettings(); }
}

// ═══════════════════════════════════════
//  侧栏拖拽缩放
// ═══════════════════════════════════════
(function() {
  const MIN = 120, MAX = 320;
  const handle = document.getElementById('sidebarResize');
  const sb     = document.getElementById('sidebar');
  let dragging = false, startX = 0, startW = 0;

  handle.addEventListener('mousedown', e => {
    dragging = true;
    startX   = e.clientX;
    startW   = sb.offsetWidth;
    handle.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });

  document.addEventListener('mousemove', e => {
    if (!dragging) return;
    const w = Math.min(MAX, Math.max(MIN, startW + e.clientX - startX));
    sb.style.width = w + 'px';
  });

  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove('dragging');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  });
})();

// ═══════════════════════════════════════
//  全局即时 tooltip（data-tip 属性）
// ═══════════════════════════════════════
(function() {
  const tip = document.createElement('div');
  tip.id = 'globalTip';
  document.body.appendChild(tip);

  let _tipEl = null;

  document.addEventListener('mouseover', e => {
    _tipEl = e.target.closest('[data-tip]');
    if (!_tipEl) { tip.style.display = 'none'; return; }
    tip.textContent = _tipEl.dataset.tip;
    tip.style.display = 'block';
    _positionTip(e.clientX, e.clientY);
  });

  document.addEventListener('mousemove', e => {
    if (!_tipEl || tip.style.display === 'none') return;
    _positionTip(e.clientX, e.clientY);
  });

  document.addEventListener('mouseout', e => {
    if (e.target.closest('[data-tip]')) { tip.style.display = 'none'; _tipEl = null; }
  });

  function _positionTip(mx, my) {
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    const vw = window.innerWidth || document.documentElement.clientWidth;
    const vh = window.innerHeight || document.documentElement.clientHeight;
    let left = mx + 12, top = my + 16;
    if (vw > 0 && left + tw > vw - 4) left = mx - tw - 8;
    if (vh > 0 && top + th > vh - 4) top = my - th - 8;
    if (left < 4) left = 4;
    if (top < 4) top = 4;
    tip.style.left = left + 'px';
    tip.style.top  = top + 'px';
  }
})();