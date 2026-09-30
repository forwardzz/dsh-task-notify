/* dsh-task-notify — 客户端半边（DSH 设置面板里的「任务提醒」页）
 *
 * 由 dsh-client-modules 从 /plugins/dsh-task-notify/client.js 加载，经 shell 的
 * lazy-CJS 模块表（window.__ModuleLoader__.load）执行。factory 体内是普通 CJS，
 * require() 只能解析平台种子词（react 等）与已注册的客户端 bundle；
 * **任何 require 都必须包 try/catch**，否则工厂抛错会让整个 web shell 起不来。
 *
 * 这里只做一件事：往 settings.section 槽注册一页设置界面，用来选音效、导入自己的音效。
 * 真正的轮询/播放逻辑在宿主注入的 lib/beacon.js 里，与本文件无关。 */
window.__ModuleLoader__.load({
  id: 'dsh-task-notify',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    var React = null;
    try { React = require('react'); } catch (e) { React = null; }

    var BASE = '/dsh-task-notify';
    var ALLOWED = ['wav', 'mp3', 'ogg', 'm4a', 'aac', 'flac', 'webm'];
    var h = React ? React.createElement : null;

    // ------------------------------------------------------------------ 工具
    function getJson(path) {
      return fetch(BASE + path, { cache: 'no-store', credentials: 'same-origin' })
        .then(function (r) { return r.json(); });
    }

    function postJson(path, payload) {
      return fetch(BASE + path, {
        method: 'POST',
        cache: 'no-store',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload || {}),
      }).then(function (r) { return r.json(); });
    }

    function toBase64(buf) {
      var bytes = new Uint8Array(buf);
      var chunk = '';
      var out = '';
      for (var i = 0; i < bytes.length; i++) {
        chunk += String.fromCharCode(bytes[i]);
        if (chunk.length >= 8192) { out += window.btoa(chunk); chunk = ''; }
      }
      if (chunk) out += window.btoa(chunk);
      return out;
    }

    function preview(id) {
      try {
        var a = new window.Audio(BASE + '/sound?id=' + encodeURIComponent(id));
        a.volume = 0.85;
        var p = a.play();
        if (p && typeof p.catch === 'function') p.catch(function () {});
      } catch (e) {}
    }

    // ------------------------------------------------------------------ 样式
    var S = {
      root: { fontSize: 13, lineHeight: 1.7, padding: '2px 0' },
      h: { fontSize: 15, fontWeight: 600, margin: '0 0 2px' },
      hint: { opacity: 0.62, fontSize: 12, margin: '0 0 10px' },
      group: { margin: '14px 0 0' },
      row: { display: 'flex', alignItems: 'center', gap: '8px', padding: '5px 0' },
      list: { border: '1px solid rgba(128,128,128,0.28)', borderRadius: '8px', overflow: 'hidden', margin: '6px 0 2px' },
      item: { display: 'flex', alignItems: 'center', gap: '8px', padding: '7px 10px', borderTop: '1px solid rgba(128,128,128,0.15)' },
      label: { flex: '1 1 auto', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      tag: { fontSize: 11, opacity: 0.55, border: '1px solid rgba(128,128,128,0.3)', borderRadius: '4px', padding: '0 5px' },
      btn: { border: '1px solid rgba(128,128,128,0.38)', borderRadius: '6px', background: 'transparent', color: 'inherit', padding: '2px 9px', cursor: 'pointer', fontSize: 12 },
      btnMain: { border: '1px solid rgba(128,128,128,0.38)', borderRadius: '6px', background: 'rgba(128,128,128,0.14)', color: 'inherit', padding: '4px 14px', cursor: 'pointer', fontSize: 12 },
      input: { border: '1px solid rgba(128,128,128,0.32)', borderRadius: '6px', background: 'transparent', color: 'inherit', padding: '3px 8px', fontSize: 12, minWidth: '150px' },
      err: { color: '#e5484d', fontSize: 12, marginTop: 8, whiteSpace: 'pre-wrap' },
      ok: { color: '#30a46c', fontSize: 12, marginTop: 8 },
    };

    function row(key, children) {
      return h('div', { key: key, style: S.row }, children);
    }

    function toggle(label, checked, onChange) {
      return h('label', { style: { display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer' } }, [
        h('input', { type: 'checkbox', checked: !!checked, onChange: function (e) { onChange(e.target.checked); } }),
        h('span', null, label),
      ]);
    }

    // ------------------------------------------------------------------ 设置页
    function Section() {
      var st = React.useState(null);
      var data = st[0];
      var setData = st[1];
      var er = React.useState('');
      var err = er[0];
      var setErr = er[1];
      var bs = React.useState(false);
      var busy = bs[0];
      var setBusy = bs[1];
      var nm = React.useState('');
      var importName = nm[0];
      var setImportName = nm[1];
      var fileRef = React.useRef(null);

      function reload() {
        return getJson('/config')
          .then(function (j) {
            if (j && j.ok) setData({ config: j.config || {}, sounds: j.sounds || [] });
            else setErr((j && j.error) || '读取配置失败');
          })
          .catch(function (e) { setErr('读取配置失败：' + String((e && e.message) || e)); });
      }

      React.useEffect(function () { reload(); }, []);

      function patch(p) {
        setBusy(true);
        return postJson('/config', p)
          .then(function (j) {
            if (j && j.ok) {
              setErr('');
              setData(function (prev) {
                return prev ? Object.assign({}, prev, { config: j.config || prev.config }) : prev;
              });
            } else setErr((j && j.error) || '保存失败');
          })
          .catch(function (e) { setErr('保存失败：' + String((e && e.message) || e)); })
          .then(function () { setBusy(false); });
      }

      function onPick() {
        if (fileRef.current) fileRef.current.click();
      }

      function onFile(ev) {
        var f = ev.target.files && ev.target.files[0];
        try { ev.target.value = ''; } catch (e) {}
        if (!f) return;
        var ext = (f.name.split('.').pop() || '').toLowerCase();
        if (ALLOWED.indexOf(ext) < 0) {
          setErr('不支持的格式 “.' + ext + '”，支持：' + ALLOWED.join(' / '));
          return;
        }
        if (f.size > 8 * 1024 * 1024) { setErr('文件太大（上限 8 MB）'); return; }
        var base = f.name.replace(/\.[^./\\]+$/, '');
        var wanted = (importName || base).trim() || base;
        var reader = new window.FileReader();
        reader.onload = function () {
          setBusy(true);
          setErr('');
          postJson('/sounds/import', { name: wanted, ext: ext, data: toBase64(reader.result) })
            .then(function (j) {
              if (!j || !j.ok) { setErr((j && j.error) || '导入失败'); return null; }
              setImportName('');
              return reload().then(function () {
                if (j.sound && j.sound.id) return patch({ soundName: j.sound.id });
                return null;
              });
            })
            .catch(function (e) { setErr('导入失败：' + String((e && e.message) || e)); })
            .then(function () { setBusy(false); });
        };
        reader.onerror = function () { setErr('读取文件失败'); };
        reader.readAsArrayBuffer(f);
      }

      function remove(id, label) {
        if (!window.confirm('删除音效「' + label + '」？此操作不可撤销。')) return;
        setBusy(true);
        postJson('/sounds/delete', { id: id })
          .then(function (j) {
            if (!j || !j.ok) { setErr((j && j.error) || '删除失败'); return null; }
            return reload();
          })
          .catch(function (e) { setErr('删除失败：' + String((e && e.message) || e)); })
          .then(function () { setBusy(false); });
      }

      if (!data) {
        return h('div', { style: S.root }, [h('div', { style: S.h }, '任务提醒'), h('div', { style: S.hint }, '读取中…'), err ? h('div', { style: S.err }, err) : null]);
      }

      var cfg = data.config || {};
      var sounds = data.sounds || [];
      var children = [];

      children.push(h('div', { key: 'title', style: S.h }, '任务提醒'));
      children.push(h('div', { key: 'hint', style: S.hint }, '任务完成后播放提示音，并让任务栏图标闪烁 + 显示角标；回到 DSH 窗口后自动停止。'));

      // ---- 提醒时机 ----
      children.push(h('div', { key: 'when', style: S.group }, [
        h('div', { style: { opacity: 0.62, fontSize: 12 } }, '提醒时机'),
        row('pm', [toggle('等我选择 / 批准时也提醒', cfg.promptEnabled !== false, function (v) { patch({ promptEnabled: v }); })]),
        h('div', { style: { opacity: 0.5, fontSize: 12, margin: '2px 0 0' } },
          'DSH 停下来等你点一下时（选项、计划复核、批准）同样响铃并闪任务栏；能自己决出结果的请求不会打扰你。'),
      ]));

      // ---- 提示音 ----
      children.push(h('div', { key: 'sound', style: S.group }, [
        row('sw', [toggle('启用提示音', cfg.soundEnabled, function (v) { patch({ soundEnabled: v }); })]),
        row('vol', [
          h('span', { style: { width: '56px' } }, '音量'),
          h('input', {
            type: 'range', min: '0', max: '1', step: '0.05',
            value: typeof cfg.volume === 'number' ? cfg.volume : 0.7,
            disabled: busy || !cfg.soundEnabled,
            style: { flex: '1 1 auto', maxWidth: '220px' },
            onChange: function (e) { patch({ volume: Number(e.target.value) }); },
          }),
          h('span', { style: { width: '42px', textAlign: 'right', opacity: 0.7 } },
            Math.round((typeof cfg.volume === 'number' ? cfg.volume : 0.7) * 100) + '%'),
        ]),
        h('div', { style: { marginTop: '6px', opacity: 0.62, fontSize: 12 } }, '音效（点▶试听，选中即生效）'),
        h('div', { style: S.list }, sounds.map(function (s, i) {
          var kids = [
            h('input', {
              key: 'r',
              type: 'radio',
              name: 'dsh-task-notify-sound',
              checked: cfg.soundName === s.id,
              disabled: busy,
              onChange: function () { patch({ soundName: s.id }); },
            }),
            h('span', { key: 'l', style: S.label }, s.label || s.id),
            s.builtin ? h('span', { key: 't', style: S.tag }, '内置') : h('span', { key: 't', style: S.tag }, s.ext || ''),
          ];
          kids.push(h('button', {
            key: 'p', type: 'button', style: S.btn, disabled: busy,
            onClick: function () { preview(s.id); },
          }, '▶ 试听'));
          if (!s.builtin) {
            kids.push(h('button', {
              key: 'd', type: 'button', style: S.btn, disabled: busy,
              onClick: function () { remove(s.id, s.label || s.id); },
            }, '删除'));
          }
          return h('div', {
            key: 'i' + i,
            style: Object.assign({}, S.item, i === 0 ? { borderTop: 'none' } : {}),
          }, kids);
        })),
      ]));

      // ---- 导入 ----
      children.push(h('div', { key: 'import', style: S.group }, [
        h('div', { style: { opacity: 0.62, fontSize: 12 } }, '导入自己的音效（wav / mp3 / ogg / m4a / aac / flac / webm，≤ 8 MB）'),
        row('imp', [
          h('input', {
            style: S.input,
            type: 'text',
            placeholder: '显示名称（留空用文件名）',
            value: importName,
            disabled: busy,
            onChange: function (e) { setImportName(e.target.value); },
          }),
          h('button', { type: 'button', style: S.btnMain, disabled: busy, onClick: onPick }, busy ? '处理中…' : '选择文件并导入'),
          h('input', {
            ref: fileRef, type: 'file', accept: 'audio/*,.wav,.mp3,.ogg,.m4a,.aac,.flac,.webm',
            style: { display: 'none' }, onChange: onFile,
          }),
        ]),
      ]));

      // ---- 任务栏 ----
      children.push(h('div', { key: 'bar', style: S.group }, [
        h('div', { style: { opacity: 0.62, fontSize: 12 } }, '任务栏'),
        row('fl', [toggle('图标闪烁（持续到你回到 DSH）', cfg.flashEnabled, function (v) { patch({ flashEnabled: v }); })]),
        row('bd', [toggle('显示角标', cfg.badgeEnabled, function (v) { patch({ badgeEnabled: v }); })]),
        row('bi', [
          h('span', { style: { width: '56px' } }, '角标样式'),
          h('select', {
            value: cfg.badgeIcon || 'dot',
            disabled: busy || !cfg.badgeEnabled,
            style: S.input,
            onChange: function (e) { patch({ badgeIcon: e.target.value }); },
          }, [
            h('option', { key: 'dot', value: 'dot' }, '红点'),
            h('option', { key: 'check', value: 'check' }, '绿勾'),
          ]),
        ]),
      ]));

      if (err) children.push(h('div', { key: 'err', style: S.err }, err));
      children.push(h('div', { key: 'path', style: { marginTop: '12px', opacity: 0.45, fontSize: 11 } },
        '配置保存在 ~/.dsh/dsh-task-notify.json，自己导入的音效在 ~/.dsh/dsh-task-notify/sounds/。'));

      return h('div', { style: S.root }, children);
    }

    // ------------------------------------------------------------------ 插件体
    var inject = ['slots'];

    function apply(ctx) {
      var off = [];
      try {
        off.push(ctx.slots.inject('settings.section', function () {
          return ctx.slots.register({
            name: 'settings.section',
            id: 'task-notify',
            order: 12,
            label: '任务提醒',
          }, Section);
        }));
      } catch (e) {
        try { console.error('[dsh-task-notify] 设置页注册失败', e); } catch (e2) {}
      }
      try {
        if (typeof ctx.effect === 'function') {
          ctx.effect(function () {
            return function () {
              for (var i = 0; i < off.length; i++) { try { off[i](); } catch (e) {} }
            };
          });
        }
      } catch (e) {}
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});