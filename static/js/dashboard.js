let _dashChart = null;
let _dashChartResizeBound = false;

async function loadDashboard() {
  const [accounts, inventory, orders] = await Promise.all([
    api('/api/accounts').catch(() => []),
    api('/api/inventory').catch(() => []),
    api('/api/orders').catch(() => []),
  ]);

  document.getElementById('stat-accounts').textContent = accounts.filter(a => a.active).length;
  document.getElementById('stat-items').textContent    = inventory.length;
  document.getElementById('stat-orders').textContent   = orders.filter(o => o.status === 'pending').length;

  const tbody = document.querySelector('#dashAccountTable tbody');
  tbody.innerHTML = accounts.map(a => {
    const used = a.used_slots || 0, max = a.max_slots || 0;
    const pct  = max > 0 ? Math.round(used / max * 100) : 0;
    const barColor = pct > 85 ? 'var(--danger)' : pct > 60 ? 'var(--accent)' : 'var(--success)';
    const slotHtml = max > 0 ? `
      <div style="display:flex;align-items:center;gap:6px;min-width:140px">
        <div style="flex:1;height:4px;background:var(--bg3);border-radius:2px">
          <div style="width:${pct}%;height:100%;background:${barColor};border-radius:2px;transition:width .3s"></div>
        </div>
        <span style="font-size:11px;color:var(--text3);white-space:nowrap">${used}/${max}</span>
      </div>` : '<span style="color:var(--text3);font-size:12px">—</span>';
    const statusMap = { ok:'正常', ready:'待同步', never:'未同步', syncing:'同步中', timeout:'超时', cookie_expired:'Cookie过期', error:'错误' };
    return `<tr>
      <td><strong>${escHtml(a.name)}</strong>${a.note ? `<span style="color:var(--text3);margin-left:8px;font-size:12px">${escHtml(a.note)}</span>` : ''}</td>
      <td>
        <span class="badge ${a.sync_status === 'ok' ? 'ok' : a.sync_status === 'ready' || a.sync_status === 'never' ? 'pending' : 'error'}">
          ${statusMap[a.sync_status] || a.sync_status}
        </span>
        ${a.sync_error ? `<div style="font-size:11px;color:var(--danger);margin-top:2px">${escHtml(a.sync_error)}</div>` : ''}
      </td>
      <td>${slotHtml}</td>
      <td style="color:var(--text2);font-size:12px">${fmtTime(a.last_sync)}</td>
      <td>
        <button class="btn small" onclick="syncOneDash(${a.id},this)">↻ 同步</button>
      </td>
    </tr>`;
  }).join('') || '<tr><td colspan="5" class="empty">暂无账号</td></tr>';

  // 初始化统计日期
  const today = new Date().toISOString().slice(0, 10);
  if (!document.getElementById('dashStatsFrom').value) {
    document.getElementById('dashStatsFrom').value = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
    document.getElementById('dashStatsTo').value   = today;
  }
  loadDashStats();
}

async function syncOneDash(id, btn) {
  btn.disabled = true; btn.textContent = '同步中...';
  const res = await api(`/api/accounts/${id}/sync`, { method: 'POST' });
  toast(res.ok ? '同步成功' : '同步失败', res.ok ? 'success' : 'error');
  btn.disabled = false; btn.textContent = '↻ 同步';
  loadDashboard();
}

function toggleDailyTable() {
  const el    = document.getElementById('dashDailyTable');
  const arrow = document.getElementById('dailyTableArrow');
  const show  = el.style.display === 'none';
  el.style.display    = show ? '' : 'none';
  arrow.textContent   = show ? '▼' : '▶';
}

function setDashRange(range, btn) {
  if (btn) {
    document.querySelectorAll('.dash-range-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
  } else {
    document.querySelectorAll('.dash-range-btn').forEach(b => b.classList.remove('active'));
  }
  const today = new Date().toISOString().slice(0, 10);
  if (range === 'today') {
    document.getElementById('dashStatsFrom').value = today;
    document.getElementById('dashStatsTo').value   = today;
  } else if (range === '7d') {
    document.getElementById('dashStatsFrom').value = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
    document.getElementById('dashStatsTo').value   = today;
  } else if (range === '30d') {
    document.getElementById('dashStatsFrom').value = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    document.getElementById('dashStatsTo').value   = today;
  } else if (range === 'all') {
    document.getElementById('dashStatsFrom').value = '2020-01-01';
    document.getElementById('dashStatsTo').value   = today;
  }
  loadDashStats();
}

function renderDashChart(daily) {
  const container = document.getElementById('dashEChart');
  if (typeof echarts === 'undefined') {
    container.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--text3);font-size:13px">图表库加载失败（需要联网）</div>';
    return;
  }
  if (!daily || !daily.length) {
    if (_dashChart) { _dashChart.dispose(); _dashChart = null; }
    container.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--text3);font-size:13px">暂无数据</div>';
    return;
  }
  container.innerHTML = '';
  if (_dashChart) { _dashChart.dispose(); _dashChart = null; }
  _dashChart = echarts.init(container, null, { renderer: 'canvas' });
  if (!_dashChartResizeBound) {
    _dashChartResizeBound = true;
    window.addEventListener('resize', () => _dashChart && _dashChart.resize());
  }
  const days     = daily.map(d => d.day.slice(5));
  const costs    = daily.map(d => d.cost || 0);
  const revenues = daily.map(d => d.revenue || 0);
  const profits  = daily.map(d => d.profit || 0);
  _dashChart.setOption({
    backgroundColor: 'transparent',
    tooltip: {
      trigger: 'axis',
      backgroundColor: 'rgba(20,22,28,0.95)',
      borderColor: 'rgba(255,255,255,0.08)',
      textStyle: { color: '#e0e0e0', fontSize: 12 },
      formatter: params => {
        let s = `<div style="font-weight:600;margin-bottom:4px">${params[0].axisValue}</div>`;
        params.forEach(p => {
          s += `<div style="display:flex;justify-content:space-between;gap:16px"><span>${p.marker}${p.seriesName}</span><span style="font-weight:600">${(p.value||0).toFixed(0)}</span></div>`;
        });
        return s;
      }
    },
    legend: { data:['成本','营收','利润'], top:4, right:8, textStyle:{color:'#8a8f98',fontSize:11}, itemWidth:14, itemHeight:8, itemGap:16 },
    grid: { left:50, right:16, top:36, bottom:28 },
    xAxis: {
      type:'category', data:days,
      axisLine:{ lineStyle:{color:'rgba(255,255,255,0.06)'} },
      axisTick:{ show:false },
      axisLabel:{ color:'#8a8f98', fontSize:11, interval: daily.length > 20 ? Math.ceil(daily.length/15)-1 : 0, rotate: daily.length > 20 ? 30 : 0 },
    },
    yAxis: { type:'value', splitLine:{lineStyle:{color:'rgba(255,255,255,0.04)'}}, axisLine:{show:false}, axisTick:{show:false}, axisLabel:{color:'#8a8f98',fontSize:10} },
    series: [
      { name:'成本', type:'bar', data:costs, itemStyle:{color:'#e85030',borderRadius:[2,2,0,0]}, barMaxWidth:24 },
      { name:'营收', type:'bar', data:revenues, itemStyle:{color:'#5bc4e8',borderRadius:[2,2,0,0]}, barMaxWidth:24 },
      { name:'利润', type:'line', data:profits, smooth:true, symbol:'circle', symbolSize:6,
        lineStyle:{color:'#40c070',width:2}, itemStyle:{color:'#40c070',borderColor:'#1a1c22',borderWidth:2},
        areaStyle:{ color: new echarts.graphic.LinearGradient(0,0,0,1,[{offset:0,color:'rgba(64,192,112,0.25)'},{offset:1,color:'rgba(64,192,112,0)'}]) }
      },
    ],
    animationDuration: 500,
  }, true);
}

async function loadDashStats() {
  const from = document.getElementById('dashStatsFrom').value;
  const to   = document.getElementById('dashStatsTo').value;
  if (!from || !to) return;
  const d = await api(`/api/stats?from=${from}&to=${to}`);

  document.getElementById('dash-order-count').textContent = d.order_count || 0;
  document.getElementById('dash-cost').textContent        = fmtPrice(d.total_cost || 0);
  document.getElementById('dash-revenue').textContent     = fmtPrice(d.total_revenue || 0);
  const profit  = d.total_profit || 0;
  const profitEl = document.getElementById('dash-profit');
  profitEl.textContent = (profit >= 0 ? '+' : '') + fmtPrice(profit);
  profitEl.style.color = profit >= 0 ? 'var(--success)' : 'var(--danger)';

  renderDashChart(d.daily || []);

  // 每日明细
  const daily = (d.daily || []).filter(dd => dd.count > 0 || dd.revenue > 0);
  document.getElementById('dashDailyTable').innerHTML = daily.length ? `
    <table><thead><tr>
      <th>日期</th><th class="col-num">订单数</th>
      <th class="col-num">成本</th><th class="col-num">营收</th><th class="col-num">利润</th>
    </tr></thead><tbody>
      ${daily.map(dd => {
        const p = (dd.revenue||0) - (dd.cost||0);
        return `<tr>
          <td style="font-size:13px">${dd.day}</td>
          <td class="col-num">${dd.count}</td>
          <td class="col-num" style="color:var(--danger)">${(dd.cost||0).toFixed(0)}</td>
          <td class="col-num" style="color:var(--accent2)">${(dd.revenue||0).toFixed(0)}</td>
          <td class="col-num" style="color:${p>=0?'var(--success)':'var(--danger)'}">${p>=0?'+':''}${p.toFixed(0)}</td>
        </tr>`;
      }).join('')}
    </tbody></table>` : '';

  // Top 10
  const topItems = (d.items || []).slice(0, 10);
  document.getElementById('dashTopItems').innerHTML = topItems.length ? `
    <div style="font-size:12px;color:var(--text3);margin-bottom:8px;font-weight:600">销售排行 TOP ${topItems.length}</div>
    <table><thead><tr>
      <th>物品</th><th>英文名</th><th class="col-num">数量</th>
      <th class="col-num">成本</th><th class="col-num">营收</th><th class="col-num">利润</th>
    </tr></thead><tbody>
      ${topItems.map(i => {
        const p = i.profit || 0;
        return `<tr>
          <td style="font-size:13px">${i.name_zh || i.item_id}</td>
          <td style="font-size:13px;color:var(--text2)">${i.name_en || ''}</td>
          <td class="col-num">${i.total_qty}</td>
          <td class="col-num" style="color:var(--danger)">${(i.total_cost||0).toFixed(0)}</td>
          <td class="col-num" style="color:var(--accent2)">${(i.total_revenue||0).toFixed(0)}</td>
          <td class="col-num" style="color:${p>=0?'var(--success)':'var(--danger)'}">${p>=0?'+':''}${fmtPrice(p)}</td>
        </tr>`;
      }).join('')}
    </tbody></table>` :
    '<div style="color:var(--text3);font-size:13px;text-align:center;padding:20px 0">该时间段内暂无已完成订单</div>';
}