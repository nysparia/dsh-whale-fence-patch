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
