// dsh-task-notify — DSH 任务完成提醒
//
// 做三件事：
//   1. 提示音          —— 注入到渲染端的客户端脚本轮询事件流后播放（宿主兜底播放）
//   2. 任务栏图标闪烁  —— 进程外 Win32 FlashWindowEx（见 native/TaskbarNotify.cs）
//   3. 任务栏图标角标  —— 进程外 ITaskbarList3::SetOverlayIcon；窗口回到前台自动消失
//
// 为什么任务栏部分要绕这么大一圈：桌面端插件宿主以 ELECTRON_RUN_AS_NODE=1 运行在
// Electron 主进程的子进程里，require('electron') 拿不到 BrowserWindow，
// flashFrame()/setOverlayIcon() 都不可用；preload 暴露的 dshDesktop API 也没有相关能力。
// 详见 README.md。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { TaskbarHelper } from './native.js'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const CONFIG_PATH = path.join(os.homedir(), '.dsh', 'dsh-task-notify.json')
const BADGES = ['dot', 'check']

// 内置音效（assets/*.wav）。用户导入的音效存在 CUSTOM_DIR 下，id 形如 `c:<slug>`。
const BUILTIN_SOUNDS = [
  { id: 'chime', label: '清脆铃声', file: 'chime.wav', ext: 'wav', mime: 'audio/wav' },
  { id: 'ding', label: '叮咚', file: 'ding.wav', ext: 'wav', mime: 'audio/wav' },
  { id: 'pop', label: '气泡', file: 'pop.wav', ext: 'wav', mime: 'audio/wav' },
]
const CUSTOM_DIR = path.join(os.homedir(), '.dsh', 'dsh-task-notify', 'sounds')
const AUDIO_MIME = {
  wav: 'audio/wav', mp3: 'audio/mpeg', ogg: 'audio/ogg', m4a: 'audio/mp4',
  aac: 'audio/aac', flac: 'audio/flac', webm: 'audio/webm',
}
const IMPORT_MAX_BYTES = 8 * 1024 * 1024
const SLUG_RE = /^[\p{L}\p{N}][\p{L}\p{N}_-]{0,39}$/u

const DEFAULTS = {
  enabled: true,
  soundEnabled: true,
  soundName: 'chime',
  volume: 0.7,
  flashEnabled: true,
  badgeEnabled: true,
  badgeIcon: 'dot',
  badgeClearOnFocus: true,
  badgeMinMs: 1500,
  minTurnMs: 0,
  debounceMs: 1500,
  cooldownMs: 2000,
}

// 桌面端 index.html 由 Electron 主进程静态提供，只应用 IPC 传来的
// webserver/index-inject 结构化行；等主界面（composer）出现后再挂脚本，
// 避免过早 fetch 被拦。
const BOOTSTRAP =
  '(function(){if(window.__dshTaskNotify||window.__dshTaskNotifyBoot)return;window.__dshTaskNotifyBoot=1;' +
  'var n=0;var t=setInterval(function(){' +
  'var r=document.getElementById("root");' +
  'if(r&&(r.querySelector("textarea")||r.querySelector(\'[contenteditable="true"]\'))){' +
  'clearInterval(t);if(window.__dshTaskNotify)return;' +
  'var s=document.createElement("script");s.src="/dsh-task-notify/beacon.js";' +
  'document.body.appendChild(s);return}' +
  'if(++n>240)clearInterval(t)},500)})()'

function readConfig() {
  let raw = {}
  try {
    raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
  } catch (err) {
    raw = {}
  }
  const cfg = Object.assign({}, DEFAULTS, raw && typeof raw === 'object' ? raw : {})
  if (!resolveSound(cfg.soundName)) cfg.soundName = DEFAULTS.soundName
  if (BADGES.indexOf(cfg.badgeIcon) < 0) cfg.badgeIcon = DEFAULTS.badgeIcon
  cfg.volume = Math.max(0, Math.min(1, Number(cfg.volume)))
  if (!Number.isFinite(cfg.volume)) cfg.volume = DEFAULTS.volume
  cfg.debounceMs = Math.max(200, Math.min(10000, Number(cfg.debounceMs) || DEFAULTS.debounceMs))
  cfg.cooldownMs = Math.max(0, Math.min(60000, Number(cfg.cooldownMs) || DEFAULTS.cooldownMs))
  cfg.minTurnMs = Math.max(0, Number(cfg.minTurnMs) || 0)
  return cfg
}

function writeConfig(cfg) {
  try {
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true })
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8')
    return true
  } catch (err) {
    return false
  }
}

// ---------------------------------------------------------------- 音效库
// 内置音效来自 assets/*.wav；用户导入的音效放在 ~/.dsh/dsh-task-notify/sounds/<slug>.<ext>，
// 配置里用 id `c:<slug>` 引用。id 全程由 slug 正则约束，杜绝路径穿越。

function slugifySoundName(name) {
  let s = String(name == null ? '' : name).trim().toLowerCase()
  s = s.replace(/[^\p{L}\p{N}_-]+/gu, '-').replace(/-{2,}/g, '-').replace(/^[-_]+/, '').replace(/[-_]+$/, '')
  s = s.slice(0, 40)
  if (!s || !SLUG_RE.test(s)) return 'sound'
  return s
}

function customSoundFile(slug) {
  for (const ext of Object.keys(AUDIO_MIME)) {
    const p = path.join(CUSTOM_DIR, slug + '.' + ext)
    if (fs.existsSync(p)) return { path: p, ext: ext }
  }
  return null
}

function listCustomSounds() {
  let names = []
  try {
    names = fs.readdirSync(CUSTOM_DIR)
  } catch (err) {
    return []
  }
  const out = []
  for (const f of names) {
    const ext = path.extname(f).slice(1).toLowerCase()
    if (!AUDIO_MIME[ext]) continue
    const slug = path.basename(f, path.extname(f))
    if (!SLUG_RE.test(slug)) continue
    let bytes = 0
    try { bytes = fs.statSync(path.join(CUSTOM_DIR, f)).size } catch (err) {}
    out.push({ id: 'c:' + slug, label: slug, builtin: false, ext: ext, mime: AUDIO_MIME[ext], bytes: bytes })
  }
  out.sort((a, b) => a.label.localeCompare(b.label))
  return out
}

function soundCatalog() {
  return BUILTIN_SOUNDS
    .map((s) => ({ id: s.id, label: s.label, builtin: true, ext: s.ext, mime: s.mime }))
    .concat(listCustomSounds())
}

function resolveSound(id) {
  if (typeof id !== 'string') return null
  const b = BUILTIN_SOUNDS.find((s) => s.id === id)
  if (b) {
    const p = path.join(ROOT, 'assets', b.file)
    return fs.existsSync(p) ? { path: p, mime: b.mime, ext: b.ext, builtin: true, label: b.label } : null
  }
  if (id.slice(0, 2) !== 'c:') return null
  const slug = id.slice(2)
  if (!SLUG_RE.test(slug)) return null
  const f = customSoundFile(slug)
  if (!f) return null
  return { path: f.path, mime: AUDIO_MIME[f.ext], ext: f.ext, builtin: false, label: slug }
}

function importSound(name, ext, dataB64) {
  const e = String(ext || '').toLowerCase()
  if (!AUDIO_MIME[e]) return { ok: false, error: '不支持的格式：' + e }
  let buf = null
  try {
    buf = Buffer.from(String(dataB64 || ''), 'base64')
  } catch (err) {
    return { ok: false, error: '音频数据无法解码' }
  }
  if (!buf || !buf.length) return { ok: false, error: '音频数据为空' }
  if (buf.length > IMPORT_MAX_BYTES) {
    return { ok: false, error: '文件超过 ' + Math.round(IMPORT_MAX_BYTES / 1048576) + ' MB' }
  }
  let slug = slugifySoundName(name)
  let n = 2
  while (customSoundFile(slug)) {
    const suffix = '-' + n
    slug = slug.slice(0, 40 - suffix.length) + suffix
    n += 1
    if (n > 999) return { ok: false, error: '同名音效太多' }
  }
  try {
    fs.mkdirSync(CUSTOM_DIR, { recursive: true })
    fs.writeFileSync(path.join(CUSTOM_DIR, slug + '.' + e), buf)
  } catch (err) {
    return { ok: false, error: '写入失败：' + String((err && err.message) || err) }
  }
  return { ok: true, sound: { id: 'c:' + slug, label: slug, builtin: false, ext: e, mime: AUDIO_MIME[e], bytes: buf.length } }
}

function deleteSound(id) {
  const slug = String(id || '').slice(2)
  if (String(id || '').slice(0, 2) !== 'c:' || !SLUG_RE.test(slug)) {
    return { ok: false, error: '只能删除自己导入的音效' }
  }
  const f = customSoundFile(slug)
  if (!f) return { ok: false, error: '音效不存在' }
  const root = path.resolve(CUSTOM_DIR) + path.sep
  const target = path.resolve(f.path)
  if (target.slice(0, root.length) !== root) return { ok: false, error: '路径非法' }
  try {
    fs.rmSync(target)
  } catch (err) {
    return { ok: false, error: '删除失败：' + String((err && err.message) || err) }
  }
  return { ok: true }
}

export const name = 'dsh-task-notify'
export const inject = ['webServer', 'connection']

export default {
  name: 'dsh-task-notify',
  inject: ['webServer', 'connection'],
  apply(ctx) {
    const disposers = []
    let cfg = readConfig()
    const listeners = []
    const log = (msg) => {
      try { console.log(msg) } catch (err) {}
    }

    if (!cfg.enabled) {
      log('[dsh-task-notify] 已在配置里禁用（' + CONFIG_PATH + '），不注册任何行为')
      return
    }

    // ---------------------------------------------------------- 状态
    let seq = 0
    const events = []
    let lastClientPoll = 0
    let lastNotifyAt = 0
    let lastBusyAt = 0
    let firstBusyAt = 0
    let pendingEnded = false
    let pendingTimer = null
    const soundCache = new Map()
    let badgePathCache = ''

    const helper = new TaskbarHelper({
      root: ROOT,
      log,
      badgeMinMs: cfg.badgeMinMs,
      onFocus: () => {
        // 原生助手自己也会清，这里只做一次兜底，保证「回来看窗口」一定消干净
        if (cfg.badgeClearOnFocus) helper.clearBadge()
      },
    })
    helper.start()

    function badgePath() {
      if (badgePathCache) return badgePathCache
      const p = path.join(ROOT, 'assets', 'badge-' + cfg.badgeIcon + '.ico')
      badgePathCache = fs.existsSync(p) ? p : path.join(ROOT, 'assets', 'badge-dot.ico')
      return badgePathCache
    }

    function publicConfig() {
      return {
        soundEnabled: cfg.soundEnabled,
        soundName: cfg.soundName,
        volume: cfg.volume,
        flashEnabled: cfg.flashEnabled,
        badgeEnabled: cfg.badgeEnabled,
        badgeIcon: cfg.badgeIcon,
        badgeMinMs: cfg.badgeMinMs,
        debounceMs: cfg.debounceMs,
      }
    }

    // -------------------------------------------------- 事件汇聚 → 通知
    function markBusy() {
      const now = Date.now()
      lastBusyAt = now
      if (!firstBusyAt) firstBusyAt = now
      if (pendingEnded) schedule()
    }

    function markTurnEnd() {
      lastBusyAt = Date.now()
      pendingEnded = true
      schedule()
    }

    function schedule() {
      if (pendingTimer) clearTimeout(pendingTimer)
      pendingTimer = setTimeout(fire, cfg.debounceMs)
      if (pendingTimer.unref) pendingTimer.unref()
    }

    function fire() {
      pendingTimer = null
      if (!pendingEnded) return
      const now = Date.now()
      // 还有活动就继续等（子代理 / 多会话并行时不要提前报喜）
      if (now - lastBusyAt < cfg.debounceMs) {
        schedule()
        return
      }
      const busyFor = firstBusyAt ? now - firstBusyAt : 0
      pendingEnded = false
      firstBusyAt = 0
      if (cfg.minTurnMs > 0 && busyFor < cfg.minTurnMs) {
        maybeLog('本轮耗时 ' + busyFor + 'ms < minTurnMs=' + cfg.minTurnMs + 'ms，跳过提醒')
        return
      }
      if (now - lastNotifyAt < cfg.cooldownMs) {
        maybeLog('距上次提醒不足 ' + cfg.cooldownMs + 'ms，跳过')
        return
      }
      notify('done', { busyFor })
    }

    function maybeLog(msg) {
      log('[dsh-task-notify] ' + msg)
    }

    // 宿主兜底发声：渲染端播不出来时用系统播放器响一次。
    // .wav 走 Media.SoundPlayer（同步播放）；其它格式走 WPF MediaPlayer（无同步 API，播一段再退出）。
    function hostPlaySound() {
      const snd = resolveSound(cfg.soundName)
      if (!snd) return
      const ps = path.join(
        process.env.SystemRoot || 'C:\\Windows',
        'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe',
      )
      const p = snd.path.replace(/'/g, "''")
      const cmd = snd.ext === 'wav'
        ? '(New-Object Media.SoundPlayer \'' + p + '\').PlaySync()'
        : 'try{Add-Type -AssemblyName PresentationCore;$mp=New-Object System.Windows.Media.MediaPlayer;' +
          '$mp.Open([Uri]\'' + p + '\');$mp.Play();Start-Sleep -Seconds 6;$mp.Close()}catch{}'
      try {
        const c = spawn(ps, ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', cmd], {
          stdio: 'ignore',
          windowsHide: true,
          detached: true,
        })
        c.unref()
      } catch (err) {}
    }

    function notify(kind, extra) {
      const now = Date.now()
      lastNotifyAt = now
      seq += 1
      const ev = { seq: seq, type: kind, ts: now }
      events.push(ev)
      if (events.length > 100) events.splice(0, events.length - 100)

      if (cfg.flashEnabled) helper.flash()
      if (cfg.badgeEnabled) helper.setBadge(badgePath())
      // 渲染端脚本没在轮询（未注入/被拦）时由宿主兜底发声，避免完全没声音
      if (cfg.soundEnabled && now - lastClientPoll > 8000) hostPlaySound()

      maybeLog('任务结束提醒 #' + seq + ' kind=' + kind +
        (extra && extra.busyFor ? ' 耗时=' + extra.busyFor + 'ms' : '') +
        ' helper=' + (helper.ready ? 'ready' : (helper.lastError || '未就绪')))
    }

    // 任何会话事件都算“还在干活”，排除 turn/end
    listeners.push(ctx.on('session/event', (session, event) => {
      if (!event || !event.type) return
      if (event.type === 'turn/end') markTurnEnd()
      else markBusy()
    }))
    listeners.push(ctx.on('api-session/status', (sessionId, running) => {
      if (running) markBusy()
    }))
    listeners.push(ctx.on('agent/status', (payload) => {
      try {
        if (payload && payload.status === 'running') markBusy()
      } catch (err) {}
    }))

    // -------------------------------------------------- 注入客户端脚本
    function pushIndexRow(table) {
      if (!Array.isArray(table)) return
      for (const row of table) {
        if (row && row.kind === 'script' && row.text === BOOTSTRAP) return
      }
      table.push({ kind: 'script', placement: 'body', text: BOOTSTRAP })
    }
    try { ctx.on('webserver/index-inject', pushIndexRow) } catch (err) {}
    try {
      ctx.inject(['webServer'], (webCtx) => webCtx.on('webserver/index-inject', pushIndexRow))
    } catch (err) {}
    try {
      disposers.push(ctx.webServer.tapIndex((html) => {
        if (html.indexOf('/dsh-task-notify/beacon.js') !== -1) return html
        const tag = '<script defer src="/dsh-task-notify/beacon.js"></script>'
        if (html.indexOf('</body>') !== -1) return html.replace('</body>', tag + '</body>')
        return html + tag
      }))
    } catch (err) {}

    // -------------------------------------------------- HTTP 路由
    function rejected(req, res) {
      try {
        const conn = ctx.get('connection') || ctx.connection
        if (!conn || typeof conn.requestRejection !== 'function') return false
        const code = conn.requestRejection(req)
        if (code === undefined || code === null || code === false) return false
        res.statusCode = typeof code === 'number' ? code : 403
        res.end()
        return true
      } catch (err) {
        return false
      }
    }

    function body(req, limit) {
      const max = limit || 65536
      return new Promise((resolve) => {
        let raw = ''
        let done = false
        const finish = (v) => { if (!done) { done = true; resolve(v) } }
        req.on('data', (c) => {
          raw += c
          if (raw.length > max) { try { req.destroy() } catch (err) {} finish(null) }
        })
        req.on('end', () => finish(raw))
        req.on('error', () => finish(null))
        setTimeout(() => finish(null), max > 100000 ? 20000 : 3000)
      })
    }

    function json(res, obj, code) {
      res.statusCode = code || 200
      res.setHeader('Content-Type', 'application/json; charset=utf-8')
      res.setHeader('Cache-Control', 'no-store')
      res.end(JSON.stringify(obj))
    }

    function registerRoute(route) {
      const inner = route.handler
      const wrapped = Object.assign({}, route, {
        handler: async (req, res) => {
          if (rejected(req, res)) return
          try {
            return await inner(req, res)
          } catch (err) {
            try {
              res.statusCode = 500
              res.setHeader('Content-Type', 'application/json; charset=utf-8')
              res.end(JSON.stringify({ ok: false, error: String(err && err.message || err) }))
            } catch (err2) {}
          }
        },
      })
      return ctx.webServer.register(wrapped)
    }

    function query(req) {
      try {
        return new URL(req.url, 'http://127.0.0.1').searchParams
      } catch (err) {
        return new URLSearchParams()
      }
    }

    disposers.push(registerRoute({
      kind: 'exact',
      path: '/dsh-task-notify/beacon.js',
      handler: (req, res) => {
        let text = ''
        try {
          text = fs.readFileSync(path.join(ROOT, 'lib', 'beacon.js'), 'utf8')
        } catch (err) {
          text = '/* beacon.js 读取失败 */'
        }
        res.statusCode = 200
        res.setHeader('Content-Type', 'application/javascript; charset=utf-8')
        res.setHeader('Cache-Control', 'no-store')
        res.end(text)
      },
    }))

    disposers.push(registerRoute({
      kind: 'exact',
      path: '/dsh-task-notify/events',
      handler: (req, res) => {
        lastClientPoll = Date.now()
        const since = Number(query(req).get('since')) || 0
        json(res, {
          ok: true,
          seq: seq,
          serverTime: lastClientPoll,
          events: events.filter((e) => e.seq > since),
          config: publicConfig(),
        })
      },
    }))

    disposers.push(registerRoute({
      kind: 'exact',
      path: '/dsh-task-notify/config',
      handler: async (req, res) => {
        if (req.method === 'POST') {
          const raw = await body(req)
          let patch = null
          try { patch = JSON.parse(raw) } catch (err) { patch = null }
          if (!patch || typeof patch !== 'object') {
            json(res, { ok: false, error: '无效 JSON' }, 400)
            return
          }
          const allowed = ['soundEnabled', 'soundName', 'volume', 'flashEnabled',
            'badgeEnabled', 'badgeIcon', 'badgeClearOnFocus', 'badgeMinMs', 'minTurnMs',
            'debounceMs', 'cooldownMs']
          for (const k of allowed) {
            if (k in patch) cfg[k] = patch[k]
          }
          cfg = Object.assign({}, cfg, {
            soundName: resolveSound(cfg.soundName) ? cfg.soundName : DEFAULTS.soundName,
            badgeIcon: BADGES.indexOf(cfg.badgeIcon) >= 0 ? cfg.badgeIcon : DEFAULTS.badgeIcon,
          })
          badgePathCache = ''
          helper.badgeMinMs = cfg.badgeMinMs
          helper.setBadgeMin(cfg.badgeMinMs)
          const saved = writeConfig(cfg)
          json(res, { ok: true, saved: saved, config: publicConfig() })
          return
        }
        json(res, { ok: true, config: publicConfig(), path: CONFIG_PATH, sounds: soundCatalog(), badges: BADGES, soundsDir: CUSTOM_DIR })
      },
    }))

    disposers.push(registerRoute({
      kind: 'exact',
      path: '/dsh-task-notify/focus',
      handler: (req, res) => {
        if (cfg.badgeClearOnFocus) helper.clearBadge()
        helper.stopFlash()
        json(res, { ok: true })
      },
    }))

    // 渲染端报告「我播不出声」→ 宿主用 PowerShell SoundPlayer 兜底
    disposers.push(registerRoute({
      kind: 'exact',
      path: '/dsh-task-notify/soundfallback',
      handler: (req, res) => {
        if (cfg.enabled && cfg.soundEnabled) hostPlaySound()
        json(res, { ok: true })
      },
    }))

    disposers.push(registerRoute({
      kind: 'exact',
      path: '/dsh-task-notify/test',
      handler: (req, res) => {
        notify('done', { busyFor: 0 })
        json(res, { ok: true, helper: { ready: helper.ready, error: helper.lastError } })
      },
    }))

    // 播放用音频：/dsh-task-notify/sound?id=<chime|ding|pop|c:slug>
    disposers.push(registerRoute({
      kind: 'exact',
      path: '/dsh-task-notify/sound',
      handler: (req, res) => {
        const snd = resolveSound(query(req).get('id'))
        if (!snd) {
          res.statusCode = 404
          res.setHeader('Content-Type', 'application/json; charset=utf-8')
          res.end(JSON.stringify({ ok: false, error: '音效不存在' }))
          return
        }
        let buf = snd.builtin ? soundCache.get(snd.path) : null
        if (!buf) {
          try {
            buf = fs.readFileSync(snd.path)
          } catch (err) {
            res.statusCode = 404
            res.end()
            return
          }
          if (snd.builtin) soundCache.set(snd.path, buf)
        }
        res.statusCode = 200
        res.setHeader('Content-Type', snd.mime)
        res.setHeader('Cache-Control', snd.builtin ? 'public, max-age=86400' : 'no-store')
        res.setHeader('Content-Length', String(buf.length))
        res.end(buf)
      },
    }))

    // 音效清单（内置 + 用户导入）
    disposers.push(registerRoute({
      kind: 'exact',
      path: '/dsh-task-notify/sounds',
      handler: (req, res) => {
        json(res, {
          ok: true,
          sounds: soundCatalog(),
          current: cfg.soundName,
          dir: CUSTOM_DIR,
          maxBytes: IMPORT_MAX_BYTES,
          formats: Object.keys(AUDIO_MIME),
        })
      },
    }))

    // 导入音效：{ name, ext, data(base64) }
    disposers.push(registerRoute({
      kind: 'exact',
      path: '/dsh-task-notify/sounds/import',
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          json(res, { ok: false, error: '需要 POST' }, 405)
          return
        }
        const raw = await body(req, IMPORT_MAX_BYTES * 2)
        let payload = null
        try { payload = JSON.parse(raw) } catch (err) { payload = null }
        if (!payload || typeof payload !== 'object') {
          json(res, { ok: false, error: '无效 JSON（或文件过大）' }, 400)
          return
        }
        const r = importSound(payload.name, payload.ext, payload.data)
        if (!r.ok) {
          json(res, { ok: false, error: r.error }, 400)
          return
        }
        maybeLog('已导入音效 ' + r.sound.id + '（' + r.sound.bytes + ' B）')
        json(res, { ok: true, sound: r.sound, sounds: soundCatalog() })
      },
    }))

    // 删除自己导入的音效：{ id }
    disposers.push(registerRoute({
      kind: 'exact',
      path: '/dsh-task-notify/sounds/delete',
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          json(res, { ok: false, error: '需要 POST' }, 405)
          return
        }
        const raw = await body(req)
        let payload = null
        try { payload = JSON.parse(raw) } catch (err) { payload = null }
        if (!payload || typeof payload !== 'object') {
          json(res, { ok: false, error: '无效 JSON' }, 400)
          return
        }
        const r = deleteSound(payload.id)
        if (!r.ok) {
          json(res, { ok: false, error: r.error }, 400)
          return
        }
        // 删掉的正是当前音效 → 回到默认，避免配置指向不存在的文件
        if (cfg.soundName === payload.id) {
          cfg = Object.assign({}, cfg, { soundName: DEFAULTS.soundName })
          writeConfig(cfg)
        }
        maybeLog('已删除音效 ' + payload.id)
        json(res, { ok: true, config: publicConfig(), sounds: soundCatalog() })
      },
    }))

    listeners.push(() => {})

    ctx.effect(() => () => {
      if (pendingTimer) clearTimeout(pendingTimer)
      for (const d of disposers) {
        try { d() } catch (err) {}
      }
      try { helper.dispose() } catch (err) {}
    })

    maybeLog('已加载：配置 ' + CONFIG_PATH + '；原生助手 ' +
      (helper.ready ? '就绪' : '启动中'))
  },
}