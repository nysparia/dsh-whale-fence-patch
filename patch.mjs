#!/usr/bin/env node
// dsh-whale-fence-patch —— 给已安装的 dsh-whale-widget 打两个上游 bug 的补丁。
//
// 改 lib/index.js 里的四处：
//   ① connectionFence()           —— 栅栏兼容（DSH >= 0.2.2-rc.2 的 admit）
//   ② rejected() 的栅栏分派        —— 同上
//   ③ root.inject 列表             —— 补 connection.authentication，否则 admit 恒抛
//   ④ 音效路由的原型链查表          —— ?set=__proto__ 等键名导致 400（与栅栏无关的第二个 bug）
// 不复制、不分发上游任何代码或素材；素材仍由用户已安装的上游副本提供。
//
// 用法：
//   node patch.mjs --profile web      # 指定 profile
//   node patch.mjs                    # 遍历 ~/.dsh/profiles/*/node_modules/dsh-whale-widget
//   node patch.mjs --path <dir>       # 直接指定插件目录
//   node patch.mjs --check            # 只报告会改什么，不写
//   node patch.mjs --revert           # 还原

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'

const PKG = 'dsh-whale-widget'
const TARGET_REL = path.join('lib', 'index.js')
const BACKUP_REL = path.join('lib', 'index.js.bak')

// —— 上游 0.4.2 原版的两段目标代码（逐字节匹配，不做模糊定位）——

const ORIGINAL_FENCE = `    function connectionFence() {
      try {
        const conn = ctx.get('connection') || ctx.connection
        return conn && typeof conn.requestRejection === 'function' ? conn : null
      } catch (err) { return null }
    }
`

const PATCHED_FENCE = `    // 宿主栅栏的两种形态：
    //   · DSH <= 0.2.1：connection.requestRejection(req) -> number | undefined
    //   · DSH >= 0.2.2-rc.2：connection.admit(req) -> { peer } | { rejection: 401|403|503 }
    //     （0.2.2-rc.2 的迁移指南移除了 requestRejection，改用 admit）
    // 只认前者会让新版宿主上这层恒为 null —— 401/503 被吞、trustedHosts 权威被误判 403。
    function connectionFence() {
      try {
        const conn = ctx.get('connection') || ctx.connection
        if (!conn) return null
        if (typeof conn.requestRejection === 'function') return conn
        if (typeof conn.admit === 'function') return conn
        return null
      } catch (err) { return null }
    }
`

const ORIGINAL_DISPATCH = `      let code
      try {
        code = conn.requestRejection(req)
      } catch (err) {
`

const PATCHED_DISPATCH = `      let code
      try {
        if (typeof conn.requestRejection === 'function') {
          code = conn.requestRejection(req)
        } else {
          // admit 交回 Peer：{ peer } 放行，{ rejection } 原样透出。
          // 非 owner 的 Peer 一律 403 —— 写配置等于决定"把凭据发往哪里"，
          // 只有本机所有者能做（与 writeRejection 的意图一致）。
          const admission = conn.admit({ headers: req.headers, method: req.method, url: req.url })
          if (admission && admission.rejection) {
            code = admission.rejection
          } else if (admission && admission.peer) {
            const kind = admission.peer.principal && admission.peer.principal.kind
            code = kind !== undefined && kind !== 'owner' ? 403 : undefined
          } else {
            // admit 返回 undefined：这道实现不认得这次请求，不能当放行
            code = 403
          }
        }
      } catch (err) {
`

// 第三处：inject 列表必须包含 connection.authentication。
// 为什么：admit() 内部访问 this.authentication，而 Cordis 的 ctx proxy 会把它
// 解析成 connection.authentication 服务；插件没 inject 这个服务时，属性访问抛
// `cannot get property "connection.authentication" without inject`，
// 于是 admit 每次都抛异常、被 fail-closed 成 403 —— 补丁等于没打。
// 这一条只能在真实 DSH 进程里暴露，进程内模拟测不出来。
const ORIGINAL_INJECT = `    root.inject(['webServer', 'credentials', 'connection'], (ctx) => {`
const PATCHED_INJECT = `    root.inject(['webServer', 'credentials', 'connection', 'connection.authentication'], (ctx) => {`

// 第四处：音效路由的原型链查表崩溃（第二个 bug，与栅栏无关）。
// 症状：GET /dsh-whale/sound/{press,release}.mp3?set=__proto__（或 constructor /
//   toString / valueOf / hasOwnProperty …）返回 400，响应头没有 Content-Type ——
//   那是宿主 webserver 兜底 catch 写的，不是插件自己写的。
// 根因：SOUND_SETS 是普通对象字面量，SOUND_SETS['__proto__'] 返回 Object.prototype、
//   SOUND_SETS['constructor'] 返回 Function，两者都 truthy，于是 `|| SOUND_SETS.duck`
//   的兜底不生效；随后 set.press 是 undefined，loadSound 里 for-of 抛
//   TypeError: candidates is not iterable。
// 修法：查表改走 Object.hasOwn（自定义音效组 group_xxx 也要走 ?set=，所以不能在
//   soundSetFromUrl 里做白名单拒绝），并在 serveSound 里加 Array.isArray 第二道防线。

const ORIGINAL_SOUND = `    function serveSound(req, res, candidates) {
      const bytes = loadSound(candidates)
      if (!bytes) {
        // v752：404 也带 no-store。原来只有 200 分支有缓存头，失败的响应可能被浏览器/中间层
        // 缓存住，一旦缓存就会变成"永久没声音、刷新也没用"。
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' })
        res.end('sound unavailable')
        return
      }
      res.writeHead(200, {
        'Content-Type': 'audio/mpeg',
        'Cache-Control': 'no-store',
        'Content-Length': String(bytes.length),
      })
      res.end(bytes)
    }

    disposers.push(registerRoute({
      kind: 'exact',
      path: '/dsh-whale/sound/press.mp3',
      handler: (req, res) => {
        const set = SOUND_SETS[soundSetFromUrl(req.url)] || SOUND_SETS.duck
        // 自定义音效组：set 为组 id 时按组内 press 片段取音频
        const setName = soundSetFromUrl(req.url)
        if (setName && !SOUND_SETS[setName]) {
          const fragId = groupFragmentId(setName, 'press')
          if (fragId === '') { res.writeHead(204, { 'Cache-Control': 'no-store' }); res.end(); return } // 留空槽：该事件静音（v752：补 no-store，空响应不允许被缓存）
          const bytes = loadAudioFragmentBytes(fragId)
          if (bytes) {
            res.writeHead(200, {
              'Content-Type': fragmentMime(fragId),
              'Cache-Control': 'no-store',
              'Content-Length': String(bytes.length),
            })
            res.end(bytes)
            return
          }
        }
        serveSound(req, res, set.press)
      },
    }))

    disposers.push(registerRoute({
      kind: 'exact',
      path: '/dsh-whale/sound/release.mp3',
      handler: (req, res) => {
        const set = SOUND_SETS[soundSetFromUrl(req.url)] || SOUND_SETS.duck
        const setName = soundSetFromUrl(req.url)
        if (setName && !SOUND_SETS[setName]) {
          const fragId = groupFragmentId(setName, 'release')
          if (fragId === '') { res.writeHead(204, { 'Cache-Control': 'no-store' }); res.end(); return } // 留空槽：该事件静音（v752：补 no-store，空响应不允许被缓存）
          const bytes = loadAudioFragmentBytes(fragId)
          if (bytes) {
            res.writeHead(200, {
              'Content-Type': fragmentMime(fragId),
              'Cache-Control': 'no-store',
              'Content-Length': String(bytes.length),
            })
            res.end(bytes)
            return
          }
        }
        serveSound(req, res, set.release)
      },
    }))
`

const PATCHED_SOUND = `    function serveSound(req, res, candidates) {
      // 第二道防线：candidates 必须是数组。查表若漏了自有属性判定，这里拿到的是
      // undefined / Object.prototype / Function，loadSound 里 for-of 会抛
      // TypeError: candidates is not iterable，被宿主兜底 catch 成 400。
      // 根因见下面 soundSetFor 的注释。
      const bytes = Array.isArray(candidates) ? loadSound(candidates) : null
      if (!bytes) {
        // v752：404 也带 no-store。原来只有 200 分支有缓存头，失败的响应可能被浏览器/中间层
        // 缓存住，一旦缓存就会变成"永久没声音、刷新也没用"。
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' })
        res.end('sound unavailable')
        return
      }
      res.writeHead(200, {
        'Content-Type': 'audio/mpeg',
        'Cache-Control': 'no-store',
        'Content-Length': String(bytes.length),
      })
      res.end(bytes)
    }

    // 查表必须走自有属性。SOUND_SETS 是普通对象字面量：SOUND_SETS['__proto__'] 返回
    // Object.prototype、SOUND_SETS['constructor'] 返回 Function —— 两者都 truthy，
    // 于是 || SOUND_SETS.duck 的兜底不生效，随后 set.press 是 undefined，
    // loadSound 里 for-of 抛 TypeError: candidates is not iterable，被宿主兜底 catch 成 400。
    // ?set=toString / valueOf / hasOwnProperty / isPrototypeOf 等同理。
    // 不能改成在 soundSetFromUrl 里拒绝：自定义音效组（group_xxx）也要走这个参数。
    function soundSetFor(name) {
      return Object.hasOwn(SOUND_SETS, name) ? SOUND_SETS[name] : SOUND_SETS.duck
    }

    disposers.push(registerRoute({
      kind: 'exact',
      path: '/dsh-whale/sound/press.mp3',
      handler: (req, res) => {
        const setName = soundSetFromUrl(req.url)
        const set = soundSetFor(setName)
        // 自定义音效组：set 为组 id 时按组内 press 片段取音频
        if (setName && !Object.hasOwn(SOUND_SETS, setName)) {
          const fragId = groupFragmentId(setName, 'press')
          if (fragId === '') { res.writeHead(204, { 'Cache-Control': 'no-store' }); res.end(); return } // 留空槽：该事件静音（v752：补 no-store，空响应不允许被缓存）
          const bytes = loadAudioFragmentBytes(fragId)
          if (bytes) {
            res.writeHead(200, {
              'Content-Type': fragmentMime(fragId),
              'Cache-Control': 'no-store',
              'Content-Length': String(bytes.length),
            })
            res.end(bytes)
            return
          }
        }
        serveSound(req, res, set.press)
      },
    }))

    disposers.push(registerRoute({
      kind: 'exact',
      path: '/dsh-whale/sound/release.mp3',
      handler: (req, res) => {
        const setName = soundSetFromUrl(req.url)
        const set = soundSetFor(setName)
        if (setName && !Object.hasOwn(SOUND_SETS, setName)) {
          const fragId = groupFragmentId(setName, 'release')
          if (fragId === '') { res.writeHead(204, { 'Cache-Control': 'no-store' }); res.end(); return } // 留空槽：该事件静音（v752：补 no-store，空响应不允许被缓存）
          const bytes = loadAudioFragmentBytes(fragId)
          if (bytes) {
            res.writeHead(200, {
              'Content-Type': fragmentMime(fragId),
              'Cache-Control': 'no-store',
              'Content-Length': String(bytes.length),
            })
            res.end(bytes)
            return
          }
        }
        serveSound(req, res, set.release)
      },
    }))
`
// 打过补丁才有的标记（用于幂等判定与 revert 反向替换）
const MARK_FENCE = `        if (typeof conn.admit === 'function') return conn`
const MARK_DISPATCH = `          const admission = conn.admit({ headers: req.headers, method: req.method, url: req.url })`
const MARK_INJECT = `'connection.authentication'], (ctx) => {`
const MARK_SOUND = `      const bytes = Array.isArray(candidates) ? loadSound(candidates) : null`

// —— 参数 ——

function parseArgs(argv) {
  const opts = { profile: null, dir: null, check: false, revert: false, help: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--profile') opts.profile = argv[++i] ?? null
    else if (a === '--path') opts.dir = argv[++i] ?? null
    else if (a === '--check') opts.check = true
    else if (a === '--revert') opts.revert = true
    else if (a === '--help' || a === '-h') opts.help = true
    else {
      console.error(`未知参数：${a}`)
      process.exit(2)
    }
  }
  if (opts.profile && opts.dir) {
    console.error('--profile 与 --path 不能同时使用')
    process.exit(2)
  }
  return opts
}

const USAGE = `用法：
  node patch.mjs --profile <name>   给 ~/.dsh/profiles/<name> 下的 dsh-whale-widget 打补丁
  node patch.mjs                    遍历 ~/.dsh/profiles/*/node_modules/dsh-whale-widget
  node patch.mjs --path <dir>       直接指定插件目录（或含 node_modules/dsh-whale-widget 的目录）
  node patch.mjs --check            只报告会改什么，不写文件
  node patch.mjs --revert           还原到打补丁前（优先用 lib/index.js.bak）`

// —— 定位 ——

function looksLikePlugin(dir) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
    return pkg.name === PKG && fs.existsSync(path.join(dir, TARGET_REL))
  } catch (err) { return false }
}

function resolveTargets(opts) {
  if (opts.dir) {
    const abs = path.resolve(opts.dir)
    if (looksLikePlugin(abs)) return [abs]
    const nested = path.join(abs, 'node_modules', PKG)
    if (looksLikePlugin(nested)) return [nested]
    if (fs.existsSync(path.join(abs, TARGET_REL))) return [abs] // 没有 package.json 也认，交给后面报错
    console.error(`在 ${abs} 找不到 ${PKG}（既不是插件目录，也没有 node_modules/${PKG}）`)
    process.exit(1)
  }
  const profilesRoot = path.join(os.homedir(), '.dsh', 'profiles')
  if (opts.profile) {
    const dir = path.join(profilesRoot, opts.profile, 'node_modules', PKG)
    if (!looksLikePlugin(dir)) {
      console.error(`profile "${opts.profile}" 下没有安装 ${PKG}：${dir}`)
      process.exit(1)
    }
    return [dir]
  }
  let names = []
  try { names = fs.readdirSync(profilesRoot) } catch (err) {
    console.error(`读不到 ${profilesRoot}：${err.message}`)
    process.exit(1)
  }
  const found = names
    .map((n) => path.join(profilesRoot, n, 'node_modules', PKG))
    .filter(looksLikePlugin)
  if (found.length === 0) {
    console.error(`在 ${profilesRoot}/*/node_modules/${PKG} 没找到已安装的插件。用 --path 指定目录。`)
    process.exit(1)
  }
  return found
}

// —— 版本漂移保护 ——

function countOf(hay, needle) {
  let n = 0
  let i = hay.indexOf(needle)
  while (i >= 0) { n++; i = hay.indexOf(needle, i + 1) }
  return n
}

function snippetAround(src, needles) {
  const list = Array.isArray(needles) ? needles : [needles]
  for (const needle of list) {
    const i = src.indexOf(needle)
    if (i < 0) continue
    const start = Math.max(0, i - 200)
    const end = Math.min(src.length, i + needle.length + 200)
    const firstLine = src.slice(0, start).split('\n').length // 片段起始处的真实行号
    return src.slice(start, end).split('\n')
      .map((l, k) => `    ${String(firstLine + k).padStart(6)} | ${l.length > 160 ? l.slice(0, 160) + ' …' : l}`)
      .join('\n')
  }
  return '    （连锚点都找不到）'
}

// 返回 { state: 'patched' | 'original' } 或抛错（漂移）
const MARK_COUNT = 4

function inspect(src) {
  const marks = {
    connectionFence: src.includes(MARK_FENCE),
    rejected分派: src.includes(MARK_DISPATCH),
    inject列表: src.includes(MARK_INJECT),
    音效查表: src.includes(MARK_SOUND),
  }
  const hit = Object.values(marks).filter(Boolean).length
  if (hit === MARK_COUNT) return { state: 'patched' }

  if (hit > 0) {
    // 只打了一部分：可能是别的补丁、或上游改过其中一处。不猜，直接失败。
    const err = new Error(
      `文件处于"半打补丁"状态：${MARK_COUNT} 处标记只命中 ${hit} 处。`
      + '\n  ' + Object.entries(marks).map(([k, v]) => `${k} 已改：${v ? '是' : '否'}`).join('\n  ')
      + '\n  请先 --revert，或手动核对后再跑。',
    )
    err.drift = true
    throw err
  }

  const counts = {
    connectionFence: countOf(src, ORIGINAL_FENCE),
    rejected分派: countOf(src, ORIGINAL_DISPATCH),
    inject列表: countOf(src, ORIGINAL_INJECT),
    音效查表: countOf(src, ORIGINAL_SOUND),
  }
  if (Object.values(counts).every((n) => n === 1)) return { state: 'original' }

  // 四处都报，别让用户改完一处再撞下一处
  const hints = {
    connectionFence: ['function connectionFence()', 'connectionFence'],
    rejected分派: ['code = conn.requestRejection(req)', 'conn.requestRejection(req)', 'requestRejection'],
    inject列表: ["root.inject(['webServer'", 'root.inject(', 'inject('],
    音效查表: ['function serveSound(req, res, candidates)', 'serveSound(', 'SOUND_SETS['],
  }
  const problems = Object.entries(counts)
    .filter(([, n]) => n !== 1)
    .map(([name, n]) => `找不到 ${name} 的目标代码块（命中 ${n} 次，期望 1 次）。`
      + '\n上游可能改过这段。实际找到的内容片段：\n'
      + snippetAround(src, hints[name]))
  const err = new Error(problems.join('\n\n'))
  err.drift = true
  throw err
}

function applyPatch(src) {
  return src.replace(ORIGINAL_FENCE, PATCHED_FENCE)
    .replace(ORIGINAL_DISPATCH, PATCHED_DISPATCH)
    .replace(ORIGINAL_INJECT, PATCHED_INJECT)
    .replace(ORIGINAL_SOUND, PATCHED_SOUND)
}

function reversePatch(src) {
  return src.replace(PATCHED_FENCE, ORIGINAL_FENCE)
    .replace(PATCHED_DISPATCH, ORIGINAL_DISPATCH)
    .replace(PATCHED_INJECT, ORIGINAL_INJECT)
    .replace(PATCHED_SOUND, ORIGINAL_SOUND)
}

// —— 语法校验 ——

function syntaxOk(file) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' })
    return { ok: true }
  } catch (err) {
    const msg = (err.stderr && err.stderr.toString()) || err.message
    return { ok: false, msg: msg.trim().split('\n').slice(0, 6).join('\n') }
  }
}

// —— 主流程 ——

function readVersion(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version || '未知' } catch (err) { return '未知' }
}

function doPatch(dir, opts) {
  const file = path.join(dir, TARGET_REL)
  const backup = path.join(dir, BACKUP_REL)
  const version = readVersion(dir)
  console.log(`\n插件目录：${dir}`)
  console.log(`上游版本：${PKG}@${version}`)

  if (!fs.existsSync(file)) {
    console.error(`缺少 ${file}`)
    return 1
  }
  const src = fs.readFileSync(file, 'utf8')

  let info
  try { info = inspect(src) } catch (err) {
    console.error(`\n失败：${err.message}`)
    console.error('\n未写入任何文件。')
    return 1
  }

  if (info.state === 'patched') {
    console.log('状态：已是最新（补丁已在位），无需改动。')
    return 0
  }

  const next = applyPatch(src)
  if (next === src) {
    console.error('失败：替换后内容未变化，说明锚点匹配异常。未写入。')
    return 1
  }
  const added = next.split('\n').length - src.split('\n').length
  console.log(`状态：待打补丁（将新增 ${added} 行）`)

  if (opts.check) {
    console.log('--check：只报告，不写文件。')
    return 0
  }

  // 备份（已存在则不覆盖，保留最早的原始副本）
  if (fs.existsSync(backup)) {
    console.log(`备份：${BACKUP_REL} 已存在，保留不覆盖。`)
  } else {
    fs.writeFileSync(backup, src)
    console.log(`备份：已写入 ${BACKUP_REL}`)
  }

  fs.writeFileSync(file, next)
  const chk = syntaxOk(file)
  if (!chk.ok) {
    fs.writeFileSync(file, src)
    console.error('失败：node --check 未通过，已回滚到原内容。')
    console.error(chk.msg)
    return 1
  }
  console.log('语法：node --check 通过')
  console.log('完成：补丁已应用。重启 dsh 后生效。')
  return 0
}

function doRevert(dir, opts) {
  const file = path.join(dir, TARGET_REL)
  const backup = path.join(dir, BACKUP_REL)
  const version = readVersion(dir)
  console.log(`\n插件目录：${dir}`)
  console.log(`上游版本：${PKG}@${version}`)

  if (!fs.existsSync(file)) {
    console.error(`缺少 ${file}`)
    return 1
  }
  const src = fs.readFileSync(file, 'utf8')

  // 先看当前状态：本来就是原版就直接收工，别把备份再写一遍
  let current = null
  try { current = inspect(src) } catch (err) { current = null }
  if (current && current.state === 'original') {
    console.log('状态：本来就是原版（补丁不在位），无需还原。')
    return 0
  }

  let target = null
  let how = ''
  if (fs.existsSync(backup)) {
    const bak = fs.readFileSync(backup, 'utf8')
    // 备份必须是"未打补丁"的原版，否则不用它（避免把别的状态写回去）
    let bakClean = false
    try { bakClean = inspect(bak).state === 'original' } catch (err) { bakClean = false }
    if (bakClean) { target = bak; how = `备份文件 ${BACKUP_REL} ` }
  }
  if (target === null) {
    let info
    try { info = inspect(src) } catch (err) {
      console.error(`\n失败：${err.message}`)
      console.error('\n未写入任何文件。')
      return 1
    }
    if (info.state === 'original') {
      console.log('状态：本来就是原版（补丁不在位），无需还原。')
      return 0
    }
    target = reversePatch(src)
    how = '反向替换'
    if (target === src) {
      console.error('失败：反向替换未产生变化。未写入。')
      return 1
    }
  }

  if (opts.check) {
    console.log(`--check：将用${how}还原，不写文件。`)
    return 0
  }

  fs.writeFileSync(file, target)
  const chk = syntaxOk(file)
  if (!chk.ok) {
    fs.writeFileSync(file, src)
    console.error('失败：还原后 node --check 未通过，已回滚。')
    console.error(chk.msg)
    return 1
  }
  console.log(`还原：已用${how}还原 ${TARGET_REL}`)
  console.log('语法：node --check 通过')
  return 0
}

function main() {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.help) { console.log(USAGE); return 0 }
  const targets = resolveTargets(opts)
  let rc = 0
  for (const dir of targets) {
    rc = (opts.revert ? doRevert(dir, opts) : doPatch(dir, opts)) || rc
  }
  return rc
}

process.exit(main())
