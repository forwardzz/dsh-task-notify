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
const SOUNDS = ['chime', 'ding', 'pop']
const BADGES = ['dot', 'check']

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
  'var s=document.createElement("script");s.src="/dsh-task-notify/client.js";' +
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
  if (SOUNDS.indexOf(cfg.soundName) < 0) cfg.soundName = DEFAULTS.soundName
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

    function hostPlaySound() {
      const wav = path.join(ROOT, 'assets', cfg.soundName + '.wav')
      if (!fs.existsSync(wav)) return
      const ps = path.join(
        process.env.SystemRoot || 'C:\\Windows',
        'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe',
      )
      const cmd = '(New-Object Media.SoundPlayer "' + wav.replace(/"/g, '""') + '").PlaySync()'
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
        if (html.indexOf('/dsh-task-notify/client.js') !== -1) return html
        const tag = '<script defer src="/dsh-task-notify/client.js"></script>'
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

    function body(req) {
      return new Promise((resolve) => {
        let raw = ''
        let done = false
        const finish = (v) => { if (!done) { done = true; resolve(v) } }
        req.on('data', (c) => {
          raw += c
          if (raw.length > 65536) { try { req.destroy() } catch (err) {} finish(null) }
        })
        req.on('end', () => finish(raw))
        req.on('error', () => finish(null))
        setTimeout(() => finish(null), 3000)
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
      path: '/dsh-task-notify/client.js',
      handler: (req, res) => {
        let text = ''
        try {
          text = fs.readFileSync(path.join(ROOT, 'lib', 'client.js'), 'utf8')
        } catch (err) {
          text = '/* client.js 读取失败 */'
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
            soundName: SOUNDS.indexOf(cfg.soundName) >= 0 ? cfg.soundName : DEFAULTS.soundName,
            badgeIcon: BADGES.indexOf(cfg.badgeIcon) >= 0 ? cfg.badgeIcon : DEFAULTS.badgeIcon,
          })
          badgePathCache = ''
          helper.badgeMinMs = cfg.badgeMinMs
          helper.setBadgeMin(cfg.badgeMinMs)
          const saved = writeConfig(cfg)
          json(res, { ok: true, saved: saved, config: publicConfig() })
          return
        }
        json(res, { ok: true, config: publicConfig(), path: CONFIG_PATH, sounds: SOUNDS, badges: BADGES })
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

    for (const s of SOUNDS) {
      disposers.push(registerRoute({
        kind: 'exact',
        path: '/dsh-task-notify/sound/' + s + '.wav',
        handler: (req, res) => {
          let buf = soundCache.get(s)
          if (!buf) {
            try {
              buf = fs.readFileSync(path.join(ROOT, 'assets', s + '.wav'))
              soundCache.set(s, buf)
            } catch (err) {
              res.statusCode = 404
              res.end()
              return
            }
          }
          res.statusCode = 200
          res.setHeader('Content-Type', 'audio/wav')
          res.setHeader('Cache-Control', 'public, max-age=86400')
          res.setHeader('Content-Length', String(buf.length))
          res.end(buf)
        },
      }))
    }

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