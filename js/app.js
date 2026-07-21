/**
 * 主应用逻辑 — 路由、视图渲染、交互处理
 * 全局命名空间: App
 */
const App = (() => {
  // ====== 状态 ======
  let currentView = 'today';
  let currentDate = Storage.today();       // 今日视图的日期
  let historyDate = Storage.today();       // 历史视图的选中日期
  let calYear, calMonth;                   // 日历当前年月

  // ====== DOM 缓存 ======
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  // ====== 初始化 ======

  function init() {
    Storage.initDB();

    // 设置今日视图的日期显示
    calYear = new Date().getFullYear();
    calMonth = new Date().getMonth() + 1;

    bindTabs();
    bindHeaderButtons();
    bindSheet();
    bindNotificationPrompt();

    renderToday();
    renderMedications();
    renderHistory();

    // 初始化通知和SW
    Notifications.init();
    Notifications.registerSW();

    // 前台恢复时补发检查
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        currentDate = Storage.today();
        renderToday();
        Notifications.catchUpMissed();
      }
    });
  }

  // ====== Tab 导航 ======

  function bindTabs() {
    $$('.tab-item').forEach(btn => {
      btn.addEventListener('click', () => {
        const view = btn.dataset.view;
        switchView(view);
      });
    });
  }

  function switchView(view) {
    currentView = view;

    // 切换视图
    $$('.view').forEach(v => v.classList.remove('active'));
    const target = document.getElementById(`view-${view}`);
    if (target) target.classList.add('active');

    // 切换Tab高亮
    $$('.tab-item').forEach(b => b.classList.remove('active'));
    const tab = document.querySelector(`.tab-item[data-view="${view}"]`);
    if (tab) tab.classList.add('active');

    // 切到历史时刷新
    if (view === 'history') {
      calYear = new Date().getFullYear();
      calMonth = new Date().getMonth() + 1;
      historyDate = Storage.today();
      renderHistory();
    }
    if (view === 'today') {
      currentDate = Storage.today();
      renderToday();
    }
    if (view === 'medications') {
      renderMedications();
    }
  }

  // ====== 今日视图 ======

  function bindHeaderButtons() {
    $('#btn-date-prev').addEventListener('click', () => {
      currentDate = shiftDate(currentDate, -1);
      renderToday();
    });
    $('#btn-date-next').addEventListener('click', () => {
      currentDate = shiftDate(currentDate, 1);
      renderToday();
    });
    $('#btn-date-today').addEventListener('click', () => {
      currentDate = Storage.today();
      renderToday();
    });
  }

  function renderToday() {
    $('#date-display').textContent = formatDateCN(currentDate);

    const doses = Storage.ensureDailyDoses(currentDate);
    const timeline = $('#timeline');
    const empty = $('#empty-today');

    // 过滤掉频率不匹配的剂量（如 weekly 非指定日）
    const relevantDoses = doses.filter(d => d.status === 'pending' || d.status === 'taken' || d.status === 'skipped');

    if (relevantDoses.length === 0) {
      timeline.innerHTML = '';
      empty.classList.remove('hidden');
      updateProgress(0, 0);
      return;
    }

    empty.classList.add('hidden');

    // 按时间分组
    const groups = groupByPeriod(relevantDoses);
    let html = '';

    for (const [label, items] of Object.entries(groups)) {
      html += `<div class="timeline-period-label" style="font-size:13px;font-weight:600;color:var(--color-text-secondary);padding:4px 0 4px 60px">${label}</div>`;

      for (const dose of items) {
        const med = Storage.getMedication(dose.medicationId);
        if (!med) continue;

        const isPending = dose.status === 'pending';
        const isTaken = dose.status === 'taken';
        const isSkipped = dose.status === 'skipped';
        const isOverdue = isPending && isTimePast(dose.scheduledTime, currentDate, 30);

        let cardClass = 'timeline-card';
        if (isOverdue) cardClass += ' overdue';
        if (isTaken) cardClass += ' taken';
        if (isSkipped) cardClass += ' skipped';

        let actionsHtml = '';
        if (isPending) {
          actionsHtml = `
            <div class="card-actions">
              <button class="btn-take" data-action="take" data-id="${dose.id}">已服用</button>
              <button class="btn-skip" data-action="skip" data-id="${dose.id}">跳过</button>
            </div>`;
        } else {
          const badgeClass = isTaken ? 'taken-badge' : 'skipped-badge';
          const badgeText = isTaken ? '已服用 ✓' : '已跳过';
          const timeText = isTaken && dose.actualTime
            ? formatTime(new Date(dose.actualTime))
            : '';
          actionsHtml = `
            <div style="display:flex;justify-content:space-between;align-items:center">
              <span class="status-badge ${badgeClass}">${badgeText}</span>
              ${timeText ? `<span style="font-size:12px;color:var(--color-text-secondary)">${timeText}</span>` : ''}
            </div>`;
        }

        html += `
          <div class="timeline-item">
            <div class="timeline-time-col">
              <span class="timeline-time">${dose.scheduledTime}</span>
              <div class="timeline-line"></div>
            </div>
            <div class="${cardClass}">
              <div class="med-info">
                <span class="med-color-dot" style="background:${med.color || '#007AFF'}"></span>
                <span class="med-name">${escapeHtml(med.name)}</span>
                <span class="med-dosage">${escapeHtml(med.dosage || '')}</span>
              </div>
              ${med.notes ? `<div class="med-notes">${escapeHtml(med.notes)}</div>` : ''}
              ${isOverdue ? '<span class="overdue-tag">已超时</span>' : ''}
              ${actionsHtml}
            </div>
          </div>`;
      }
    }

    timeline.innerHTML = html;

    // 绑定操作按钮
    timeline.querySelectorAll('[data-action]').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.id;
        const action = btn.dataset.action;
        if (action === 'take') markAsTaken(id);
        if (action === 'skip') markAsSkipped(id);
      });
    });

    // 更新进度
    const total = relevantDoses.length;
    const taken = relevantDoses.filter(d => d.status === 'taken').length;
    updateProgress(taken, total);
  }

  function markAsTaken(id) {
    Storage.updateDoseStatus(id, 'taken');
    showToast('已记录服用 ✓');
    renderToday();
  }

  function markAsSkipped(id) {
    Storage.updateDoseStatus(id, 'skipped');
    showToast('已跳过此次服药');
    renderToday();
  }

  function updateProgress(taken, total) {
    const ring = $('.progress-ring-fill');
    const circumference = 2 * Math.PI * 52; // ~326.7
    const ratio = total > 0 ? taken / total : 0;
    const offset = circumference * (1 - ratio);

    ring.style.strokeDasharray = circumference;
    ring.style.strokeDashoffset = offset;

    $('#progress-taken').textContent = taken;
    $('#progress-total').textContent = total;

    const label = $('#progress-label');
    if (total === 0) {
      label.textContent = '今日无服药安排';
    } else if (taken === total) {
      label.textContent = '全部完成！';
      ring.style.stroke = 'var(--color-success)';
    } else {
      label.textContent = `还有 ${total - taken} 次待服用`;
      ring.style.stroke = taken > 0 ? 'var(--color-warning)' : 'var(--color-separator)';
    }
  }

  // ====== 药品管理视图 ======

  function renderMedications() {
    const meds = Storage.getMedications(true);
    const list = $('#meds-list');
    const empty = $('#empty-meds');

    // 绑定: 添加按钮（始终绑定，不受列表空状态影响）
    $('#btn-add-med').onclick = () => openAddSheet();

    if (meds.length === 0) {
      list.innerHTML = '';
      empty.classList.remove('hidden');
      return;
    }
    empty.classList.add('hidden');

    // 按状态分组
    const active = meds.filter(m => m.enabled !== false);
    const disabled = meds.filter(m => m.enabled === false);

    let html = '';
    for (const med of [...active, ...disabled]) {
      const isOff = med.enabled === false;
      html += `
        <div class="med-card ${isOff ? 'disabled' : ''}" data-med-id="${med.id}" style="${isOff ? 'opacity:0.5' : ''}">
          <div class="med-card-left">
            <span class="med-color-dot" style="background:${med.color || '#007AFF'};width:14px;height:14px"></span>
            <div class="med-card-info">
              <div class="med-card-name">${escapeHtml(med.name)} ${isOff ? '(已停用)' : ''}</div>
              <div class="med-card-meta">${escapeHtml(med.dosage || '')}${med.notes ? ' · ' + escapeHtml(med.notes) : ''}</div>
              <div class="med-card-times">
                ${(med.times || []).map(t => `<span class="time-tag">${t}</span>`).join('')}
                <span style="font-size:11px;color:var(--color-text-secondary);margin-left:4px">
                  ${med.frequency === 'weekly' ? '每周' + (med.daysOfWeek||[]).map(d => ['日','一','二','三','四','五','六'][d]).join('') : ''}
                  ${med.frequency === 'interval' ? '每' + med.intervalHours + '小时' : ''}
                  ${med.frequency === 'daily' ? '每天' : ''}
                </span>
              </div>
            </div>
          </div>
          <button class="toggle ${isOff ? '' : 'on'}" data-toggle="${med.id}" aria-label="开关"></button>
        </div>`;
    }

    list.innerHTML = html;

    // 绑定: 点击卡片 → 编辑
    list.querySelectorAll('.med-card').forEach(card => {
      card.addEventListener('click', (e) => {
        if (e.target.closest('.toggle')) return; // 不拦截开关点击
        const id = card.dataset.medId;
        openEditSheet(id);
      });
    });

    // 绑定: 开关
    list.querySelectorAll('.toggle').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = btn.dataset.toggle;
        const updated = Storage.toggleMedication(id);
        if (updated) {
          showToast(updated.enabled ? '已启用' : '已停用');
          renderMedications();
          renderToday();
        }
      });
    });

  }

  // ====== Sheet 弹窗（添加/编辑药品） ======

  function bindSheet() {
    $('#btn-sheet-cancel').addEventListener('click', closeSheet);
    $('#btn-sheet-save').addEventListener('click', saveMedication);
    $('#btn-delete-med').addEventListener('click', deleteMedication);
    $('#sheet-overlay').addEventListener('click', (e) => {
      if (e.target === $('#sheet-overlay')) closeSheet();
    });

    // 添加时间按钮
    $('#btn-add-time').addEventListener('click', () => {
      const container = $('#times-container');
      const row = document.createElement('div');
      row.className = 'time-row';
      row.innerHTML = `
        <input type="time" class="field-input time-input" value="12:00">
        <button class="btn-icon btn-remove-time" aria-label="删除时间">&times;</button>
      `;
      row.querySelector('.btn-remove-time').addEventListener('click', () => row.remove());
      container.appendChild(row);
    });

    // 频率切换
    $('#input-frequency').addEventListener('change', (e) => {
      const val = e.target.value;
      $('#weekday-selector').classList.toggle('hidden', val !== 'weekly');
      $('#interval-input').classList.toggle('hidden', val !== 'interval');
    });

    // 星期选择器
    $('#weekday-selector').addEventListener('click', (e) => {
      const chip = e.target.closest('.chip');
      if (!chip) return;
      chip.classList.toggle('selected');
    });

    // 颜色选择器
    $('#color-options').addEventListener('click', (e) => {
      const chip = e.target.closest('.color-chip');
      if (!chip) return;
      $$('.color-chip').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
    });
  }

  function openAddSheet() {
    $('#sheet-title').textContent = '添加药品';
    $('#edit-id').value = '';
    $('#input-name').value = '';
    $('#input-dosage').value = '';
    $('#input-frequency').value = 'daily';
    $('#input-notes').value = '';
    $('#btn-delete-med').classList.add('hidden');
    $('#weekday-selector').classList.add('hidden');
    $('#interval-input').classList.add('hidden');

    // 重置时间
    const container = $('#times-container');
    container.innerHTML = `
      <div class="time-row">
        <input type="time" class="field-input time-input" value="08:00">
        <button class="btn-icon btn-remove-time" aria-label="删除时间">&times;</button>
      </div>`;
    container.querySelector('.btn-remove-time').addEventListener('click', function() {
      this.closest('.time-row').remove();
    });

    // 重置颜色
    $$('.color-chip').forEach(c => c.classList.remove('active'));
    const first = $('.color-chip');
    if (first) first.classList.add('active');

    // 重置星期
    $$('#weekday-selector .chip').forEach(c => c.classList.remove('selected'));

    $('#sheet-overlay').classList.remove('hidden');
  }

  function openEditSheet(id) {
    const med = Storage.getMedication(id);
    if (!med) return;

    $('#sheet-title').textContent = '编辑药品';
    $('#edit-id').value = med.id;
    $('#input-name').value = med.name || '';
    $('#input-dosage').value = med.dosage || '';
    $('#input-frequency').value = med.frequency || 'daily';
    $('#input-notes').value = med.notes || '';
    $('#btn-delete-med').classList.remove('hidden');
    $('#weekday-selector').classList.toggle('hidden', med.frequency !== 'weekly');
    $('#interval-input').classList.toggle('hidden', med.frequency !== 'interval');

    if (med.intervalHours) {
      $('#input-interval').value = med.intervalHours;
    }

    // 填充时间
    const container = $('#times-container');
    container.innerHTML = (med.times || ['08:00']).map(t => `
      <div class="time-row">
        <input type="time" class="field-input time-input" value="${t}">
        <button class="btn-icon btn-remove-time" aria-label="删除时间">&times;</button>
      </div>`).join('');
    container.querySelectorAll('.btn-remove-time').forEach(btn => {
      btn.addEventListener('click', () => btn.closest('.time-row').remove());
    });

    // 填充颜色
    $$('.color-chip').forEach(c => c.classList.remove('active'));
    const match = document.querySelector(`.color-chip[data-color="${med.color}"]`);
    if (match) match.classList.add('active');
    else {
      const first = $('.color-chip');
      if (first) first.classList.add('active');
    }

    // 填充星期
    $$('#weekday-selector .chip').forEach(c => {
      const day = parseInt(c.dataset.day);
      c.classList.toggle('selected', (med.daysOfWeek || []).includes(day));
    });

    $('#sheet-overlay').classList.remove('hidden');
  }

  function closeSheet() {
    $('#sheet-overlay').classList.add('hidden');
  }

  function saveMedication() {
    const id = $('#edit-id').value;
    const name = $('#input-name').value.trim();
    const dosage = $('#input-dosage').value.trim();
    const frequency = $('#input-frequency').value;
    const notes = $('#input-notes').value.trim();

    if (!name) {
      showToast('请输入药品名称');
      return;
    }

    // 收集时间
    const times = [...$$('.time-input')].map(el => el.value).filter(Boolean).sort();

    if (times.length === 0) {
      showToast('请至少设置一个服药时间');
      return;
    }

    // 收集颜色
    const activeColor = document.querySelector('.color-chip.active');
    const color = activeColor ? activeColor.dataset.color : '#007AFF';

    // 收集星期
    const daysOfWeek = [...$$('#weekday-selector .chip.selected')].map(c => parseInt(c.dataset.day));

    // 收集间隔
    const intervalHours = frequency === 'interval' ? parseInt($('#input-interval').value) || 8 : null;

    const med = {
      id: id || undefined,
      name,
      dosage,
      times,
      frequency,
      daysOfWeek: frequency === 'weekly' ? daysOfWeek : null,
      intervalHours: frequency === 'interval' ? intervalHours : null,
      color,
      notes
    };

    if (id) {
      // 保留原有字段
      const existing = Storage.getMedication(id);
      if (existing) {
        med.id = existing.id;
        med.createdAt = existing.createdAt;
        med.enabled = existing.enabled;
      }
    }

    Storage.saveMedication(med);
    closeSheet();
    showToast(id ? '药品已更新' : '药品已添加');
    renderMedications();
    renderToday();
  }

  function deleteMedication() {
    const id = $('#edit-id').value;
    if (!id) return;
    if (!confirm('确定要删除此药品吗？历史记录将保留。')) return;
    Storage.deleteMedication(id);
    closeSheet();
    showToast('药品已删除');
    renderMedications();
    renderToday();
  }

  // ====== 历史记录视图 ======

  function renderHistory() {
    // 统计
    const stats = Storage.getStats();
    $('#stat-week').textContent = stats.weekRate + '%';
    $('#stat-month').textContent = stats.monthRate + '%';
    $('#stat-streak').textContent = stats.streak + '天';

    // 日历
    renderCalendar();
    renderHistoryDetail();
  }

  function renderCalendar() {
    const year = calYear;
    const month = calMonth;
    $('#cal-month-label').textContent = `${year}年${month}月`;

    const firstDay = new Date(year, month - 1, 1);
    const lastDay = new Date(year, month, 0);
    const startDow = firstDay.getDay();
    const totalDays = lastDay.getDate();

    const historyMap = Storage.getAllHistoryDates();
    const todayStr = Storage.today();

    let html = '';

    // 前置空白
    for (let i = 0; i < startDow; i++) {
      html += '<span class="cal-day other-month"></span>';
    }

    // 日期格子
    for (let d = 1; d <= totalDays; d++) {
      const ds = `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      let cls = 'cal-day';
      if (ds === todayStr) cls += ' today';
      if (ds === historyDate) cls += ' selected';
      if (historyMap[ds]) cls += ' has-record';

      html += `<span class="${cls}" data-date="${ds}">${d}</span>`;
    }

    $('#calendar-days').innerHTML = html;

    // 绑定日期点击
    $$('.cal-day').forEach(day => {
      day.addEventListener('click', () => {
        const ds = day.dataset.date;
        if (!ds) return;
        historyDate = ds;
        renderHistory();
      });
    });

    // 月份切换
    $('#btn-cal-prev').onclick = () => {
      calMonth--;
      if (calMonth < 1) { calMonth = 12; calYear--; }
      renderHistory();
    };
    $('#btn-cal-next').onclick = () => {
      calMonth++;
      if (calMonth > 12) { calMonth = 1; calYear++; }
      renderHistory();
    };
  }

  function renderHistoryDetail() {
    $('#history-date-label').textContent = formatDateCN(historyDate);
    const records = Storage.getHistory(historyDate);
    const container = $('#history-list');

    if (records.length === 0) {
      container.innerHTML = '<p style="color:var(--color-text-secondary);font-size:14px;padding:8px 0">该日期无服药记录</p>';
      return;
    }

    container.innerHTML = records.map(r => {
      const statusClass = r.status;
      const statusText = { taken: '已服用', skipped: '已跳过', missed: '未服用', pending: '待处理' }[r.status] || r.status;
      const actTime = r.actualTime ? formatTime(new Date(r.actualTime)) : '';

      return `
        <div class="history-item">
          <span class="history-dot ${statusClass}"></span>
          <div class="history-info">
            <span class="med-name">${escapeHtml(r.medicationName)}</span>
            <span style="color:var(--color-text-secondary);font-size:13px;margin-left:4px">${r.scheduledTime}</span>
            ${actTime ? `<span style="color:var(--color-text-secondary);font-size:12px;margin-left:4px">→ ${actTime}</span>` : ''}
          </div>
          <span class="history-status ${statusClass}">${statusText}</span>
        </div>`;
    }).join('');
  }

  // ====== 通知权限引导 ======

  function bindNotificationPrompt() {
    // notifications.js 会调用此方法显示引导
  }

  // ====== Toast ======

  function showToast(msg) {
    const toast = $('#toast');
    toast.textContent = msg;
    toast.classList.add('show');
    clearTimeout(toast._timeout);
    toast._timeout = setTimeout(() => {
      toast.classList.remove('show');
    }, 2000);
  }

  // ====== 工具函数 ======

  function shiftDate(dateStr, days) {
    const d = new Date(dateStr + 'T00:00:00');
    d.setDate(d.getDate() + days);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  function formatDateCN(dateStr) {
    const d = new Date(dateStr + 'T00:00:00');
    const weekdays = ['日', '一', '二', '三', '四', '五', '六'];
    const todayStr = Storage.today();
    const yesterdayStr = shiftDate(todayStr, -1);
    const tomorrowStr = shiftDate(todayStr, 1);

    let label = `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 周${weekdays[d.getDay()]}`;
    if (dateStr === todayStr) label = '今天 ' + label;
    else if (dateStr === yesterdayStr) label = '昨天 ' + label;
    else if (dateStr === tomorrowStr) label = '明天 ' + label;

    return label;
  }

  function formatTime(d) {
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }

  function isTimePast(scheduledTime, dateStr, thresholdMin) {
    if (dateStr !== Storage.today()) return dateStr < Storage.today();
    const now = new Date();
    const currentMinutes = now.getHours() * 60 + now.getMinutes();
    const [h, m] = scheduledTime.split(':').map(Number);
    const doseMinutes = h * 60 + m;
    return currentMinutes - doseMinutes > thresholdMin;
  }

  function groupByPeriod(doses) {
    const groups = { '早晨 (05:00-09:59)': [], '上午 (10:00-11:59)': [], '中午 (12:00-13:59)': [], '下午 (14:00-17:59)': [], '晚上 (18:00-23:59)': [], '夜间 (00:00-04:59)': [] };
    for (const d of doses) {
      const h = parseInt(d.scheduledTime.split(':')[0]);
      if (h >= 5 && h < 10) groups['早晨 (05:00-09:59)'].push(d);
      else if (h >= 10 && h < 12) groups['上午 (10:00-11:59)'].push(d);
      else if (h >= 12 && h < 14) groups['中午 (12:00-13:59)'].push(d);
      else if (h >= 14 && h < 18) groups['下午 (14:00-17:59)'].push(d);
      else if (h >= 18 && h < 24) groups['晚上 (18:00-23:59)'].push(d);
      else groups['夜间 (00:00-04:59)'].push(d);
    }
    // 移除空组
    return Object.fromEntries(Object.entries(groups).filter(([, v]) => v.length > 0));
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // ====== 公开 API ======

  return { init, switchView, showToast };
})();

document.addEventListener('DOMContentLoaded', () => App.init());
