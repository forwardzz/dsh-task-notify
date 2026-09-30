// 客户端半边自检：用替身 React 在 Node 里跑 lib/client.js，
// 验证模块包装契约、settings.section 注册内容、以及设置页的元素树。
// 不需要浏览器，也不会碰运行中的 DSH。
//   node tools/selfcheck-client.mjs
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const CLIENT = path.join(ROOT, 'lib', 'client.js')

const results = []
const check = (ok, label, extra = '') => {
  results.push(ok)
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (extra ? '   [' + extra + ']' : ''))
}

// ---------------------------------------------------------------- 替身 React
// useState 按调用顺序从 seed 队列里取值，用来把「已加载完成」的状态喂进组件。
let seed = []
const fakeReact = {
  createElement(type, props) {
    const children = []
    for (let i = 2; i < arguments.length; i++) {
      const c = arguments[i]
      if (Array.isArray(c)) children.push(...c.flat(Infinity))
      else children.push(c)
    }
    return { type: type, props: props || {}, children: children.filter((c) => c !== null && c !== undefined && c !== false && c !== true) }
  },
  useState(init) {
    return [seed.length ? seed.shift() : (typeof init === 'function' ? init() : init), function () {}]
  },
  useRef(v) { return { current: v === undefined ? null : v } },
  useEffect() {},
}

// ---------------------------------------------------------------- 替身浏览器
let captured = null
const fetches = []
const win = {
  __ModuleLoader__: { load(def) { captured = def } },
  btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
  fetch: (url, opts) => {
    fetches.push({ url: url, method: (opts && opts.method) || 'GET' })
    return Promise.resolve({ json: () => Promise.resolve({ ok: true }) })
  },
  Audio: function () { return { play: () => Promise.resolve(), volume: 0 } },
  FileReader: function () { return {} },
  confirm: () => true,
}
win.window = win

const src = fs.readFileSync(CLIENT, 'utf8')
new Function('window', 'console', src)(win, console)

// ---------------------------------------------------------------- 1. 模块契约
check(!!captured, '__ModuleLoader__.load 被调用')
if (!captured) { console.log('\n==== 0/1 通过 ===='); process.exit(1) }
check(captured.id === 'dsh-task-notify', 'bundle id = 包名', String(captured.id))

const required = []
const mod = captured.factory((id) => {
  required.push(id)
  if (id === 'react') return fakeReact
  throw new Error('不允许 require: ' + id)
})
check(typeof mod.apply === 'function', '导出 apply()')
check(Array.isArray(mod.inject) && mod.inject.indexOf('slots') >= 0, '导出 inject 含 slots', JSON.stringify(mod.inject))
check(required.length === 1 && required[0] === 'react', '只 require 了 react', required.join(','))

// ---------------------------------------------------------------- 2. 槽注册
let registered = null
const ctx = {
  slots: {
    inject(key, cb) {
      check(key === 'settings.section', 'inject 到 settings.section', key)
      const off = cb()
      return typeof off === 'function' ? off : function () {}
    },
    register(spec, component) { registered = { spec: spec, component: component }; return function () {} },
  },
  effect(fn) { const d = fn(); check(typeof d === 'function', 'effect 返回 disposer') },
}
mod.apply(ctx)
check(!!registered, '注册被调用')
if (!registered) { console.log('\n==== 部分失败 ===='); process.exit(1) }
check(registered.spec.name === 'settings.section', '注册的槽名正确')
check(registered.spec.id === 'task-notify', '注册 id 唯一且稳定', String(registered.spec.id))
check(typeof registered.spec.order === 'number', 'order 是数字', String(registered.spec.order))
check(typeof registered.spec.label === 'string' && registered.spec.label.length > 0, 'label 非空', String(registered.spec.label))
check(typeof registered.component === 'function', '组件是函数')

// ---------------------------------------------------------------- 3. 界面元素树
seed = [
  { config: { soundEnabled: true, soundName: 'chime', volume: 0.7, flashEnabled: true, badgeEnabled: true, badgeIcon: 'dot' },
    sounds: [
      { id: 'chime', label: '清脆铃声', builtin: true, ext: 'wav' },
      { id: 'c:my-tune', label: 'my-tune', builtin: false, ext: 'mp3' },
    ] },
  '', false, '',
]
const tree = registered.component()
const texts = []
const types = []
;(function walk(node) {
  if (node === null || node === undefined) return
  if (typeof node === 'string' || typeof node === 'number') { texts.push(String(node)); return }
  if (Array.isArray(node)) { node.forEach(walk); return }
  types.push(node.type)
  walk(node.children)
})(tree)
const text = texts.join(' | ')

check(text.indexOf('任务提醒') >= 0, '有标题')
check(text.indexOf('启用提示音') >= 0, '有提示音开关')
check(text.indexOf('音量') >= 0 && text.indexOf('70%') >= 0, '有音量行且显示百分比')
check(text.indexOf('清脆铃声') >= 0 && text.indexOf('内置') >= 0, '列出内置音效并带标签')
check(text.indexOf('my-tune') >= 0 && text.indexOf('mp3') >= 0, '列出自导入音效及其格式')
check(texts.filter((t) => t === '▶ 试听').length === 2, '每个音效都有试听按钮', String(texts.filter((t) => t === '▶ 试听').length))
check(texts.filter((t) => t === '删除').length === 1, '只有自导入的音效可删除')
check(text.indexOf('导入自己的音效') >= 0, '有导入区')
check(text.indexOf('图标闪烁') >= 0 && text.indexOf('显示角标') >= 0, '有任务栏开关')
check(text.indexOf('红点') >= 0 && text.indexOf('绿勾') >= 0, '有角标样式选项')
check(text.indexOf('等我选择') >= 0, '有「等我选择 / 批准」开关')
check(types.indexOf('input') >= 0 && types.indexOf('button') >= 0 && types.indexOf('select') >= 0, '渲染出 input/button/select')

// 选中态：当前音效应该是 chime
const radios = []
;(function collect(node) {
  if (!node || typeof node !== 'object') return
  if (Array.isArray(node)) { node.forEach(collect); return }
  if (node.type === 'input' && node.props && node.props.type === 'radio') radios.push(node.props)
  collect(node.children)
})(tree)
check(radios.length === 2 && radios[0].checked === true && radios[1].checked === false, '当前音效的单选钮被选中')

// ---------------------------------------------------------------- 4. 事件回调真的打接口
const previewBtn = []
;(function collect(node) {
  if (!node || typeof node !== 'object') return
  if (Array.isArray(node)) { node.forEach(collect); return }
  if (node.type === 'button' && node.children && node.children[0] === '▶ 试听') previewBtn.push(node)
  collect(node.children)
})(tree)
check(previewBtn.length === 2, '找到试听按钮')
seed = []
// 试听只走 <audio>，不该发请求；确认不会抛错
let threw = ''
try { previewBtn[1].props.onClick() } catch (e) { threw = String(e && e.message || e) }
check(threw === '', '点试听不抛错', threw || 'ok')

const failed = results.filter((r) => !r).length
console.log('\n==== ' + (results.length - failed) + '/' + results.length + ' 通过 ====')
process.exit(failed ? 1 : 0)