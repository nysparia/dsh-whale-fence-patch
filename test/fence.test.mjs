// 信任栅栏回归测试：把打过补丁的 lib/index.js 里的栅栏代码段原样抽出来，
// 喂给不同形态的 connection 服务，逐条断言行为。
//
// 抽段方式与上游 diag/fence-ab.mjs 一致：定位 `const TRUSTED_AUTHORITIES`
// 到 `// 统一注册入口` 之间，用 new Function 包一层，注入 ctx 与 console。
//
// 跑法：
//   node test/fence.test.mjs                 # 自动找 ~/.dsh/profiles/*/node_modules/dsh-whale-widget
//   node test/fence.test.mjs --path <dir>    # 指定插件目录
//   WHALE_PLUGIN_DIR=<dir> node test/fence.test.mjs

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import test from 'node:test'
import assert from 'node:assert/strict'

const PKG = 'dsh-whale-widget'

function resolvePluginDir() {
  const argv = process.argv.slice(2)
  const i = argv.indexOf('--path')
  if (i >= 0 && argv[i + 1]) return path.resolve(argv[i + 1])
  if (process.env.WHALE_PLUGIN_DIR) return path.resolve(process.env.WHALE_PLUGIN_DIR)
  const root = path.join(os.homedir(), '.dsh', 'profiles')
  let names = []
  try { names = fs.readdirSync(root) } catch (err) { names = [] }
  for (const n of names) {
    const dir = path.join(root, n, 'node_modules', PKG)
    if (fs.existsSync(path.join(dir, 'lib', 'index.js'))) return dir
  }
  return null
}

const pluginDir = resolvePluginDir()
if (!pluginDir) {
  console.error('找不到已安装的 dsh-whale-widget。用 --path <dir> 或 WHALE_PLUGIN_DIR 指定。')
  process.exit(1)
}
const targetFile = path.join(pluginDir, 'lib', 'index.js')
if (!fs.existsSync(targetFile)) {
  console.error(`找不到 ${targetFile}。用 --path <dir> 或 WHALE_PLUGIN_DIR 指定插件目录。`)
  process.exit(1)
}
const src = fs.readFileSync(targetFile, 'utf8')

// —— 抽段 ——

const a = src.indexOf('const TRUSTED_AUTHORITIES')
const b = src.indexOf('// 统一注册入口')
if (a < 0 || b < 0) {
  console.error(`在 ${targetFile} 里找不到栅栏代码段的边界（TRUSTED_AUTHORITIES / 统一注册入口）。`)
  process.exit(1)
}
const body = src.slice(a, b)

// 补丁是否在位：不在位就直接失败，避免"测了个没打补丁的文件还以为通过"
if (!body.includes('typeof conn.admit === \'function\'')) {
  console.error(`${targetFile} 里没有 admit 分支 —— 补丁未应用，先跑 node patch.mjs。`)
  process.exit(1)
}

function buildFence(ctx, warns) {
  const factory = new Function('ctx', 'console', `
${body}
return { rejected, selfRejection, writeRejection, connectionFence, isLoopbackHostname }
`)
  return factory(ctx, { warn: (...args) => warns.push(args.join(' ')) })
}

const makeCtx = (conn) => ({ get: (k) => (k === 'connection' ? conn : undefined), connection: conn })
const req = (method, host, extra = {}) => ({ method, headers: { host, ...extra } })

// 返回 'PASS'（放行到路由）或拒绝码
function call(fence, r) {
  const res = { statusCode: 0, ended: false, end() { this.ended = true } }
  return fence.rejected(r, res) ? res.statusCode : 'PASS'
}

function run(conn, r, envTrusted) {
  const saved = process.env.DSHW_TRUSTED_HOSTS
  if (envTrusted === undefined) delete process.env.DSHW_TRUSTED_HOSTS
  else process.env.DSHW_TRUSTED_HOSTS = envTrusted
  const warns = []
  const fence = buildFence(makeCtx(conn), warns)
  const got = call(fence, r)
  if (saved === undefined) delete process.env.DSHW_TRUSTED_HOSTS
  else process.env.DSHW_TRUSTED_HOSTS = saved
  return { got, warns, fenceAvailable: !!fence.connectionFence() }
}

// —— 两种 connection 形态 ——

const LOOPBACK_RE = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/

const legacyConnection = {
  requestRejection(r) {
    const host = String((r.headers && r.headers.host) || '')
    return LOOPBACK_RE.test(host) ? undefined : 403
  },
}

const modernConnection = {
  admit(r) {
    const host = String((r.headers && r.headers.host) || '')
    return LOOPBACK_RE.test(host) ? { peer: { id: 'p' } } : { rejection: 403 }
  },
  allowsRemoteAuthorities: false,
}

// ============ 1. 常规 10 例（legacy vs modern 必须一致）============

const COMMON_CASES = [
  ['GET  回环 Host', req('GET', '127.0.0.1:3080'), 'PASS'],
  ['GET  localhost', req('GET', 'localhost:3080'), 'PASS'],
  ['GET  伪造 Host（DNS 重绑定）', req('GET', 'evil.example.com'), 403],
  ['GET  跨站标记', req('GET', '127.0.0.1:3080', { 'sec-fetch-site': 'cross-site' }), 403],
  ['GET  跨源 Origin', req('GET', '127.0.0.1:3080', { origin: 'http://evil.example.com' }), 403],
  ['GET  同源 Origin', req('GET', '127.0.0.1:3080', { origin: 'http://127.0.0.1:3080' }), 'PASS'],
  ['GET  畸形 Host', req('GET', ''), 403],
  ['POST 回环 Host（写配置）', req('POST', '127.0.0.1:3080'), 'PASS'],
  ['POST 局域网 Host（写配置）', req('POST', '192.168.1.20:3080'), 403],
  ['POST 伪造 Host', req('POST', 'evil.example.com'), 403],
]

test('常规 10 例：legacy 形态', () => {
  for (const [label, r, expected] of COMMON_CASES) {
    const { got, fenceAvailable } = run(legacyConnection, r)
    assert.equal(fenceAvailable, true, `${label}：legacy 宿主上 connectionFence 应可用`)
    assert.equal(got, expected, `${label}：期望 ${expected}，实际 ${got}`)
  }
})

test('常规 10 例：modern 形态（admit）', () => {
  for (const [label, r, expected] of COMMON_CASES) {
    const { got, fenceAvailable } = run(modernConnection, r)
    assert.equal(fenceAvailable, true, `${label}：modern 宿主上 connectionFence 应可用（补丁的核心）`)
    assert.equal(got, expected, `${label}：期望 ${expected}，实际 ${got}`)
  }
})

test('常规 10 例：两种形态逐条一致', () => {
  for (const [label, r] of COMMON_CASES) {
    const l = run(legacyConnection, r).got
    const m = run(modernConnection, r).got
    assert.equal(m, l, `${label}：legacy=${l} modern=${m}，行为不一致`)
  }
})

test('加载期不再打"栅栏不可用"warn', () => {
  for (const [label, conn] of [['legacy', legacyConnection], ['modern', modernConnection]]) {
    const { warns } = run(conn, req('GET', '127.0.0.1:3080'))
    const bad = warns.filter((w) => w.includes('宿主信任栅栏不可用'))
    assert.deepEqual(bad, [], `${label}：不应再出现"宿主信任栅栏不可用"的 warn`)
  }
})

// ============ 2. trustedHosts 交界 4 例 ============

const TRUSTED = 'harness.internal:3080'
const isTrusted = (host) => host === TRUSTED || LOOPBACK_RE.test(host)

const legacyTrusting = {
  requestRejection(r) {
    const host = String((r.headers && r.headers.host) || '')
    return isTrusted(host) ? undefined : 403
  },
}
const modernTrusting = {
  admit(r) {
    const host = String((r.headers && r.headers.host) || '')
    return isTrusted(host) ? { peer: { id: 'p' } } : { rejection: 403 }
  },
  allowsRemoteAuthorities: true,
}

const TRUSTED_CASES = [
  ['GET  宿主已信任的非回环权威', req('GET', TRUSTED), 'PASS'],
  ['GET  同源 Origin + 已信任权威', req('GET', TRUSTED, { origin: 'http://' + TRUSTED }), 'PASS'],
  ['POST 宿主已信任的非回环权威', req('POST', TRUSTED), 403],
  ['GET  未声明的非回环权威', req('GET', 'other.example.com'), 403],
]

const TRUSTED_SCENARIOS = [
  ['legacy 宿主，未设 DSHW_TRUSTED_HOSTS', legacyTrusting, undefined],
  ['modern 宿主，未设 DSHW_TRUSTED_HOSTS', modernTrusting, undefined],
  ['modern 宿主，设了 DSHW_TRUSTED_HOSTS', modernTrusting, TRUSTED],
]

for (const [label, conn, env] of TRUSTED_SCENARIOS) {
  test(`trustedHosts 4 例：${label}`, () => {
    for (const [name, r, expected] of TRUSTED_CASES) {
      const { got, fenceAvailable } = run(conn, r, env)
      assert.equal(fenceAvailable, true, `${name}：connectionFence 应可用`)
      assert.equal(got, expected, `${name}：期望 ${expected}，实际 ${got}`)
    }
  })
}

test('trustedHosts：宿主已信任的权威不再被插件误判 403（#277）', () => {
  const legacy = run(legacyTrusting, req('GET', TRUSTED)).got
  const modern = run(modernTrusting, req('GET', TRUSTED)).got
  assert.equal(legacy, 'PASS', 'legacy 宿主上应放行')
  assert.equal(modern, 'PASS', `modern 宿主上应放行，实际 ${modern}（这就是 #277 的 403）`)
})

// ============ 3. admit 返回形态 13 例 ============

const ADMIT_SHAPES = [
  ['admit → { peer: owner }', { admit: () => ({ peer: { principal: { kind: 'owner' } } }) }, 'PASS'],
  ['admit → { peer: 非 owner }', { admit: () => ({ peer: { principal: { kind: 'guest' } } }) }, 403],
  ['admit → { peer: 无 principal }', { admit: () => ({ peer: { id: 'p' } }) }, 'PASS'],
  ['admit → { rejection: 401 }', { admit: () => ({ rejection: 401 }) }, 401],
  ['admit → { rejection: 403 }', { admit: () => ({ rejection: 403 }) }, 403],
  ['admit → { rejection: 503 }', { admit: () => ({ rejection: 503 }) }, 503],
  ['admit → undefined（不认这次请求）', { admit: () => undefined }, 403],
  ['admit → null', { admit: () => null }, 403],
  ['admit 抛异常', { admit: () => { throw new Error('boom') } }, 403],
  ['requestRejection → undefined（放行）', { requestRejection: () => undefined }, 'PASS'],
  ['requestRejection → 401', { requestRejection: () => 401 }, 401],
  ['requestRejection 抛异常', { requestRejection: () => { throw new Error('boom') } }, 403],
  ['两者都有，优先 requestRejection', {
    requestRejection: () => 401,
    admit: () => ({ peer: { principal: { kind: 'owner' } } }),
  }, 401],
]

test('admit 返回形态 13 例', () => {
  for (const [label, conn, expected] of ADMIT_SHAPES) {
    const { got } = run(conn, req('GET', '127.0.0.1:3080'))
    assert.equal(got, expected, `${label}：期望 ${expected}，实际 ${got}`)
  }
})

test('admit 返回 { peer: 非 owner } 时打不出"栅栏不可用"的 warn', () => {
  const { warns } = run({ admit: () => ({ peer: { principal: { kind: 'guest' } } }) }, req('GET', '127.0.0.1:3080'))
  assert.deepEqual(warns.filter((w) => w.includes('宿主信任栅栏不可用')), [])
})

// ============ 4. 401 / 503 透出与异常 fail-closed ============

const EDGE_CASES = [
  ['admit 返回 401（未认证）', { admit: () => ({ rejection: 401 }) }, 401],
  ['admit 返回 503（验证失败）', { admit: () => ({ rejection: 503 }) }, 503],
  ['admit 抛异常', { admit: () => { throw new Error('boom') } }, 403],
  ['admit 放行', { admit: () => ({ peer: { id: 'p' } }) }, 'PASS'],
  ['requestRejection 返回 401', { requestRejection: () => 401 }, 401],
  ['requestRejection 抛异常', { requestRejection: () => { throw new Error('boom') } }, 403],
]

test('401/503 透出与异常 fail-closed', () => {
  for (const [label, conn, expected] of EDGE_CASES) {
    const { got } = run(conn, req('GET', '127.0.0.1:3080'))
    assert.equal(got, expected, `${label}：期望 ${expected}，实际 ${got}`)
  }
})

test('栅栏抛异常时打一条 warn（不静默放行）', () => {
  const { warns } = run({ admit: () => { throw new Error('boom') } }, req('GET', '127.0.0.1:3080'))
  assert.ok(warns.some((w) => w.includes('信任栅栏抛异常')), `应有一条"信任栅栏抛异常"的 warn，实际：${JSON.stringify(warns)}`)
})

// ============ 5. 没有 connection 服务时的降级 ============

test('没有 connection 服务：connectionFence 为 null，自校验仍生效', () => {
  const warns = []
  const fence = buildFence(makeCtx(null), warns)
  assert.equal(fence.connectionFence(), null)
  assert.ok(warns.some((w) => w.includes('宿主信任栅栏不可用')), '应打"栅栏不可用"的 warn')
  assert.equal(call(fence, req('GET', '127.0.0.1:3080')), 'PASS', '回环 Host 仍应放行')
  assert.equal(call(fence, req('GET', 'evil.example.com')), 403, '伪造 Host 仍应拒绝')
})

// ============ 6. inject 列表必须含 connection.authentication ============
//
// 这条是真实 DSH 进程里才暴露的坑：admit() 内部访问 this.authentication，
// 而 Cordis 的 ctx proxy 会把它解析成 connection.authentication 服务。
// 插件没 inject 这个服务时，属性访问抛
//   cannot get property "connection.authentication" without inject
// 于是 admit 每次都抛异常、被 fail-closed 成 403 —— 补丁等于没打。
// 进程内模拟（直接构造 connection 对象）测不出这一层，只能静态断言源码。

test('inject 列表包含 connection.authentication', () => {
  // 只认真正的调用（列表里带引号），跳过注释里的 `root.inject([...], cb)` 示例
  const m = /root\.inject\(\[\s*'([^\]]*)\]/.exec(src)
  assert.ok(m, '应能找到 root.inject([...]) 声明')
  const list = m[1].split(',').map((x) => x.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean)
  assert.ok(
    list.includes('connection.authentication'),
    `inject 列表必须含 connection.authentication，实际：${JSON.stringify(list)}`,
  )
})

// ============ 7. 音效路由的原型链查表（第二个 bug，与栅栏无关）============
//
// 症状：GET /dsh-whale/sound/{press,release}.mp3?set=__proto__ 返回 400，
//   响应头没有 Content-Type —— 那是宿主 webserver 兜底 catch 写的。
// 根因：SOUND_SETS 是普通对象字面量，SOUND_SETS['__proto__'] 返回 Object.prototype、
//   SOUND_SETS['constructor'] 返回 Function，两者都 truthy，于是 `|| SOUND_SETS.duck`
//   的兜底不生效；随后 set.press 是 undefined，loadSound 里 for-of 抛
//   TypeError: candidates is not iterable。
//
// 这一组既做静态断言（不再有裸查表），也把打过补丁的 handler 整段抽出来真跑一遍。

const PROTO_KEYS = [
  '__proto__', 'constructor', 'toString', 'valueOf', 'hasOwnProperty',
  'isPrototypeOf', 'propertyIsEnumerable', 'toLocaleString',
  '__defineGetter__', '__lookupGetter__', '__lookupSetter__', '__defineSetter__',
]

// 按函数名从源码里抽一个函数（花括号配平），不重写逻辑
function extractFn(source, name) {
  const start = source.indexOf('function ' + name + '(')
  if (start < 0) throw new Error(`找不到函数 ${name}`)
  let i = source.indexOf('{', start)
  let depth = 0
  for (; i < source.length; i++) {
    if (source[i] === '{') depth++
    else if (source[i] === '}') { depth--; if (depth === 0) return source.slice(start, i + 1) }
  }
  throw new Error(`花括号不配平：${name}`)
}

// 抽 serveSound + soundSetFor + 两个 handler 所在的整段
const SOUND_START = '    function loadSound(candidates) {'
const SOUND_END = '    function pickBubbleImgDir() {'
const soundA = src.indexOf(SOUND_START)
const soundB = src.indexOf(SOUND_END)
if (soundA < 0 || soundB < 0) {
  console.error(`在 ${targetFile} 里找不到音效代码段的边界（loadSound / pickBubbleImgDir）。`)
  process.exit(1)
}
const soundBlock = src.slice(soundA, soundB)

// 补丁是否在位：不在位就直接失败，避免"测了个没打补丁的文件还以为通过"
if (!soundBlock.includes('Array.isArray(candidates)')) {
  console.error(`${targetFile} 里没有 Array.isArray 守卫 —— 音效补丁未应用，先跑 node patch.mjs。`)
  process.exit(1)
}

function buildSoundRoutes() {
  const routes = new Map()
  const PACKAGE_ROOT = '/pkg'
  const SOUND_SETS = {
    duck: { press: [PACKAGE_ROOT + '/assets/Ya1.mp3'], release: [PACKAGE_ROOT + '/assets/Ya2.mp3'] },
    fx1: { press: [PACKAGE_ROOT + '/assets/D1.mp3'], release: [PACKAGE_ROOT + '/assets/D2.mp3'] },
  }
  const PRESET_GROUPS = {
    duck: { id: 'duck', name: '小黄鸭', press: 'ya1', release: 'ya2', preset: true },
    fx1: { id: 'fx1', name: '音效1', press: 'd1', release: 'd2', preset: true },
  }
  const PRESET_FRAGMENTS = {
    ya1: { id: 'ya1', mime: 'audio/mpeg' }, ya2: { id: 'ya2', mime: 'audio/mpeg' },
    d1: { id: 'd1', mime: 'audio/mpeg' }, d2: { id: 'd2', mime: 'audio/mpeg' },
  }
  const helpers = ['soundSetFromUrl', 'audioFragmentPath', 'loadAudioFragmentBytes',
    'groupFragmentId', 'fragmentMime', 'customFragExists']
    .map((n) => extractFn(src, n)).join('\n\n')
  const factory = new Function(
    'fs', 'path', 'PACKAGE_ROOT', 'SOUND_SETS', 'PRESET_GROUPS', 'PRESET_FRAGMENTS',
    'BUILTIN_FRAGMENT_FILES', 'AUDIO_INDEX_NAME', 'registerRoute', 'disposers',
    'readAudioIndex', 'pickAudioDir',
    `${helpers}\n\n${soundBlock}\nreturn { soundSetFor }`,
  )
  const api = factory(
    { readFileSync: (p) => Buffer.from('BYTES:' + p) },
    path, PACKAGE_ROOT, SOUND_SETS, PRESET_GROUPS, PRESET_FRAGMENTS,
    {}, 'audio.json',
    (r) => { routes.set(r.path, r.handler); return () => {} },
    [], () => ({ groups: [], fragments: [] }), () => '/audio',
  )
  return { routes, api, SOUND_SETS }
}

function callRoute(routes, routePath, url) {
  const handler = routes.get(routePath)
  if (!handler) throw new Error('route missing: ' + routePath)
  const res = {
    statusCode: 0, headers: null, body: null,
    writeHead(code, h) { this.statusCode = code; this.headers = h || {} },
    end(b) { this.body = b === undefined ? null : b },
  }
  let threw = null
  try { handler({ url }, res) } catch (err) { threw = err }
  return { statusCode: res.statusCode, headers: res.headers, body: res.body, threw }
}

const SOUND_ROUTES = [
  ['/dsh-whale/sound/press.mp3', 'press'],
  ['/dsh-whale/sound/release.mp3', 'release'],
]

test('SOUND_SETS 查表对原型键降级到 duck（不抛异常）', () => {
  const { routes, SOUND_SETS } = buildSoundRoutes()
  for (const [routePath, slot] of SOUND_ROUTES) {
    const duckBytes = 'BYTES:' + SOUND_SETS.duck[slot][0]
    for (const key of PROTO_KEYS) {
      const r = callRoute(routes, routePath, `${routePath}?set=${encodeURIComponent(key)}`)
      assert.equal(r.threw, null,
        `${routePath}?set=${key}：不应抛异常，实际 ${r.threw && r.threw.constructor.name + ': ' + r.threw.message}`)
      assert.equal(r.statusCode, 200, `${routePath}?set=${key}：期望 200，实际 ${r.statusCode}`)
      assert.equal(String(r.body), duckBytes, `${routePath}?set=${key}：应降级到 duck 的音频`)
    }
  }
})

test('soundSetFor 对原型键返回 SOUND_SETS.duck', () => {
  const { api, SOUND_SETS } = buildSoundRoutes()
  for (const key of PROTO_KEYS) {
    assert.equal(api.soundSetFor(key), SOUND_SETS.duck,
      `soundSetFor(${key}) 应返回 SOUND_SETS.duck，实际 ${String(api.soundSetFor(key))}`)
  }
  assert.equal(api.soundSetFor('duck'), SOUND_SETS.duck)
  assert.equal(api.soundSetFor('fx1'), SOUND_SETS.fx1)
  assert.equal(api.soundSetFor(''), SOUND_SETS.duck)
})

test('正常音效组不受影响（duck / fx1 各自取到自己的音频）', () => {
  const { routes, SOUND_SETS } = buildSoundRoutes()
  for (const [routePath, slot] of SOUND_ROUTES) {
    for (const name of ['duck', 'fx1']) {
      const r = callRoute(routes, routePath, `${routePath}?set=${name}`)
      assert.equal(r.threw, null, `${routePath}?set=${name} 不应抛异常`)
      assert.equal(r.statusCode, 200, `${routePath}?set=${name}：期望 200，实际 ${r.statusCode}`)
      assert.equal(String(r.body), 'BYTES:' + SOUND_SETS[name][slot][0],
        `${routePath}?set=${name}：应取到 ${name} 的音频`)
    }
  }
})

test('无 set / 空 set / 未知组名都降级到 duck', () => {
  const { routes, SOUND_SETS } = buildSoundRoutes()
  for (const [routePath, slot] of SOUND_ROUTES) {
    const duckBytes = 'BYTES:' + SOUND_SETS.duck[slot][0]
    for (const q of ['', '?set=', '?other=1', '?set=group_nonexistent']) {
      const r = callRoute(routes, routePath, routePath + q)
      assert.equal(r.threw, null, `${routePath}${q} 不应抛异常`)
      assert.equal(r.statusCode, 200, `${routePath}${q}：期望 200，实际 ${r.statusCode}`)
      assert.equal(String(r.body), duckBytes, `${routePath}${q}：应降级到 duck`)
    }
  }
})

test('修复后的代码里不再有裸的 SOUND_SETS[userInput] 查表', () => {
  // 注释里会提到 SOUND_SETS['__proto__'] 这类反例，扫描前先剥掉行注释，
  // 否则测的是注释而不是代码。
  const code = soundBlock.split('\n')
    .map((line) => {
      const i = line.indexOf('//')
      return i < 0 ? line : line.slice(0, i)
    })
    .join('\n')

  // 唯一允许的查表形式是 Object.hasOwn 守卫内的 SOUND_SETS[name]
  const lookups = [...code.matchAll(/SOUND_SETS\[([^\]]+)\]/g)].map((m) => m[1].trim())
  const bad = lookups.filter((k) => k !== 'name')
  assert.deepEqual(bad, [],
    `音效段里出现了未预期的 SOUND_SETS[...] 查表：${JSON.stringify(bad)}（完整：${JSON.stringify(lookups)}）`)

  // 每个 SOUND_SETS[name] 都必须紧跟在 Object.hasOwn 判定之后
  assert.ok(
    /Object\.hasOwn\(SOUND_SETS, name\) \? SOUND_SETS\[name\] : SOUND_SETS\.duck/.test(code),
    'soundSetFor 必须用 Object.hasOwn 守卫后再查表',
  )
  // 两个 handler 的自定义组分支也必须用 Object.hasOwn，而不是裸查表取反
  const hasOwnGuards = (code.match(/!Object\.hasOwn\(SOUND_SETS, setName\)/g) || []).length
  assert.equal(hasOwnGuards, 2,
    `两个 handler 都应用 !Object.hasOwn(SOUND_SETS, setName) 判定，实际命中 ${hasOwnGuards} 处`)
})

test('serveSound 有 Array.isArray 第二道防线', () => {
  assert.ok(
    /const bytes = Array\.isArray\(candidates\) \? loadSound\(candidates\) : null/.test(soundBlock),
    'serveSound 必须先判 Array.isArray 再交给 loadSound',
  )
})
