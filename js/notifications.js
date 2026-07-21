/**
 * 通知调度模块
 * 全局命名空间: App.Notifications
 *
 * 三层策略：
 * 1. 前台：每30秒轮询检查 → new Notification()
 * 2. 恢复前台：visibilitychange → 补发过期提醒
 * 3. SW：setTimeout 兜底（iOS存活约30秒）
 */
const Notifications = (() => {
  let checkTimer = null;
  let notifiedSet = new Set();   // 防止同一次提醒重复弹出
  let swRegistration = null;

  // ====== 初始化 ======

  async function init() {
    if (!('Notification' in window)) {
      console.log('此浏览器不支持 Notification API');
      return;
    }

    // 检查是否已授权
    if (Notification.permission === 'granted') {
      startPolling();
      return;
    }

    // 首次使用：显示引导弹窗
    if (Notification.permission === 'default') {
      showPermissionPrompt();
    }

    // 监听页面可见性变化
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        // 回到前台：清除已通知标记，重新检查
        notifiedSet.clear();
        checkNow();
        if (!checkTimer) startPolling();
      }
    });
  }

  // ====== 权限引导 ======

  function showPermissionPrompt() {
    const prompt = document.getElementById('notification-prompt');
    if (!prompt) return;
    prompt.classList.remove('hidden');

    document.getElementById('btn-enable-notify').onclick = async () => {
      try {
        const result = await Notification.requestPermission();
        prompt.classList.add('hidden');
        if (result === 'granted') {
          startPolling();
          checkNow();
        }
      } catch {
        prompt.classList.add('hidden');
      }
    };

    document.getElementById('btn-skip-notify').onclick = () => {
      prompt.classList.add('hidden');
    };
  }

  // ====== 前台轮询 ======

  function startPolling() {
    if (checkTimer) return;
    checkNow();
    checkTimer = setInterval(checkNow, 30000); // 每30秒
  }

  function stopPolling() {
    if (checkTimer) {
      clearInterval(checkTimer);
      checkTimer = null;
    }
  }

  function checkNow() {
    if (Notification.permission !== 'granted') return;
    const todayStr = Storage.today();
    const doses = Storage.ensureDailyDoses(todayStr);
    const now = new Date();
    const currentMinutes = now.getHours() * 60 + now.getMinutes();

    for (const dose of doses) {
      if (dose.status !== 'pending') continue;

      const [h, m] = dose.scheduledTime.split(':').map(Number);
      const doseMinutes = h * 60 + m;

      // 在当前分钟 ±1 范围内触发通知
      if (Math.abs(currentMinutes - doseMinutes) <= 1) {
        const key = `${dose.medicationId}|${dose.scheduledTime}|${dose.date}`;
        if (notifiedSet.has(key)) continue;

        const med = Storage.getMedication(dose.medicationId);
        if (!med) continue;

        sendNotification(med, dose);
        notifiedSet.add(key);
      }
    }
  }

  function sendNotification(med, dose) {
    const body = `${med.name} ${med.dosage || ''} — ${dose.scheduledTime}`;
    const tag = `dose-${med.id}-${dose.date}-${dose.scheduledTime}`;

    const n = new Notification('💊 服药提醒', {
      body,
      tag,
      requireInteraction: true,
      icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120"><rect width="120" height="120" rx="24" fill="%2334C759"/><text x="60" y="80" text-anchor="middle" font-size="64">💊</text></svg>',
      vibrate: [200, 100, 200]
    });

    n.onclick = () => {
      window.focus();
      n.close();
    };

    // 5秒后自动关闭
    setTimeout(() => n.close(), 8000);
  }

  // ====== 补发检查（Catcher） ======

  function catchUpMissed() {
    if (Notification.permission !== 'granted') return;
    const todayStr = Storage.today();
    const doses = Storage.ensureDailyDoses(todayStr);
    const now = new Date();
    const currentMinutes = now.getHours() * 60 + now.getMinutes();

    const missed = [];
    for (const dose of doses) {
      if (dose.status !== 'pending') continue;
      const [h, m] = dose.scheduledTime.split(':').map(Number);
      const doseMinutes = h * 60 + m;
      // 超过30分钟的未处理提醒
      if (currentMinutes - doseMinutes > 30) {
        const key = `${dose.medicationId}|${dose.scheduledTime}|${dose.date}`;
        if (!notifiedSet.has(key)) {
          missed.push(dose);
          notifiedSet.add(key);
        }
      }
    }

    if (missed.length > 0) {
      const names = [...new Set(missed.map(d => d.medicationName))].join('、');
      const n = new Notification('⚠️ 漏服提醒', {
        body: `您有 ${missed.length} 次服药未处理：${names}`,
        tag: `catchup-${todayStr}`,
        requireInteraction: true
      });
      n.onclick = () => { window.focus(); n.close(); };
      setTimeout(() => n.close(), 10000);
    }
  }

  // ====== Service Worker 通信 ======

  async function registerSW() {
    if (!('serviceWorker' in navigator)) return;
    try {
      swRegistration = await navigator.serviceWorker.register('./sw.js', { scope: './' });
      console.log('SW 注册成功:', swRegistration.scope);

      // 定期向 SW 发送下次提醒时间
      updateSWTimers();
      setInterval(updateSWTimers, 60000);
    } catch (err) {
      console.warn('SW 注册失败:', err);
    }
  }

  function updateSWTimers() {
    if (!swRegistration) return;
    const todayStr = Storage.today();
    const doses = Storage.ensureDailyDoses(todayStr);
    const now = new Date();
    const currentMinutes = now.getHours() * 60 + now.getMinutes();

    // 找到下一个待处理的提醒
    let nextDose = null;
    let nextMinutes = Infinity;
    for (const dose of doses) {
      if (dose.status !== 'pending') continue;
      const [h, m] = dose.scheduledTime.split(':').map(Number);
      const dm = h * 60 + m;
      if (dm > currentMinutes && dm < nextMinutes) {
        nextMinutes = dm;
        nextDose = dose;
      }
    }

    const delay = nextDose ? (nextMinutes - currentMinutes) * 60 * 1000 : 0;

    if (swRegistration.active) {
      swRegistration.active.postMessage({
        type: 'schedule',
        delay,
        dose: nextDose,
        date: todayStr
      });
    }
  }

  // ====== 公开 API ======

  return {
    init,
    checkNow,
    catchUpMissed,
    registerSW,
    startPolling,
    stopPolling,
    showPermissionPrompt
  };
})();
