// 自检：用 mock ctx 在 Node 里直接加载本插件，验证路由 / index 注入 / 事件汇聚逻辑。
// 不需要 DSH 在跑，也不会碰运行中的实例。
//   node tools/selfcheck.mjs
import { pathToFileURL } from 'node:url'
import { EventEmitter } from 'node:events'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const PLUGIN = path.join(ROOT, 'lib', 'index.js')
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

const routes = new Map()
const listeners = new Map()
const indexTables = []
const effects = []
const conn = { requestRejection: () => false }

const ctx = {
  on(ev, fn) {
    if (!listeners.has(ev)) listeners.set(ev, [])
    listeners.get(ev).push(fn)
    return () => { const a = listeners.get(ev); const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1) }
  },
  inject(_services, fn) { fn(this); return () => {} },
  get(name) { return name === 'connection' ? conn : undefined },
  connection: conn,
  webServer: {
    register(route) { routes.set(route.path, route); return () => routes.delete(route.path) },
    tapIndex(fn) { indexTables.push(fn); return () => {} },
  },
  effect(fn) { effects.push(fn()); return () => {} },
}

function fakeReq({ url = '/', method = 'GET', body = null } = {}) {
  const req = new EventEmitter()
  req.url = url; req.method = method; req.headers = {}
  process.nextTick(() => {
    if (body != null) req.emit('data', Buffer.from(body))
    req.emit('end')
  })
  return req
}
function fakeRes() {
  const res = { statusCode: 0, headers: {} }
  res.setHeader = (k, v) => { res.headers[k.toLowerCase()] = v }
  res.end = (c) => { res.body = c === undefined ? '' : (Buffer.isBuffer(c) ? c : String(c)) }
  res.destroy = () => {}
  return res
}
async function call(p, opts = {}) {
  const route = routes.get(p.split('?')[0])
  if (!route) return { statusCode: 0, body: '<no route ' + p + '>', headers: {} }
  const res = fakeRes()
  await route.handler(fakeReq(Object.assign({ url: p }, opts)), res)
  return res
}
const emit = (ev, ...a) => { for (const fn of (listeners.get(ev) || [])) fn(...a) }

const results = []
const check = (ok, label, extra = '') => { results.push(ok); console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (extra ? '   [' + extra + ']' : '')) }

const mod = await import(pathToFileURL(PLUGIN).href)
console.log('plugin =', mod.name, '| inject =', JSON.stringify(mod.inject))
mod.default.apply(ctx)

// 1. 路由
const want = ['/dsh-task-notify/client.js', '/dsh-task-notify/events', '/dsh-task-notify/config',
  '/dsh-task-notify/focus', '/dsh-task-notify/test', '/dsh-task-notify/soundfallback',
  '/dsh-task-notify/sound/chime.wav', '/dsh-task-notify/sound/ding.wav', '/dsh-task-notify/sound/pop.wav']
const missing = want.filter(p => !routes.has(p))
check(missing.length === 0, '9 条 HTTP 路由全部注册', missing.join(',') || routes.size + ' 条')
check([...routes.values()].every(r => r.kind === 'exact'), '路由 kind 均为 exact')

// 2. index 注入
const table = []
emit('webserver/index-inject', table)
check(table.length === 1 && table[0].kind === 'script' && table[0].placement === 'body', 'index 注入行已追加')
check(table[0].text.indexOf('/dsh-task-notify/client.js') !== -1, 'BOOTSTRAP 指向 client.js')
emit('webserver/index-inject', table)
check(table.length === 1, 'index 注入行幂等')
const html = indexTables[0]('<html><body>hi</body></html>')
check(html.indexOf('<script defer src="/dsh-task-notify/client.js"></script></body>') !== -1, 'tapIndex 插到 </body> 前')

// 3. 静态资源
const cjs = await call('/dsh-task-notify/client.js')
check(cjs.statusCode === 200 && String(cjs.body).length > 500, 'client.js 可下载', String(cjs.body).length + ' B')
for (const s of ['chime', 'ding', 'pop']) {
  const r = await call('/dsh-task-notify/sound/' + s + '.wav')
  check(r.statusCode === 200 && Buffer.isBuffer(r.body) && r.body.length > 1000, s + '.wav 可下载', (Buffer.isBuffer(r.body) ? r.body.length : 0) + ' B')
}

// 4. 配置
const cfgObj = JSON.parse((await call('/dsh-task-notify/config')).body)
check(cfgObj.ok === true, '/config GET 可用')
check((await call('/dsh-task-notify/config', { method: 'POST', body: 'not json' })).statusCode === 400, '/config POST 拒绝坏 JSON')

// 5. 事件汇聚
// 时序断言要稳，临时把防抖调小、冷却调大；跑完把配置文件恢复原样。
const CONFIG_PATH = path.join(os.homedir(), '.dsh', 'dsh-task-notify.json')
let snapshot = null
try { snapshot = fs.readFileSync(CONFIG_PATH, 'utf8') } catch (err) { snapshot = null }
await call('/dsh-task-notify/config', { method: 'POST', body: JSON.stringify({ debounceMs: 300, cooldownMs: 5000, minTurnMs: 0 }) })
const D = 300

const e0 = JSON.parse((await call('/dsh-task-notify/events?since=0')).body)
check(e0.ok === true && e0.events.length === 0, '初始 /events 为空')
for (let i = 0; i < 5; i++) emit('session/event', { id: 's1' }, { type: 'assistant/message', data: {} })
await sleep(D + 400)
check(JSON.parse((await call('/dsh-task-notify/events?since=0')).body).events.length === 0, '只有忙碌事件时不提醒')

emit('session/event', { id: 's1' }, { type: 'turn/end' })
await sleep(D + 400)
const e2 = JSON.parse((await call('/dsh-task-notify/events?since=0')).body)
check(e2.events.length === 1 && e2.events[0].type === 'done', 'turn/end 触发一次 done 提醒', 'seq=' + e2.seq)

// 刚提醒完立刻再来一次 —— 落在冷却窗口里，应被挡掉
emit('session/event', { id: 's1' }, { type: 'turn/end' })
await sleep(D + 400)
const e3 = JSON.parse((await call('/dsh-task-notify/events?since=0')).body)
check(e3.seq === 1, '冷却期内跳过提醒', 'seq=' + e3.seq)

// 主会话结束后子代理还在持续干活 —— 不能报喜
emit('session/event', { id: 'main' }, { type: 'turn/end' })
for (let i = 0; i < 5; i++) { emit('session/event', { id: 'sub' }, { type: 'assistant/message', data: {} }); await sleep(120) }
const e4 = JSON.parse((await call('/dsh-task-notify/events?since=0')).body)
check(e4.seq === 1, '子代理仍在忙时不报喜（防抖生效）', 'seq=' + e4.seq)

check(JSON.parse((await call('/dsh-task-notify/events?since=' + e4.seq)).body).events.length === 0, 'since 过滤正确')

// 恢复配置
try {
  if (snapshot === null) fs.rmSync(CONFIG_PATH, { force: true })
  else fs.writeFileSync(CONFIG_PATH, snapshot, 'utf8')
} catch (err) { console.log('WARN  恢复配置文件失败:', err.message) }

// 6. focus / 兜底 / 测试触发
check((await call('/dsh-task-notify/focus')).statusCode === 200, '/focus 可用')
check((await call('/dsh-task-notify/soundfallback')).statusCode === 200, '宿主声音兜底接口可用')
check(JSON.parse((await call('/dsh-task-notify/test')).body).ok === true, '/test 立即触发')

// 7. 信任栅栏 + 释放
conn.requestRejection = () => 403
check((await call('/dsh-task-notify/events')).statusCode === 403, '信任栅栏拒绝非本机请求')
conn.requestRejection = () => false
for (const d of effects) { try { if (typeof d === 'function') d() } catch (err) {} }
check(routes.size === 0, '释放后路由全部注销')

const failed = results.filter(r => !r).length
console.log('\n==== ' + (results.length - failed) + '/' + results.length + ' 通过 ====')
process.exit(failed ? 1 : 0)