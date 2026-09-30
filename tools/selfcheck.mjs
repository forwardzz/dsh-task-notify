// 自检：用 mock ctx 在 Node 里直接加载本插件，验证路由 / index 注入 / 事件汇聚 / 音效库逻辑。
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
const SOUNDS_DIR = path.join(os.homedir(), '.dsh', 'dsh-task-notify', 'sounds')
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

// 音效库测试会真的往 ~/.dsh 写文件，跑完清理干净
let soundsBefore = []
try { soundsBefore = fs.readdirSync(SOUNDS_DIR) } catch (err) { soundsBefore = [] }

const mod = await import(pathToFileURL(PLUGIN).href)
console.log('plugin =', mod.name, '| inject =', JSON.stringify(mod.inject))
mod.default.apply(ctx)

// 1. 路由
const want = ['/dsh-task-notify/beacon.js', '/dsh-task-notify/events', '/dsh-task-notify/config',
  '/dsh-task-notify/focus', '/dsh-task-notify/test', '/dsh-task-notify/soundfallback',
  '/dsh-task-notify/sound', '/dsh-task-notify/sounds',
  '/dsh-task-notify/sounds/import', '/dsh-task-notify/sounds/delete']
const missing = want.filter(p => !routes.has(p))
check(missing.length === 0, '10 条 HTTP 路由全部注册', missing.join(',') || routes.size + ' 条')
check([...routes.values()].every(r => r.kind === 'exact'), '路由 kind 均为 exact')

// 2. index 注入
const table = []
emit('webserver/index-inject', table)
check(table.length === 1 && table[0].kind === 'script' && table[0].placement === 'body', 'index 注入行已追加')
check(table[0].text.indexOf('/dsh-task-notify/beacon.js') !== -1, 'BOOTSTRAP 指向 beacon.js')
emit('webserver/index-inject', table)
check(table.length === 1, 'index 注入行幂等')
const html = indexTables[0]('<html><body>hi</body></html>')
check(html.indexOf('<script defer src="/dsh-task-notify/beacon.js"></script></body>') !== -1, 'tapIndex 插到 </body> 前')

// 3. 静态资源
const beacon = await call('/dsh-task-notify/beacon.js')
check(beacon.statusCode === 200 && String(beacon.body).length > 500, 'beacon.js 可下载', String(beacon.body).length + ' B')
check(String(beacon.body).indexOf('/sound?id=') !== -1, 'beacon 使用 /sound?id= 播放')
for (const s of ['chime', 'ding', 'pop']) {
  const r = await call('/dsh-task-notify/sound?id=' + s)
  check(r.statusCode === 200 && Buffer.isBuffer(r.body) && r.body.length > 1000, s + ' 可下载', (Buffer.isBuffer(r.body) ? r.body.length : 0) + ' B')
}
check((await call('/dsh-task-notify/sound?id=nope')).statusCode === 404, '未知音效返回 404')
check((await call('/dsh-task-notify/sound?id=c:../x')).statusCode === 404, '非法音效 id 被拒')

// 4. 音效库：清单 / 导入 / 试听地址 / 删除
const cat0 = JSON.parse((await call('/dsh-task-notify/sounds')).body)
check(cat0.ok === true && cat0.sounds.filter(s => s.builtin).length === 3, '内置音效 3 条', cat0.sounds.map(s => s.id).join(','))

// 造一个最小的合法 wav（44 字节头 + 一点数据）
const pcm = Buffer.alloc(44 + 3200)
pcm.write('RIFF', 0); pcm.writeUInt32LE(36 + 3200, 4); pcm.write('WAVE', 8)
pcm.write('fmt ', 12); pcm.writeUInt32LE(16, 16); pcm.writeUInt16LE(1, 20); pcm.writeUInt16LE(1, 22)
pcm.writeUInt32LE(8000, 24); pcm.writeUInt32LE(8000, 28); pcm.writeUInt16LE(1, 32); pcm.writeUInt16LE(8, 34)
pcm.write('data', 36); pcm.writeUInt32LE(3200, 40)

const imp = JSON.parse((await call('/dsh-task-notify/sounds/import', {
  method: 'POST',
  body: JSON.stringify({ name: '自检音效 Self Check!', ext: 'wav', data: pcm.toString('base64') }),
})).body)
check(imp.ok === true && /^c:/.test(imp.sound.id), '导入音效成功', imp.sound && imp.sound.id)
const newId = imp.sound && imp.sound.id
check(newId === 'c:自检音效-self-check', 'id 由名称 slug 化', String(newId))
check(fs.existsSync(path.join(SOUNDS_DIR, '自检音效-self-check.wav')), '音频文件已落盘')
check(JSON.parse((await call('/dsh-task-notify/sounds')).body).sounds.some(s => s.id === newId), '清单里出现新音效')
const got = await call('/dsh-task-notify/sound?id=' + encodeURIComponent(newId))
check(got.statusCode === 200 && Buffer.isBuffer(got.body) && got.body.length === pcm.length, '导入的音效能被播放接口读出', got.body && got.body.length)

check((await call('/dsh-task-notify/sounds/import', { method: 'POST', body: JSON.stringify({ name: 'x', ext: 'exe', data: 'AAAA' }) })).statusCode === 400, '拒绝不支持的扩展名')
check((await call('/dsh-task-notify/sounds/import', { method: 'POST', body: JSON.stringify({ name: 'x', ext: 'wav', data: '' }) })).statusCode === 400, '拒绝空数据')
check((await call('/dsh-task-notify/sounds/delete', { method: 'POST', body: JSON.stringify({ id: 'chime' }) })).statusCode === 400, '拒绝删除内置音效')
check((await call('/dsh-task-notify/sounds/delete', { method: 'POST', body: JSON.stringify({ id: 'c:../../evil' }) })).statusCode === 400, '拒绝路径穿越')

// 删掉正在使用的音效 → 配置回落到默认
await call('/dsh-task-notify/config', { method: 'POST', body: JSON.stringify({ soundName: newId }) })
check(JSON.parse((await call('/dsh-task-notify/config')).body).config.soundName === newId, '可以切换到导入的音效')
const del = JSON.parse((await call('/dsh-task-notify/sounds/delete', { method: 'POST', body: JSON.stringify({ id: newId }) })).body)
check(del.ok === true, '删除导入的音效')
check(del.config.soundName === 'chime', '删掉当前音效后回落默认', del.config.soundName)
check(!fs.existsSync(path.join(SOUNDS_DIR, '自检音效-self-check.wav')), '音频文件已删除')
check((await call('/dsh-task-notify/sounds/delete', { method: 'POST', body: JSON.stringify({ id: newId }) })).statusCode === 400, '重复删除返回 400')

// 5. 配置
const cfgObj = JSON.parse((await call('/dsh-task-notify/config')).body)
check(cfgObj.ok === true, '/config GET 可用')
check((await call('/dsh-task-notify/config', { method: 'POST', body: 'not json' })).statusCode === 400, '/config POST 拒绝坏 JSON')

// 6. 事件汇聚
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

// 7. focus / 兜底 / 测试触发
check((await call('/dsh-task-notify/focus')).statusCode === 200, '/focus 可用')
check((await call('/dsh-task-notify/soundfallback')).statusCode === 200, '宿主声音兜底接口可用')
check(JSON.parse((await call('/dsh-task-notify/test')).body).ok === true, '/test 立即触发')

// 8. 信任栅栏 + 释放
conn.requestRejection = () => 403
check((await call('/dsh-task-notify/events')).statusCode === 403, '信任栅栏拒绝非本机请求')
conn.requestRejection = () => false
for (const d of effects) { try { if (typeof d === 'function') d() } catch (err) {} }
check(routes.size === 0, '释放后路由全部注销')

// 清理自检写进音效目录的文件
try {
  for (const f of fs.readdirSync(SOUNDS_DIR)) {
    if (soundsBefore.indexOf(f) < 0) fs.rmSync(path.join(SOUNDS_DIR, f), { force: true })
  }
  if (soundsBefore.length === 0) { try { fs.rmdirSync(SOUNDS_DIR) } catch (err) {} }
} catch (err) {}

const failed = results.filter(r => !r).length
console.log('\n==== ' + (results.length - failed) + '/' + results.length + ' 通过 ====')
process.exit(failed ? 1 : 0)