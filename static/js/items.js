// ══════════ 物品库 ══════════

let _itemGroup = '', _itemSubtype = '', _itemRarity = '', _itemSearch = '';

async function loadItems() {
  const items = await api('/api/items');
  state.items.all = items;
  _renderItemFilterBar();
  filterItems();
}

function _renderItemFilterBar() {
  const el = document.getElementById('itemFilterBar');
  if (!el) return;

  const groupBtns = INV_TYPE_GROUPS.map(g =>
    `<button class="tag-btn${_itemGroup === g.label ? ' active' : ''}"
      onclick="itemSetGroup('${g.label}')">${g.label}</button>`
  ).join('');

  const rarityBtns = INV_RARITIES.map(r =>
    `<button class="tag-btn${_itemRarity === r.value ? ' active' : ''}"
      onclick="itemSetRarity('${r.value}')"
      style="font-size:11px;padding:3px 10px;${_itemRarity === r.value ? '' : 'color:'+r.color}">${r.label}</button>`
  ).join('');

  let subtypeHtml = '';
  if (_itemGroup) {
    const grp = INV_TYPE_GROUPS.find(g => g.label === _itemGroup);
    if (grp && grp.types.length > 1) {
      subtypeHtml = `
        <div style="display:flex;flex-wrap:wrap;gap:4px;padding:0 16px 6px">
          <button class="tag-btn${!_itemSubtype ? ' active' : ''}"
            onclick="itemSetSubtype('')" style="font-size:11px;padding:3px 10px">全部</button>
          ${grp.types.map(t =>
            `<button class="tag-btn${_itemSubtype === t ? ' active' : ''}"
              onclick="itemSetSubtype('${t}')" style="font-size:11px;padding:3px 10px">${INV_TYPE_LABELS[t] || t}</button>`
          ).join('')}
        </div>`;
    }
  }

  const total = (state.items.all || []).length;
  const filtered = (state.items.filtered || []).length;
  const countText = _itemSearch ? `${filtered} / ${total}` : `共 ${total}`;

  el.innerHTML = `
    <div style="display:flex;flex-wrap:wrap;gap:4px;align-items:center;padding:6px 16px">
      <div class="search-wrap" style="width:200px;margin-right:8px">
        <span class="search-icon">⌕</span>
        <input type="text" placeholder="搜索名称或别名..." value="${_itemSearch.replace(/"/g,'&quot;')}"
          oninput="itemSetSearch(this.value)">
      </div>
      <span style="font-size:11px;color:var(--text3);margin-right:2px">分类</span>
      <button class="tag-btn${!_itemGroup ? ' active' : ''}" onclick="itemSetGroup('')">全部</button>
      ${groupBtns}
      <span style="width:1px;height:16px;background:var(--border2);margin:0 4px"></span>
      <span style="font-size:11px;color:var(--text3);margin-right:2px">稀有度</span>
      <button class="tag-btn${!_itemRarity ? ' active' : ''}" onclick="itemSetRarity('')"
        style="font-size:11px;padding:3px 10px">全部</button>
      ${rarityBtns}
      <span style="width:1px;height:16px;background:var(--border2);margin:0 4px"></span>
      <span id="itemCount" style="font-size:12px;color:var(--text3);white-space:nowrap">${countText}</span>
    </div>
    ${subtypeHtml}
  `;
}

function itemSetGroup(g) {
  _itemGroup = _itemGroup === g ? '' : g;
  _itemSubtype = '';
  _renderItemFilterBar();
  filterItems();
}
function itemSetSubtype(t) {
  _itemSubtype = _itemSubtype === t ? '' : t;
  _renderItemFilterBar();
  filterItems();
}
function itemSetRarity(r) {
  _itemRarity = _itemRarity === r ? '' : r;
  _renderItemFilterBar();
  filterItems();
}
function itemSetSearch(val) {
  _itemSearch = val;
  filterItems();
}

function filterItems() {
  let list = state.items.all || [];
  if (_itemSubtype) {
    list = list.filter(i => i.type === _itemSubtype);
  } else if (_itemGroup) {
    list = list.filter(i => itemMatchesGroup(i, _itemGroup));
  }
  if (_itemRarity) list = list.filter(i => i.rarity === _itemRarity);
  if (_itemSearch) {
    const q = _itemSearch.toLowerCase();
    list = list.filter(i =>
      (i.name_zh||'').toLowerCase().includes(q) ||
      (i.name_zh_original||'').toLowerCase().includes(q) ||
      (i.name_en||'').toLowerCase().includes(q) ||
      (i.item_id||'').toLowerCase().includes(q) ||
      (i.aliases||[]).some(a => a.alias.toLowerCase().includes(q))
    );
  }
  state.items.filtered = list;
  const countEl = document.getElementById('itemCount');
  if (countEl) countEl.textContent = _itemSearch ? `${list.length} / ${(state.items.all||[]).length}` : `共 ${list.length}`;
  renderItems(list);
}

function renderItems(list) {
  const countEl = document.getElementById('itemCount');
  if (countEl) countEl.textContent = `共 ${list.length} 条`;
  document.getElementById('itemsBody').innerHTML = list.length
    ? list.map((item, idx) => {
      const aliasHtml = (item.aliases||[]).map(a =>
        `<span class="alias-tag" onclick="startEditAlias(${a.id},'${item.item_id}',this)" style="cursor:pointer" title="点击编辑">${a.alias}<span class="alias-del" onclick="event.stopPropagation();deleteItemAlias(${a.id},'${item.item_id}')">✕</span></span>`
      ).join('') +
      `<span onclick="startAddAlias('${item.item_id}')" style="cursor:pointer;color:var(--text3);font-size:13px;margin-left:4px" title="添加别名">+</span>`;

      return `<tr id="irow_${item.item_id}">
        <td style="color:var(--text3);font-size:12px;text-align:center">${idx + 1}</td>
        <td>
          <div style="position:relative;cursor:pointer;width:40px;height:40px" onclick="triggerImageUpload('${item.item_id}')" title="点击上传图片" class="img-upload-wrap">
            <img class="item-img" id="img_${item.item_id}" src="/api/items/${item.item_id}/image" onerror="this.style.opacity=.15">
            <div class="img-upload-hint">⬆</div>
          </div>
          <input type="file" id="imgfile_${item.item_id}" accept="image/*" style="display:none" onchange="uploadItemImage('${item.item_id}',this)">
        </td>
        <td id="namecell_${item.item_id}" onclick="startNameEdit('${item.item_id}')" style="cursor:pointer">
          <div style="display:flex;align-items:center;gap:4px">
            <span style="color:var(--text1);font-weight:500">${item.name_zh||item.name_zh_original||item.item_id}</span>
            <span style="opacity:0;font-size:11px;color:var(--text3)" class="edit-hint">✎</span>
          </div>
          <div style="font-size:11px;color:var(--text3);margin-top:1px">${item.name_en||item.item_id}</div>
        </td>
        <td id="aliascell_${item.item_id}">${aliasHtml}</td>
        <td><span class="rarity-${item.rarity}" style="font-size:12px">${item.rarity||'—'}</span></td>
      </tr>`;
    }).join('')
    : '<tr><td colspan="5" class="empty">暂无数据</td></tr>';

  // Hover hints for name cells
  document.querySelectorAll('[id^="namecell_"]').forEach(cell => {
    const hint = cell.querySelector('.edit-hint');
    cell.addEventListener('mouseenter', () => { if(hint) hint.style.opacity='1'; });
    cell.addEventListener('mouseleave', () => { if(hint) hint.style.opacity='0'; });
  });
}

function startNameEdit(item_id) {
  const cell = document.getElementById('namecell_'+item_id);
  if (cell.querySelector('input')) return;
  const item = state.items.all.find(i => i.item_id === item_id);
  const orig = cell.innerHTML;
  cell.innerHTML = `<input type="text" value="${(item?.name_zh||'').replace(/"/g,'&quot;')}" style="width:150px" id="nameinput_${item_id}">`;
  const input = cell.querySelector('input');
  input.focus(); input.select();

  let saving = false;
  async function save() {
    if (saving) return;
    saving = true;
    const val = input.value.trim();
    if (!val || val === item?.name_zh) { cell.innerHTML = orig; return; }
    const res = await api(`/api/items/${item_id}/name`, { method:'PUT', body: JSON.stringify({name_zh: val}) });
    if (res.error) { toast(res.error, 'error'); cell.innerHTML = orig; return; }
    if (item) item.name_zh = val;
    toast('显示名已保存', 'success');
    renderItems(state.items.filtered);
  }
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
    if (e.key === 'Escape') { saving = true; cell.innerHTML = orig; }
  });
  input.addEventListener('blur', save);
}

function startAddAlias(item_id) {
  const cell = document.getElementById('aliascell_'+item_id);
  const plus = cell.querySelector('span[title="添加别名"]');
  if (cell.querySelector('input.alias-input')) return;
  const input = document.createElement('input');
  input.className   = 'alias-input';
  input.placeholder = '输入别名，回车保存';
  input.style       = 'width:130px;display:inline-block;vertical-align:middle;margin-left:4px;padding:2px 6px;font-size:12px';
  cell.insertBefore(input, plus);
  input.focus();

  let saving = false;
  async function save() {
    if (saving) return;
    saving = true;
    const val = input.value.trim();
    input.remove();
    if (!val) return;
    const res = await api(`/api/items/${item_id}/aliases`, { method:'POST', body: JSON.stringify({alias: val}) });
    if (res.error) return toast(res.error, 'error');
    const item = state.items.all.find(i => i.item_id === item_id);
    if (item) {
      const fresh = await api(`/api/items/${item_id}/aliases`);
      item.aliases = fresh;
    }
    toast('别名已添加', 'success');
    renderItems(state.items.filtered);
  }
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
    if (e.key === 'Escape') { saving = true; input.remove(); }
  });
  input.addEventListener('blur', save);
}

function startEditAlias(aliasId, itemId, tagEl) {
  // 已经在编辑中，不重复触发
  if (tagEl.querySelector('input')) return;

  const oldText = tagEl.childNodes[0].textContent.trim();
  const input = document.createElement('input');
  input.type = 'text';
  input.value = oldText;
  input.className = 'alias-input';
  input.style.cssText = 'width:120px;font-size:12px;padding:2px 6px';

  const orig = tagEl.innerHTML;
  tagEl.innerHTML = '';
  tagEl.appendChild(input);
  input.focus();
  input.select();

  // 阻止输入框上的点击冒泡到 tagEl
  input.onclick = (e) => e.stopPropagation();

  let saved = false;
  const save = async () => {
    if (saved) return;
    saved = true;
    const val = input.value.trim();
    if (!val || val === oldText) { tagEl.innerHTML = orig; return; }
    const res = await api(`/api/aliases/${aliasId}`, { method:'PUT', body: JSON.stringify({alias: val}) });
    if (res && !res.error) {
      const item = state.items.all.find(i => i.item_id === itemId);
      if (item) {
        const a = item.aliases.find(a => a.id === aliasId);
        if (a) a.alias = val;
      }
      renderItems(state.items.filtered);
    } else {
      tagEl.innerHTML = orig;
    }
  };
  input.onblur = save;
  input.onkeydown = (e) => {
    if (e.key === 'Enter') input.blur();
    if (e.key === 'Escape') { saved = true; tagEl.innerHTML = orig; }
  };
}

async function deleteItemAlias(aliasId, item_id) {
  await api(`/api/aliases/${aliasId}`, { method:'DELETE' });
  const item = state.items.all.find(i => i.item_id === item_id);
  if (item) item.aliases = item.aliases.filter(a => a.id !== aliasId);
  toast('别名已删除');
  renderItems(state.items.filtered);
}

function triggerImageUpload(item_id) {
  document.getElementById('imgfile_'+item_id)?.click();
}

async function uploadItemImage(item_id, input) {
  if (!input.files[0]) return;
  // 压缩图片到 96x96
  const file = input.files[0];
  const compressed = await compressImage(file, 96, 96);
  const fd = new FormData();
  fd.append('file', compressed);
  const res = await fetch(`/api/items/${item_id}/image`, { method:'POST', body:fd }).then(r=>r.json());
  if (res.ok) {
    const img = document.getElementById('img_'+item_id);
    if (img) img.src = res.url + '?t=' + Date.now();
    toast('图片已更新', 'success');
  }
}

function compressImage(file, maxW, maxH) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      let w = img.width, h = img.height;
      if (w > maxW || h > maxH) {
        const ratio = Math.min(maxW / w, maxH / h);
        w = Math.round(w * ratio);
        h = Math.round(h * ratio);
      }
      canvas.width = w; canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      canvas.toBlob((blob) => {
        resolve(new File([blob], file.name, { type: 'image/png' }));
      }, 'image/png');
    };
    img.src = URL.createObjectURL(file);
  });
}