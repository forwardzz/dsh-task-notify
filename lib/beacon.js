/* dsh-task-notify — 注入到 DSH 渲染端的轻量信标脚本（宿主路由 /dsh-task-notify/beacon.js）
 * 职责很窄：轮询宿主的事件流，有新任务结束就播放提示音；并把「用户回到窗口」告诉宿主。
 * 任务栏闪烁与角标由宿主侧的原生助手做，渲染端拿不到任务栏（见 README）。
 * 注意：设置界面在 lib/client.js（客户端半边，走 /plugins/dsh-task-notify/client.js），两者不要混淆。 */
(function () {
  if (window.__dshTaskNotify) return;
  window.__dshTaskNotify = true;

  var BASE = '/dsh-task-notify';
  var seq = 0;
  var cfg = { sound: true, soundName: 'chime', volume: 0.7, pollMs: 500 };
  var pendingSound = null;
  var unlocked = false;
  var lastFocusSent = 0;

  function post(path) {
    try {
      fetch(BASE + path, { method: 'POST', cache: 'no-store' });
    } catch (e) {}
  }

  // 渲染端播不出来（自动播放被拦、音频设备异常）时，请宿主用 PowerShell SoundPlayer 兜底响一次，
  // 保证「任务完成一定有声音」这条硬要求不被浏览器策略破坏。
  var fallbackSent = 0;
  function reportSoundFailed() {
    var now = Date.now();
    if (now - fallbackSent < 3000) return;
    fallbackSent = now;
    post('/soundfallback');
  }

  function armUnlock() {
    if (armUnlock.armed) return;
    armUnlock.armed = true;
    var run = function () {
      document.removeEventListener('pointerdown', run, true);
      document.removeEventListener('keydown', run, true);
      document.removeEventListener('mousedown', run, true);
      armUnlock.armed = false;
      unlocked = true;
      if (pendingSound) {
        var p = pendingSound;
        pendingSound = null;
        play(p.name, p.volume);
      }
    };
    document.addEventListener('pointerdown', run, true);
    document.addEventListener('keydown', run, true);
    document.addEventListener('mousedown', run, true);
  }

  function play(name, volume) {
    if (!cfg.sound) return;
    try {
      var a = new Audio(BASE + '/sound?id=' + encodeURIComponent(name));
      a.volume = typeof volume === 'number' ? volume : 0.7;
      var pr = a.play();
      if (pr && typeof pr.catch === 'function') {
        pr.catch(function () {
          pendingSound = { name: name, volume: volume };
          armUnlock();
          reportSoundFailed();
        });
      }
    } catch (e) {
      pendingSound = { name: name, volume: volume };
      armUnlock();
      reportSoundFailed();
    }
  }

  function handleEvent(ev) {
    if (!ev || !ev.type) return;
    if (ev.type === 'done' || ev.type === 'error') {
      play(cfg.soundName, cfg.volume);
    }
  }

  function loadConfig() {
    return fetch(BASE + '/config', { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (j && j.ok && j.config) {
          cfg.sound = !!j.config.soundEnabled;
          cfg.soundName = j.config.soundName || 'chime';
          cfg.volume = typeof j.config.volume === 'number' ? j.config.volume : 0.7;
        }
      })
      .catch(function () {});
  }

  var polling = false;
  function poll() {
    if (polling) return;
    polling = true;
    fetch(BASE + '/events?since=' + seq, { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (!j || !j.ok) return;
        seq = j.seq || seq;
        if (j.config) {
          cfg.sound = !!j.config.soundEnabled;
          cfg.soundName = j.config.soundName || 'chime';
          cfg.volume = typeof j.config.volume === 'number' ? j.config.volume : 0.7;
        }
        var list = j.events || [];
        for (var i = 0; i < list.length; i++) handleEvent(list[i]);
      })
      .catch(function () {})
      .then(function () { polling = false; });
  }

  // 用户回到窗口 → 通知宿主立刻清掉角标、停止闪烁
  function reportFocus() {
    var now = Date.now();
    if (now - lastFocusSent < 400) return;
    lastFocusSent = now;
    post('/focus');
  }
  window.addEventListener('focus', reportFocus);
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') reportFocus();
  });
  window.addEventListener('pointerdown', function () { if (window.document.hasFocus()) reportFocus(); }, true);
  window.addEventListener('keydown', reportFocus, true);
  window.addEventListener('mouseup', reportFocus, true);
  window.addEventListener('resize', reportFocus);

  loadConfig().then(function () { poll(); });
  setInterval(poll, cfg.pollMs);
  // 首帧太早时 fetch 会被 CSP/路由挡住，2 秒后再兜一次
  setTimeout(loadConfig, 2000);
})();