/**
 * 数据持久层 — localStorage CRUD 封装
 * 全局命名空间: App.Storage
 */
const Storage = (() => {
  const DB_KEY = 'med_reminder_db';
  const HISTORY_DAYS = 90; // 保留90天历史

  // ====== 内部工具 ======

  function genId(prefix) {
    return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  }

  function today() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  function now() {
    return new Date().toISOString();
  }

  function read() {
    try {
      const raw = localStorage.getItem(DB_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  function write(data) {
    localStorage.setItem(DB_KEY, JSON.stringify(data));
  }

  function initDB() {
    let db = read();
    if (!db) {
      db = { version: 1, medications: [], history: [], settings: { notificationEnabled: true, advanceMinutes: 5, snoozeMinutes: 10 } };
      write(db);
    }
    // 迁移逻辑占位
    return db;
  }

  // ====== 药品 CRUD ======

  function getMedications(includeDisabled = true) {
    const db = read() || initDB();
    return includeDisabled ? [...db.medications] : db.medications.filter(m => m.enabled !== false);
  }

  function getMedication(id) {
    const db = read();
    return db ? db.medications.find(m => m.id === id) || null : null;
  }

  function saveMedication(med) {
    const db = read() || initDB();
    const idx = db.medications.findIndex(m => m.id === med.id);
    if (idx >= 0) {
      med.updatedAt = now();
      db.medications[idx] = med;
    } else {
      med.id = genId('m');
      med.createdAt = now();
      med.updatedAt = now();
      med.enabled = true;
      db.medications.push(med);
    }
    write(db);
    _pruneHistory();
    return med;
  }

  function deleteMedication(id) {
    const db = read();
    if (!db) return false;
    db.medications = db.medications.filter(m => m.id !== id);
    write(db);
    return true;
  }

  function toggleMedication(id) {
    const db = read();
    if (!db) return null;
    const med = db.medications.find(m => m.id === id);
    if (!med) return null;
    med.enabled = !med.enabled;
    med.updatedAt = now();
    write(db);
    return med;
  }

  // ====== 历史记录 CRUD ======

  function getHistory(dateStr) {
    const db = read();
    if (!db) return [];
    return db.history.filter(h => h.date === dateStr);
  }

  function getHistoryRange(fromDate, toDate) {
    const db = read();
    if (!db) return [];
    return db.history.filter(h => h.date >= fromDate && h.date <= toDate);
  }

  function getAllHistoryDates() {
    const db = read();
    if (!db) return {};
    const map = {};
    for (const h of db.history) {
      if (!map[h.date]) map[h.date] = { taken: 0, total: 0 };
      map[h.date].total++;
      if (h.status === 'taken') map[h.date].taken++;
    }
    return map;
  }

  function logDose(medicationId, medicationName, date, scheduledTime, status) {
    const db = read() || initDB();
    const id = genId('h');
    const record = {
      id,
      medicationId,
      medicationName,
      date,
      scheduledTime,
      actualTime: status === 'taken' ? now() : null,
      status
    };
    db.history.push(record);
    write(db);
    return record;
  }

  function updateDoseStatus(id, status) {
    const db = read();
    if (!db) return null;
    const h = db.history.find(r => r.id === id);
    if (!h) return null;
    h.status = status;
    if (status === 'taken') h.actualTime = now();
    write(db);
    return h;
  }

  // ====== 今日剂量管理 ======

  /**
   * 为指定日期生成待服药记录（幂等）
   * 返回该日期的所有剂量记录
   */
  function ensureDailyDoses(dateStr) {
    const db = read() || initDB();
    const activeMeds = db.medications.filter(m => m.enabled !== false);
    const existing = db.history.filter(h => h.date === dateStr);
    const existingKeys = new Set(existing.map(h => `${h.medicationId}|${h.scheduledTime}`));

    const newRecords = [];
    for (const med of activeMeds) {
      const times = _getTimesForDate(med, dateStr);
      for (const t of times) {
        const key = `${med.id}|${t}`;
        if (!existingKeys.has(key)) {
          newRecords.push({
            id: genId('h'),
            medicationId: med.id,
            medicationName: med.name,
            date: dateStr,
            scheduledTime: t,
            actualTime: null,
            status: 'pending'
          });
          existingKeys.add(key);
        }
      }
    }

    if (newRecords.length > 0) {
      db.history.push(...newRecords);
      write(db);
    }

    return [...existing, ...newRecords].sort((a, b) =>
      a.scheduledTime.localeCompare(b.scheduledTime)
    );
  }

  /**
   * 计算某药品在某日期的服药时间点
   */
  function _getTimesForDate(med, dateStr) {
    switch (med.frequency) {
      case 'daily':
        return med.times || [];

      case 'weekly': {
        const d = new Date(dateStr + 'T00:00:00');
        const dow = d.getDay();
        const days = med.daysOfWeek || [];
        return days.includes(dow) ? (med.times || []) : [];
      }

      case 'interval': {
        if (!med.intervalHours || !med.times || !med.times.length) return [];
        const baseTime = med.times[0];
        const [bh, bm] = baseTime.split(':').map(Number);
        const baseMinutes = bh * 60 + bm;
        const intervalMin = med.intervalHours * 60;
        const times = [];
        for (let offset = 0; offset < 24 * 60; offset += intervalMin) {
          const m = (baseMinutes + offset) % (24 * 60);
          const hh = String(Math.floor(m / 60)).padStart(2, '0');
          const mm = String(m % 60).padStart(2, '0');
          times.push(`${hh}:${mm}`);
          if (times.length >= 12) break;
        }
        return times;
      }

      default:
        return med.times || [];
    }
  }

  // ====== 统计 ======

  function getStats() {
    const db = read() || initDB();
    const nowDate = new Date();
    const todayStr = today();

    // 本周范围
    const dayOfWeek = nowDate.getDay();
    const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
    const monday = new Date(nowDate);
    monday.setDate(nowDate.getDate() + mondayOffset);
    const weekStart = _fmtDate(monday);

    // 本月范围
    const monthStart = `${nowDate.getFullYear()}-${String(nowDate.getMonth() + 1).padStart(2, '0')}-01`;

    let weekTotal = 0, weekTaken = 0;
    let monthTotal = 0, monthTaken = 0;

    for (const h of db.history) {
      if (h.date >= weekStart && h.date <= todayStr) {
        weekTotal++;
        if (h.status === 'taken') weekTaken++;
      }
      if (h.date >= monthStart && h.date <= todayStr) {
        monthTotal++;
        if (h.status === 'taken') monthTaken++;
      }
    }

    // 连续天数
    let streak = 0;
    const check = new Date(nowDate);
    // 从昨天开始往前数
    check.setDate(check.getDate() - 1);
    while (true) {
      const ds = _fmtDate(check);
      const dayRecords = db.history.filter(h => h.date === ds);
      if (dayRecords.length === 0) break;
      const allTaken = dayRecords.every(h => h.status === 'taken');
      if (!allTaken) break;
      streak++;
      check.setDate(check.getDate() - 1);
    }
    // 如果今天也全勤，+1
    const todayRecords = db.history.filter(h => h.date === todayStr);
    if (todayRecords.length > 0 && todayRecords.every(h => h.status === 'taken')) {
      streak++;
    }

    return {
      weekRate: weekTotal > 0 ? Math.round((weekTaken / weekTotal) * 100) : 0,
      monthRate: monthTotal > 0 ? Math.round((monthTaken / monthTotal) * 100) : 0,
      streak
    };
  }

  // ====== 设置 ======

  function getSettings() {
    const db = read() || initDB();
    return { ...db.settings };
  }

  function saveSettings(s) {
    const db = read() || initDB();
    db.settings = { ...db.settings, ...s };
    write(db);
    return db.settings;
  }

  // ====== 数据导出/导入 ======

  function exportData() {
    const db = read();
    if (!db) return null;
    return JSON.stringify(db, null, 2);
  }

  function importData(jsonStr) {
    try {
      const data = JSON.parse(jsonStr);
      if (data.version && data.medications && data.history) {
        write(data);
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  // ====== 内部维护 ======

  function _pruneHistory() {
    const db = read();
    if (!db) return;
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - HISTORY_DAYS);
    const cutoffStr = _fmtDate(cutoff);
    const before = db.history.length;
    db.history = db.history.filter(h => h.date >= cutoffStr);
    if (db.history.length !== before) write(db);
  }

  function _fmtDate(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  // ====== 公开 API ======

  return {
    initDB,
    getMedications,
    getMedication,
    saveMedication,
    deleteMedication,
    toggleMedication,
    getHistory,
    getHistoryRange,
    getAllHistoryDates,
    logDose,
    updateDoseStatus,
    ensureDailyDoses,
    getStats,
    getSettings,
    saveSettings,
    exportData,
    importData,
    today,
    now
  };
})();
