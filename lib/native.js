// lib/native.js — 与常驻 Win32 助手进程通信。
//
// 插件宿主进程以 ELECTRON_RUN_AS_NODE=1 跑在 Electron 主进程的子进程里，
// require('electron') 拿不到 BrowserWindow，flashFrame()/setOverlayIcon() 都不可用。
// 所以在进程外维护一个常驻小 exe，通过 stdin 发命令、stdout 收事件。
//
// 助手能力：FlashWindowEx 闪烁 + ITaskbarList3::SetOverlayIcon 角标，
// 并在窗口进入前台时自动清除角标、停止闪烁（即“用户回来看窗口了就消掉”）。

import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const CSC_CANDIDATES = [
  'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe',
  'C:\\Windows\\Microsoft.NET\\Framework\\v4.0.30319\\csc.exe',
  'C:\\Windows\\Microsoft.NET\\Framework64\\v2.0.50727\\csc.exe',
  'C:\\Windows\\Microsoft.NET\\Framework\\v2.0.50727\\csc.exe',
]

const BADGE_TITLE = 'DSH 任务完成'

export class TaskbarHelper {
  /**
   * @param {{ root: string, log: (msg: string, extra?: object) => void, onFocus?: () => void }} opts
   */
  constructor(opts) {
    this.root = opts.root
    this.log = opts.log || (() => {})
    this.onFocus = opts.onFocus || (() => {})
    this.badgeMinMs = typeof opts.badgeMinMs === 'number' ? opts.badgeMinMs : 1200
    this.src = path.join(this.root, 'native', 'TaskbarNotify.cs')
    this.binDir = path.join(this.root, 'native', 'bin')
    this.exe = path.join(this.binDir, 'dsh-taskbar-helper.exe')
    this.child = null
    this.ready = false
    this.disposed = false
    this.lastError = null
    this.restarts = 0
    this.restartTimer = null
  }

  /** 按需编译；.cs 比 exe 新时重新编译。返回 null 表示成功，否则返回错误文本。 */
  build() {
    try {
      if (!fs.existsSync(this.src)) return 'native/TaskbarNotify.cs 不存在'
      if (fs.existsSync(this.exe)) {
        const s = fs.statSync(this.exe)
        const c = fs.statSync(this.src)
        if (s.mtimeMs >= c.mtimeMs && s.size > 0) return null
      }
      const csc = CSC_CANDIDATES.find((p) => fs.existsSync(p))
      if (!csc) return '找不到 csc.exe（需要 .NET Framework 4.x）'
      fs.mkdirSync(this.binDir, { recursive: true })
      const r = spawnSync(csc, [
        '/nologo', '/target:winexe', '/optimize+', '/platform:anycpu',
        '/out:' + this.exe, this.src,
      ], { windowsHide: true, encoding: 'utf8', timeout: 120000 })
      if (r.error) return 'csc 启动失败: ' + r.error.message
      if (r.status !== 0 || !fs.existsSync(this.exe)) {
        return 'csc 编译失败 (exit ' + r.status + '): ' + String(r.stdout || '') + String(r.stderr || '')
      }
      return null
    } catch (err) {
      return '编译异常: ' + (err && err.message ? err.message : String(err))
    }
  }

  start() {
    if (this.disposed) return
    const buildErr = this.build()
    if (buildErr) {
      this.lastError = buildErr
      this.log('[dsh-task-notify] 原生助手不可用: ' + buildErr)
      return
    }
    // ppid = Electron 主进程（任务栏按钮的持有者）；助手内部还有按进程名兜底的查找
    const pids = []
    if (process.ppid) pids.push(String(process.ppid))
    if (process.pid) pids.push(String(process.pid))
    let child
    try {
      child = spawn(this.exe, pids, {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        detached: false,
      })
    } catch (err) {
      this.lastError = 'spawn 失败: ' + err.message
      this.log('[dsh-task-notify] ' + this.lastError)
      return
    }
    this.child = child
    this.ready = false

    let buf = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      buf += chunk
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim()
        buf = buf.slice(i + 1)
        if (line) this.handleLine(line)
      }
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      const s = String(chunk).trim()
      if (s) this.log('[dsh-task-notify] helper stderr: ' + s)
    })
    child.on('error', (err) => {
      this.lastError = 'helper error: ' + err.message
      this.log('[dsh-task-notify] ' + this.lastError)
    })
    child.on('exit', (code) => {
      this.ready = false
      this.child = null
      if (this.disposed) return
      this.log('[dsh-task-notify] 原生助手退出 code=' + code + '，准备重启')
      if (this.restarts++ < 20) {
        this.restartTimer = setTimeout(() => {
          this.restartTimer = null
          this.start()
        }, 1500)
        if (this.restartTimer.unref) this.restartTimer.unref()
      } else {
        this.lastError = 'helper 反复退出，已放弃重启'
      }
    })
  }

  handleLine(line) {
    if (line.startsWith('READY')) {
      this.ready = true
      this.lastError = null
      this.restarts = 0
      this.log('[dsh-task-notify] 原生助手就绪 ' + line)
      this.setBadgeMin(this.badgeMinMs)
      return
    }
    if (line === 'PONG') return
    if (line.startsWith('FOCUS')) {
      this.log('[dsh-task-notify] 窗口进入前台，已清除角标')
      try { this.onFocus() } catch (err) {}
      return
    }
    if (line.startsWith('ERR')) {
      this.lastError = line
      this.log('[dsh-task-notify] helper: ' + line)
      return
    }
    // WINDOW / BADGED / BADGECLEARED / FLASHING / ...
    if (line.startsWith('WINDOW')) this.log('[dsh-task-notify] ' + line)
  }

  send(cmd) {
    const c = this.child
    if (!c || !c.stdin || c.stdin.destroyed) return false
    try {
      c.stdin.write(cmd + '\n')
      return true
    } catch (err) {
      return false
    }
  }

  flash() {
    return this.send('flash')
  }

  stopFlash() {
    return this.send('stopflash')
  }

  setBadge(icoPath) {
    return this.send('badge ' + icoPath)
  }

  clearBadge() {
    return this.send('badgeclear')
  }

  setBadgeMin(ms) {
    this.badgeMinMs = ms
    return this.send('badgemin ' + ms)
  }

  dispose() {
    this.disposed = true
    if (this.restartTimer) clearTimeout(this.restartTimer)
    this.restartTimer = null
    try { this.send('quit') } catch (err) {}
    const c = this.child
    this.child = null
    if (c) {
      const t = setTimeout(() => { try { c.kill() } catch (err) {} }, 500)
      if (t.unref) t.unref()
      try { c.stdin.end() } catch (err) {}
    }
  }
}