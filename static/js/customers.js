// ══════════ 客户 ══════════
async function loadCustomers() {
  const days = document.getElementById('customerDaysFilter').value || 7;
  const customers = await api(`/api/customers?days=${days}`);
  state.customers.all = customers;
  const countEl = document.getElementById('customerCount');
  if (countEl) countEl.textContent = `共 ${customers.length} 条`;
  document.getElementById('customersBody').innerHTML = customers.length
    ? customers.map((c, idx) => `
      <tr onclick="openCustomerDetail(${c.id})" style="cursor:pointer">
        <td style="color:var(--text3);font-size:12px;text-align:center">${idx + 1}</td>
        <td style="font-weight:500">${c.name}</td>
        <td class="col-num" style="color:var(--text2)">${c.order_count}</td>
        <td class="col-num" style="color:var(--accent)">${fmtPrice(c.recent_revenue)}</td>
        <td style="color:var(--text2);font-size:12px">${fmtTime(c.last_order_at)}</td>
        <td>
          <button class="btn small danger" onclick="event.stopPropagation();deleteCustomer(${c.id})">删</button>
        </td>
      </tr>`).join('')
    : '<tr><td colspan="5" class="empty">暂无客户数据</td></tr>';
}

async function openCustomerDetail(id) {
  const c = await api(`/api/customers/${id}`);
  document.getElementById('customerDetailContent').innerHTML = `
    <h3 style="margin-bottom:16px">${c.name}</h3>
    <div class="stat-row" style="margin-bottom:16px">
      <div class="stat-card"><div class="stat-num">${c.order_count}</div><div class="stat-label">总订单</div></div>
      <div class="stat-card"><div class="stat-num">${fmtPrice(c.total_revenue)}</div><div class="stat-label">总收入</div></div>
    </div>
    <div style="margin-bottom:16px">
      <div style="font-size:12px;color:var(--text2);margin-bottom:8px">购买物品 TOP10</div>
      <div style="display:flex;flex-wrap:wrap;gap:6px">
        ${(c.top_items||[]).map(it =>
          `<span class="item-tag"><img src="/api/items/${it.item_id}/image" style="width:18px;height:18px;object-fit:contain" onerror="this.style.opacity=.2"> ${it.name_zh} ${it.name_en ? '<span style="font-size:10px;color:var(--text3)">'+it.name_en+'</span>' : ''} ×${it.total_qty}</span>`
        ).join('') || '<span style="color:var(--text3)">暂无</span>'}
      </div>
    </div>
    <div>
      <div style="font-size:12px;color:var(--text2);margin-bottom:8px">历史订单</div>
      <table>
        <thead><tr><th>#</th><th>收入</th><th>状态</th><th>时间</th></tr></thead>
        <tbody>
          ${(c.orders||[]).slice(0,20).map(o => `
          <tr>
            <td style="color:var(--text3)">#${o.id}</td>
            <td style="color:var(--accent);font-family:'Rajdhani',sans-serif">${fmtPrice(o.total_revenue)}</td>
            <td><span class="badge ${o.status}">${{pending:'待处理',completed:'已完成',cancelled:'已取消',deleted:'已删除'}[o.status]||o.status}</span></td>
            <td style="color:var(--text2);font-size:12px">${fmtTime(o.created_at)}</td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>
    <div style="margin-top:12px">
      <label class="form-label">备注</label>
      <div style="display:flex;gap:8px">
        <input type="text" id="customerNote" value="${c.note||''}" onkeydown="if(event.key==='Enter'){event.preventDefault();saveCustomerNote(${id})}">
        <button class="btn small" onclick="saveCustomerNote(${id})">保存</button>
      </div>
    </div>`;
  openModal('customerDetailModal');
}

async function saveCustomerNote(id) {
  const note = document.getElementById('customerNote').value;
  await api(`/api/customers/${id}`, { method:'PUT', body: JSON.stringify({note}) });
  toast('备注已保存', 'success');
}

async function deleteCustomer(id) {
  if (!confirm('确认删除此客户？历史订单不会删除。')) return;
  await api(`/api/customers/${id}`, { method:'DELETE' });
  toast('已删除');
  loadCustomers();
}
