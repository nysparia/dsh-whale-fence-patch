#!/usr/bin/env node
// dsh-whale-fence-patch —— 给已安装的 dsh-whale-widget 打上游 bug 的补丁。
//
// 改**两个**文件：
//
// 【lib/index.js】十组（共 30 个锚点）：
//   ① connectionFence()           —— 栅栏兼容（DSH >= 0.2.2-rc.2 的 admit）
//   ② rejected() 的栅栏分派        —— 同上
//   ③ root.inject 列表             —— 补 connection.authentication，否则 admit 恒抛
//   ④ 音效路由的原型链查表          —— ?set=__proto__ 等键名导致 400
//   ⑤ body 超限返回 413            —— readBodyLimited + 9 处 catch 透出 err.status
//   ⑥ 三个 POST-only 路由的方法守卫  —— GET 打进来 405 而不是 400
//   ⑦ 2027 年节假日 + 覆盖终点下发   —— HOLIDAY_VALLEY 补 29 条，下发 peakHolidaysCoveredThrough
//   ⑧ 配置文件损坏备份              —— backupCorruptFile + 四个读取函数
//   ⑨ waitState 跨会话状态污染       —— 按会话分桶 + waitView() 选一个会话上报（子 agent 不再清主会话挂起）
//   ⑩ 账本 IO 退避 + update-check 去重 —— Atomics.wait 退避 305ms→25ms；并发只打一轮上游
//
// 【assets/whale-widget.js】两组（共 15 个锚点）：
//   ⑪ issue #339：onDocPointerMoveCursor 每次 pointermove 都强制同步布局
//      —— rAF 节流 + 用 e.target 代替 elementFromPoint + 矩形/命中图 alpha 表缓存
//   ⑫ issue #342：每秒轮询无 in-flight 守卫、页面隐藏时不暂停
//      —— 两个 poll 各加 busy 守卫 + document.hidden 跳过 + visibilitychange 回前台补一次
//
// 不复制、不分发上游任何代码或素材；素材仍由用户已安装的上游副本提供。
//
// 用法：
//   node patch.mjs --profile web      # 指定 profile
//   node patch.mjs                    # 遍历 ~/.dsh/profiles/*/node_modules/dsh-whale-widget
//   node patch.mjs --path <dir>       # 直接指定插件目录
//   node patch.mjs --check            # 只报告会改什么，不写
//   node patch.mjs --revert           # 还原（两个文件一起还原）

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'

const PKG = 'dsh-whale-widget'
// 补丁要改**两个**文件：
//   lib/index.js         —— 宿主侧（Node）：栅栏、路由、配置读写、轮询状态
//   assets/whale-widget.js —— 前端侧（浏览器）：命中测试、光标判定、每秒轮询
// 每个锚点用 file 字段标注归属；inspect/applyPatch/reversePatch 都按文件分组处理。
const HOST_REL = path.join('lib', 'index.js')
const FRONT_REL = path.join('assets', 'whale-widget.js')
const TARGET_FILES = [HOST_REL, FRONT_REL]
const backupRel = (rel) => rel + '.bak'

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

// ===== 第五处：body 超限返回 413 而不是断连 =====
// 症状：POST 一个超过上限的 body（如 600KB 打到 512KB 上限的 /dsh-whale/bubble.json）
//   得到 curl exit=56（连接被重置）、状态码 000，而不是 413。
// 根因：readBodyMax 超限时先 reject 再 req.destroy()。destroy 直接销毁 socket，
//   调用方随后写出的 413 根本到不了客户端。
// 修法：抽出 readBodyLimited，超限时 req.resume() 排空剩余 body，错误带 status=413；
//   readBody / readBodyMax 都委托给它。
const ORIGINAL_BODY = `    function readBody(req) {
      return new Promise((resolve, reject) => {
        const chunks = []
        let size = 0
        req.on('data', (c) => {
          size += c.length
          if (size > 8192) {
            reject(new Error('body too large'))
            req.destroy()
            return
          }
          chunks.push(c)
        })
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
        req.on('error', reject)
      })
    }

    function readBodyMax(req, maxBytes) {
      return new Promise((resolve, reject) => {
        const chunks = []
        let size = 0
        req.on('data', (c) => {
          size += c.length
          if (size > maxBytes) {
            reject(new Error('body too large'))
            req.destroy()
            return
          }
          chunks.push(c)
        })
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
        req.on('error', reject)
      })
    }
`
const PATCHED_BODY = `    // 读请求体，超过上限时抛一个带 status=413 的错误。
    //
    // 关键：超限时**不能** req.destroy()。destroy 会直接销毁 socket，调用方随后写出的
    // 413 根本到不了客户端 —— 实测 600KB body 打到 512KB 上限的 /dsh-whale/bubble.json
    // 得到的是 curl exit=56（连接被重置）、状态码 000，而不是 413。
    // 改成：标记 overflow、丢弃后续 chunk（流已在 flowing 模式，等于把剩余 body 排空），
    // 让调用方能在同一条连接上正常写响应。与 DSH 自己的 readBoundedBody 同一做法
    // （packages/host/open-in-app/src/index.ts:93，那里也是 resume() 后返回 null）。
    function readBodyLimited(req, maxBytes) {
      return new Promise((resolve, reject) => {
        const chunks = []
        let size = 0
        let overflow = false
        req.on('data', (c) => {
          if (overflow) return // 已超限：继续吃掉剩余数据，别让客户端撞 RST
          size += c.length
          if (size > maxBytes) {
            overflow = true
            chunks.length = 0
            req.resume()
            const error = new Error('body too large')
            error.status = 413
            reject(error)
            return
          }
          chunks.push(c)
        })
        req.on('end', () => { if (!overflow) resolve(Buffer.concat(chunks).toString('utf8')) })
        req.on('error', (err) => { if (!overflow) reject(err) })
      })
    }

    function readBody(req) {
      return readBodyLimited(req, 8192)
    }

    function readBodyMax(req, maxBytes) {
      return readBodyLimited(req, maxBytes)
    }
`
const MARK_BODY = `    function readBodyLimited(req, maxBytes) {`

// 第五处（续）：9 处 catch 把 400 写死，超限的 413 被压回 400。
// 只改**在 catch (err) 里**的那些；业务错误（cannot delete default role / invalid image data /
// unknown action …）必须保持 400 —— 它们不是 readBodyMax 抛的，没有 status。
// 每项 [原文, 补丁后]，原文在文件里必须恰好出现 1 次。
const CATCH_400_FIXES = [
  [
    `          } catch (err) {
            res.writeHead(400, JSON_HEADERS)
            res.end(JSON.stringify({ ok: false, error: String((err && err.message) || err) }))
`,
    `          } catch (err) {
            res.writeHead(err.status || 400, JSON_HEADERS)
            res.end(JSON.stringify({ ok: false, error: String((err && err.message) || err) }))
`,
  ],
  [
    `        } catch (err) {
          res.writeHead(400, JSON_HEADERS)
          res.end(JSON.stringify({ ok: false, error: String((err && err.message) || err) }))
`,
    `        } catch (err) {
          res.writeHead(err.status || 400, JSON_HEADERS)
          res.end(JSON.stringify({ ok: false, error: String((err && err.message) || err) }))
`,
  ],
  [
    `          res.end(JSON.stringify(payload))
        } catch (err) {
          res.writeHead(400, JSON_HEADERS)
          res.end(JSON.stringify({ ok: false, error: String((err && err.message) || err).slice(0, 200) }))
`,
    `          res.end(JSON.stringify(payload))
        } catch (err) {
          res.writeHead(err.status || 400, JSON_HEADERS)
          res.end(JSON.stringify({ ok: false, error: String((err && err.message) || err).slice(0, 200) }))
`,
  ],
  [
    `            res.end(JSON.stringify(rolesPayload()))
          } catch (err) {
            res.writeHead(400, JSON_HEADERS)
            res.end(JSON.stringify({ ok: false, error: String((err && err.message) || err).slice(0, 200) }))
`,
    `            res.end(JSON.stringify(rolesPayload()))
          } catch (err) {
            res.writeHead(err.status || 400, JSON_HEADERS)
            res.end(JSON.stringify({ ok: false, error: String((err && err.message) || err).slice(0, 200) }))
`,
  ],
  [
    `          writeRolesIndex(index)
          res.writeHead(200, JSON_HEADERS)
          res.end(JSON.stringify(rolesPayload()))
        } catch (err) {
          res.writeHead(400, JSON_HEADERS)
          res.end(JSON.stringify({ ok: false, error: String((err && err.message) || err).slice(0, 200) }))
`,
    `          writeRolesIndex(index)
          res.writeHead(200, JSON_HEADERS)
          res.end(JSON.stringify(rolesPayload()))
        } catch (err) {
          res.writeHead(err.status || 400, JSON_HEADERS)
          res.end(JSON.stringify({ ok: false, error: String((err && err.message) || err).slice(0, 200) }))
`,
  ],
  [
    `          if (p) { try { fs.unlinkSync(p) } catch (err) {} }
          res.writeHead(200, JSON_HEADERS)
          res.end(JSON.stringify(rolesPayload()))
        } catch (err) {
          res.writeHead(400, JSON_HEADERS)
          res.end(JSON.stringify({ ok: false, error: String((err && err.message) || err).slice(0, 200) }))
`,
    `          if (p) { try { fs.unlinkSync(p) } catch (err) {} }
          res.writeHead(200, JSON_HEADERS)
          res.end(JSON.stringify(rolesPayload()))
        } catch (err) {
          res.writeHead(err.status || 400, JSON_HEADERS)
          res.end(JSON.stringify({ ok: false, error: String((err && err.message) || err).slice(0, 200) }))
`,
  ],
  [
    `            res.end(JSON.stringify({ ok: false, error: 'unknown action' }))
          } catch (err) {
            res.writeHead(400, JSON_HEADERS)
            res.end(JSON.stringify({ ok: false, error: String((err && err.message) || err).slice(0, 200) }))
`,
    `            res.end(JSON.stringify({ ok: false, error: 'unknown action' }))
          } catch (err) {
            res.writeHead(err.status || 400, JSON_HEADERS)
            res.end(JSON.stringify({ ok: false, error: String((err && err.message) || err).slice(0, 200) }))
`,
  ],
  [
    `          res.end(JSON.stringify({ ok: true, config: cfg }))
        } catch (err) {
          res.writeHead(400, JSON_HEADERS)
          res.end(JSON.stringify({ ok: false, error: String((err && err.message) || err).slice(0, 200) }))
`,
    `          res.end(JSON.stringify({ ok: true, config: cfg }))
        } catch (err) {
          res.writeHead(err.status || 400, JSON_HEADERS)
          res.end(JSON.stringify({ ok: false, error: String((err && err.message) || err).slice(0, 200) }))
`,
  ],
  [
    `          res.end(JSON.stringify({ ok: false, error: 'unknown action' }))
        } catch (err) {
          res.writeHead(400, JSON_HEADERS)
          res.end(JSON.stringify({ ok: false, error: String((err && err.message) || err).slice(0, 200) }))
`,
    `          res.end(JSON.stringify({ ok: false, error: 'unknown action' }))
        } catch (err) {
          res.writeHead(err.status || 400, JSON_HEADERS)
          res.end(JSON.stringify({ ok: false, error: String((err && err.message) || err).slice(0, 200) }))
`,
  ],
]

const ORIGINAL_GUARD_PIN = `      path: '/dsh-whale/role-pin.json',
      handler: async (req, res) => {
        try {
`
const PATCHED_GUARD_PIN = `      path: '/dsh-whale/role-pin.json',
      handler: async (req, res) => {
        // 纯写接口：没有只读语义，GET 必须 405 而不是「读空 body → JSON.parse('') → 400」。
        if (req.method !== 'POST' && req.method !== 'PUT') {
          res.writeHead(405, { ...JSON_HEADERS, Allow: 'POST, PUT' })
          res.end(JSON.stringify({ ok: false, error: '不支持的请求方法' }))
          return
        }
        try {
`
const MARK_GUARD_PIN = PATCHED_GUARD_PIN

const ORIGINAL_GUARD_DELETE = `      path: '/dsh-whale/role-delete.json',
      handler: async (req, res) => {
        try {
`
const PATCHED_GUARD_DELETE = `      path: '/dsh-whale/role-delete.json',
      handler: async (req, res) => {
        // 纯写接口：GET 打进来必须 405，不能落到「空 body → JSON.parse 抛错 → 400」。
        if (req.method !== 'POST' && req.method !== 'PUT') {
          res.writeHead(405, { ...JSON_HEADERS, Allow: 'POST, PUT' })
          res.end(JSON.stringify({ ok: false, error: '不支持的请求方法' }))
          return
        }
        try {
`
const MARK_GUARD_DELETE = PATCHED_GUARD_DELETE

const ORIGINAL_GUARD_UPLOAD = `      path: '/dsh-whale/bubble-img-upload.json',
      handler: async (req, res) => {
        try {
`
const PATCHED_GUARD_UPLOAD = `      path: '/dsh-whale/bubble-img-upload.json',
      handler: async (req, res) => {
        // 纯写接口（upload / delete 两个 action 都改磁盘）：GET 必须 405。
        if (req.method !== 'POST' && req.method !== 'PUT') {
          res.writeHead(405, { ...JSON_HEADERS, Allow: 'POST, PUT' })
          res.end(JSON.stringify({ ok: false, error: '不支持的请求方法' }))
          return
        }
        try {
`
const MARK_GUARD_UPLOAD = PATCHED_GUARD_UPLOAD

const ORIGINAL_HOLIDAY = `// ===== 法定节假日全天谷价（官方 2026-09-19 说明）=====
// 依据：《国务院办公厅关于 2026 年部分节假日安排的通知》（国办发明电〔2025〕7 号，2025-11-04）
//       + DeepSeek API 官方计费脚注「周一至周五（不含中国法定节假日）…其余时段，包括周末及
//       中国法定节假日全天均为空闲时段」。
// 只需列**放假**的日期：调休上班日全部落在周末（2026 年为 1/4、2/14、2/28、5/9、9/20、10/10），
// 按"周末也算谷价"的规则本来就是谷价，无需单列。
// ⚠️ **每年 11 月国务院发布次年安排后，必须在这里补下一年的日期**（探针 \`_peak-holiday-check.mjs\`
// 会检查当年是否已覆盖并给出提醒）。
const HOLIDAY_VALLEY = {
  '2026-01-01': 1, '2026-01-02': 1, '2026-01-03': 1, // 元旦 1/1–1/3（1/4 周日上班）
  '2026-02-15': 1, '2026-02-16': 1, '2026-02-17': 1, '2026-02-18': 1, '2026-02-19': 1, // 春节 2/15–2/23（9 天）
  '2026-02-20': 1, '2026-02-21': 1, '2026-02-22': 1, '2026-02-23': 1,
  '2026-04-04': 1, '2026-04-05': 1, '2026-04-06': 1, // 清明 4/4–4/6
  '2026-05-01': 1, '2026-05-02': 1, '2026-05-03': 1, '2026-05-04': 1, '2026-05-05': 1, // 劳动节 5/1–5/5（5/9 周六上班）
  '2026-06-19': 1, '2026-06-20': 1, '2026-06-21': 1, // 端午 6/19–6/21
  '2026-09-25': 1, '2026-09-26': 1, '2026-09-27': 1, // 中秋 9/25–9/27
  '2026-10-01': 1, '2026-10-02': 1, '2026-10-03': 1, '2026-10-04': 1, // 国庆 10/1–10/7（9/20 周日、10/10 周六上班）
  '2026-10-05': 1, '2026-10-06': 1, '2026-10-07': 1,
}
`
const PATCHED_HOLIDAY = `// ===== 法定节假日全天谷价（官方 2026-09-19 说明）=====
// 依据：DeepSeek API 官方计费脚注「周一至周五（不含中国法定节假日）…其余时段，包括周末及
//       中国法定节假日全天均为空闲时段」+ 国务院办公厅逐年发布的节假日安排通知：
//   · 2026 年：《国务院办公厅关于 2026 年部分节假日安排的通知》
//             国办发明电〔2025〕7 号，2025-11-04
//   · 2027 年：《国务院办公厅关于 2027 年部分节假日安排的通知》
//             国办发明电〔2026〕10 号，2026-11-05
//              https://www.gov.cn/zhengce/content/202611/content_7085101.htm
// 只需列**放假**的日期：调休上班日全部落在周末（2026 年为 1/4、2/14、2/28、5/9、9/20、10/10；
// 2027 年为 1/31、2/14、5/8、9/26、10/9），按"周末也算谷价"的规则本来就是谷价，无需单列。
// ⚠️ **每年 11 月国务院发布次年安排后，必须在这里补下一年的日期**。
// 覆盖范围：2026 全年 + 2027 全年（截至 2027-12-31）。2028 年及以后尚未公布，
// 届时 \`isHolidayValley()\` 查不到会退回普通峰谷判断（即节假日按高峰计价）——
// 这是已知的、可预测的降级行为，不是静默错误：\`HOLIDAY_VALLEY_COVERED_THROUGH\` 记录覆盖终点。
const HOLIDAY_VALLEY = {
  '2026-01-01': 1, '2026-01-02': 1, '2026-01-03': 1, // 元旦 1/1–1/3（1/4 周日上班）
  '2026-02-15': 1, '2026-02-16': 1, '2026-02-17': 1, '2026-02-18': 1, '2026-02-19': 1, // 春节 2/15–2/23（9 天）
  '2026-02-20': 1, '2026-02-21': 1, '2026-02-22': 1, '2026-02-23': 1,
  '2026-04-04': 1, '2026-04-05': 1, '2026-04-06': 1, // 清明 4/4–4/6
  '2026-05-01': 1, '2026-05-02': 1, '2026-05-03': 1, '2026-05-04': 1, '2026-05-05': 1, // 劳动节 5/1–5/5（5/9 周六上班）
  '2026-06-19': 1, '2026-06-20': 1, '2026-06-21': 1, // 端午 6/19–6/21
  '2026-09-25': 1, '2026-09-26': 1, '2026-09-27': 1, // 中秋 9/25–9/27
  '2026-10-01': 1, '2026-10-02': 1, '2026-10-03': 1, '2026-10-04': 1, // 国庆 10/1–10/7（9/20 周日、10/10 周六上班）
  '2026-10-05': 1, '2026-10-06': 1, '2026-10-07': 1,
  // —— 2027 年（国办发明电〔2026〕10 号，2026-11-05 发布）——
  '2027-01-01': 1, '2027-01-02': 1, '2027-01-03': 1, // 元旦 1/1（周五）–1/3（周日），3 天
  // 春节 2/5（除夕，周五）–2/13（正月初八，周六），9 天；调休上班 1/31（周日）、2/14（周日）
  '2027-02-05': 1, '2027-02-06': 1, '2027-02-07': 1, '2027-02-08': 1, '2027-02-09': 1,
  '2027-02-10': 1, '2027-02-11': 1, '2027-02-12': 1, '2027-02-13': 1,
  '2027-04-03': 1, '2027-04-04': 1, '2027-04-05': 1, // 清明 4/3（周六）–4/5（周一），3 天
  '2027-05-01': 1, '2027-05-02': 1, '2027-05-03': 1, '2027-05-04': 1, '2027-05-05': 1, // 劳动节 5/1（周六）–5/5（周三），5 天（5/8 周六上班）
  '2027-06-09': 1, // 端午 6/9（周三），1 天
  '2027-09-15': 1, // 中秋 9/15（周三），1 天
  // 国庆 10/1（周五）–10/7（周四），7 天；调休上班 9/26（周日）、10/9（周六）
  '2027-10-01': 1, '2027-10-02': 1, '2027-10-03': 1, '2027-10-04': 1,
  '2027-10-05': 1, '2027-10-06': 1, '2027-10-07': 1,
}
// 节假日表覆盖到的最后一天（含）。用于自检/探针判断"下一年是否该补了"，
// 也下发给前端，让挂件在超出覆盖范围时能明确降级而不是静默算错。
const HOLIDAY_VALLEY_COVERED_THROUGH = '2027-12-31'
`
const MARK_HOLIDAY = `const HOLIDAY_VALLEY_COVERED_THROUGH = '2027-12-31'`

const ORIGINAL_HOLIDAY_FIELD = `        peakHolidays: HOLIDAY_VALLEY_LIST,
`
const PATCHED_HOLIDAY_FIELD = `        peakHolidays: HOLIDAY_VALLEY_LIST,
        // 清单覆盖到的最后一天：前端据此判断"当前日期已超出已知安排"，超出时降级为
        // 只按周末+时段推算，而不是把未知节假日当成普通工作日（静默算错）。
        peakHolidaysCoveredThrough: HOLIDAY_VALLEY_COVERED_THROUGH,
`
const MARK_HOLIDAY_FIELD = `        peakHolidaysCoveredThrough: HOLIDAY_VALLEY_COVERED_THROUGH,`

const ORIGINAL_BACKUP_HELPER = `        console.error('[whale-ledger] 账本损坏（' + why + '）且备份失败：', (err && err.code) || (err && err.message)) 
      }
    }
    function readUsageLedger() {
`
const PATCHED_BACKUP_HELPER = `        console.error('[whale-ledger] 账本损坏（' + why + '）且备份失败：', (err && err.code) || (err && err.message)) 
      }
    }
    // v861：账本之外的四份 JSON 配置（泡泡配置 / 角色索引 / 音效索引 / 泡泡图库索引）
    //   此前**没有**损坏保护：解析失败 → 静默返回默认结构 → 下一次写入直接覆盖坏文件，
    //   坏内容永久丢失（实测：写坏 .dshw-bubble.json 后 GET 返回 config:null，POST 一次就没了）。
    //   这里与账本同一做法：把坏文件**改名备份**（.corrupt-<时间戳>.bak）→ 用默认结构继续跑。
    //   · 只在「文件存在但解析失败」时调用；ENOENT 是首次运行的正常情况，不备份；
    //   · 备份失败（目录只读 / 文件被占用）**不能**阻止插件工作：catch 住，只打日志。
    function backupCorruptFile(p, why, tag) {
      const label = tag || 'whale-data'
      try {
        const bak = p + '.corrupt-' + Date.now() + '.bak'
        fs.renameSync(p, bak)
        console.error('[' + label + '] 配置文件损坏（' + why + '）→ 已备份为 ' + bak + '，并用默认结构重建（原文件未删除）')
        return bak
      } catch (err) {
        console.error('[' + label + '] 配置文件损坏（' + why + '）且备份失败：', (err && err.code) || (err && err.message))
        return null
      }
    }
    function readUsageLedger() {
`
const MARK_BACKUP_HELPER = `    function backupCorruptFile(p, why, tag) {`

const ORIGINAL_READ_ROLES = `    function readRolesIndex() {
      const dir = pickRoleDir()
      try {
        const parsed = JSON.parse(fs.readFileSync(path.join(dir, ROLE_INDEX_NAME), 'utf8'))
        if (parsed && Array.isArray(parsed.roles)) {
          if (!parsed.roles.some((r) => r && r.id === ROLE_DEFAULT_ID)) {
            parsed.roles.unshift(defaultRolesIndex().roles[0])
          }
          return parsed
        }
      } catch (err) {}
      return defaultRolesIndex()
    }
`
const PATCHED_READ_ROLES = `    function readRolesIndex() {
      const dir = pickRoleDir()
      const p = path.join(dir, ROLE_INDEX_NAME)
      let raw = null
      try {
        raw = fs.readFileSync(p, 'utf8')
      } catch (err) {
        // ENOENT = 还没建过索引，正常情况，不备份
        if (err.code !== 'ENOENT') backupCorruptFile(p, (err && err.code) || 'read-error', 'whale-roles')
        return defaultRolesIndex()
      }
      try {
        const parsed = JSON.parse(raw)
        if (parsed && Array.isArray(parsed.roles)) {
          if (!parsed.roles.some((r) => r && r.id === ROLE_DEFAULT_ID)) {
            parsed.roles.unshift(defaultRolesIndex().roles[0])
          }
          return parsed
        }
        backupCorruptFile(p, 'bad-structure', 'whale-roles')
      } catch (err) {
        backupCorruptFile(p, 'bad-json', 'whale-roles')
      }
      return defaultRolesIndex()
    }
`
const MARK_READ_ROLES = `        backupCorruptFile(p, 'bad-json', 'whale-roles')`

const ORIGINAL_READ_AUDIO = `    function readAudioIndex() {
      const dir = pickAudioDir()
      try {
        const parsed = JSON.parse(fs.readFileSync(path.join(dir, AUDIO_INDEX_NAME), 'utf8'))
        if (parsed && Array.isArray(parsed.groups) && Array.isArray(parsed.fragments)) {
          return parsed
        }
      } catch (err) {}
      return defaultAudioIndex()
    }
`
const PATCHED_READ_AUDIO = `    function readAudioIndex() {
      const dir = pickAudioDir()
      const p = path.join(dir, AUDIO_INDEX_NAME)
      let raw = null
      try {
        raw = fs.readFileSync(p, 'utf8')
      } catch (err) {
        if (err.code !== 'ENOENT') backupCorruptFile(p, (err && err.code) || 'read-error', 'whale-audio')
        return defaultAudioIndex()
      }
      try {
        const parsed = JSON.parse(raw)
        if (parsed && Array.isArray(parsed.groups) && Array.isArray(parsed.fragments)) {
          return parsed
        }
        backupCorruptFile(p, 'bad-structure', 'whale-audio')
      } catch (err) {
        backupCorruptFile(p, 'bad-json', 'whale-audio')
      }
      return defaultAudioIndex()
    }
`
const MARK_READ_AUDIO = `        backupCorruptFile(p, 'bad-json', 'whale-audio')`

const ORIGINAL_READ_BUBBLE_IMG = `    function readBubbleImgIndex() {
      try {
        const parsed = JSON.parse(fs.readFileSync(path.join(pickBubbleImgDir(), BUBBLE_IMG_INDEX_NAME), 'utf8'))
        if (parsed && Array.isArray(parsed.images)) return parsed
      } catch (err) {}
      return defaultBubbleImgIndex()
    }
`
const PATCHED_READ_BUBBLE_IMG = `    function readBubbleImgIndex() {
      const p = path.join(pickBubbleImgDir(), BUBBLE_IMG_INDEX_NAME)
      let raw = null
      try {
        raw = fs.readFileSync(p, 'utf8')
      } catch (err) {
        if (err.code !== 'ENOENT') backupCorruptFile(p, (err && err.code) || 'read-error', 'whale-bubble-imgs')
        return defaultBubbleImgIndex()
      }
      try {
        const parsed = JSON.parse(raw)
        if (parsed && Array.isArray(parsed.images)) return parsed
        backupCorruptFile(p, 'bad-structure', 'whale-bubble-imgs')
      } catch (err) {
        backupCorruptFile(p, 'bad-json', 'whale-bubble-imgs')
      }
      return defaultBubbleImgIndex()
    }
`
const MARK_READ_BUBBLE_IMG = `        backupCorruptFile(p, 'bad-json', 'whale-bubble-imgs')`

const ORIGINAL_READ_BUBBLE_CFG = `    function loadBubbleConfig() {
      for (const p of BUBBLE_FILE_CANDIDATES) {
        try {
          const parsed = JSON.parse(fs.readFileSync(p, 'utf8'))
          if (parsed && parsed.v === 1) return parsed
        } catch (err) {}
      }
      return null
    }
`
const PATCHED_READ_BUBBLE_CFG = `    function loadBubbleConfig() {
      for (const p of BUBBLE_FILE_CANDIDATES) {
        let raw = null
        try {
          raw = fs.readFileSync(p, 'utf8')
        } catch (err) {
          // ENOENT = 这个候选路径没有文件，试下一个（正常情况，不备份）
          if (err.code !== 'ENOENT') backupCorruptFile(p, (err && err.code) || 'read-error', 'whale-bubble')
          continue
        }
        try {
          const parsed = JSON.parse(raw)
          if (parsed && parsed.v === 1) return parsed
          backupCorruptFile(p, 'bad-structure', 'whale-bubble')
        } catch (err) {
          backupCorruptFile(p, 'bad-json', 'whale-bubble')
        }
        // 坏文件已改名备份（数据不丢），继续看后面的候选：那里可能还有一份能用的配置
      }
      return null
    }
`
const MARK_READ_BUBBLE_CFG = `        backupCorruptFile(p, 'bad-json', 'whale-bubble')`

// —— 第九组：waitState 跨会话状态污染（v863）——
// 上游把挂起状态放在**单个全局对象**里，而 session/event 监听器覆盖所有会话（含子 agent）
// ⇒ 任何会话的 turn/start、turn/end 都会清掉另一个会话的挂起，sessionName 也被最后说话的会话覆盖。
// 修法：按会话分桶（Map）+ waitView() 选一个会话上报（有挂起的优先）。
// 四段锚点：① 状态定义 ② notePendingEvent ③ wait.json 响应体 ④ session/disposed 清理。
const ORIGINAL_WAITSTATE = `    const waitState = { pending: null, sessionName: "" }
`

const PATCHED_WAITSTATE = `    // v863（跨会话状态污染修复）：挂起状态**按会话分桶**，不再是一个全局槽位。
    // 旧实现 \`const waitState = { pending: null, sessionName: "" }\` 是单个对象，而 \`session/event\`
    // 监听器覆盖**所有会话**（含子 agent）⇒ 任何会话的 \`turn/start\` / \`turn/end\` 都会无条件清掉
    // 另一个会话的挂起，\`sessionName\` 也被最后说话的那个会话覆盖。用户可见后果：主会话正在等
    // 用户回答提问（挂件显示"等待输入"气泡），子 agent 一开跑气泡就消失、对话名变成子 agent 的，
    // 用户以为提问被取消了。
    // 现在：Map<sid, { pending, sessionName, lastTs }>；\`wait.json\` 再用 waitView() **选一个**会话上报
    // （挂件只有一个气泡，所以最终仍要选一个，见 waitView 的选法说明）。
    const waitStates = new Map() // sessionId -> { pending, sessionName, lastTs }
    const WAIT_STATE_MAX = 200 // 与 subagentSessions 同风格的防御性上限，避免长期运行无限增长
    let waitActiveSid = '' // 最近一次有事件的会话（只在"没有任何挂起"时用来取 sessionName）
    function waitBucket(sid) {
      const key = String(sid || 'default')
      const hit = waitStates.get(key)
      if (hit) return hit
      const st = { pending: null, sessionName: '', lastTs: Date.now() }
      waitStates.set(key, st)
      if (waitStates.size > WAIT_STATE_MAX) {
        // 超限时按 lastTs 淘汰最旧的一半；新条目 lastTs = now（最新），不会被自己淘汰掉
        const sorted = Array.from(waitStates.entries()).sort((a, b) => (a[1].lastTs || 0) - (b[1].lastTs || 0))
        for (const [k] of sorted.slice(0, Math.max(1, Math.floor(WAIT_STATE_MAX / 2)))) waitStates.delete(k)
      }
      return st
    }
    // 选「当前该显示哪个会话」：**有挂起的会话优先**（多个挂起取最近的一条），
    // 都没有挂起时才回落到最近有事件的会话（只为拿 sessionName）。
    // ⚠️ 为什么不能只按「最近有事件的会话」选（方案 A 的原始形态）：子 agent 一开跑就成了最近会话，
    //   主会话的提问气泡照样消失 —— 那正是本次要修的 bug。挂起优先级是修复的必要条件，不是锦上添花。
    // ⚠️ 为什么子 agent 的挂起**不**按 subagentMuteOn() 静音：那个开关管的是「子智能体**完成**时不提示」，
    //   属于"已经结束、只是告知"；而挂起是"卡住等用户动手"，静音等于让子 agent 永久挂死且用户毫无信号。
    //   另外子代理不允许提问（见上方 v761 注释），所以 question 类实际只来自主会话；能走到这里的
    //   子 agent 挂起只可能是 approval —— 那恰恰是最该让用户看见的一种。
    function waitView() {
      let best = null
      for (const st of waitStates.values()) {
        if (!st.pending) continue
        if (!best || (st.pending.ts || 0) > (best.pending.ts || 0)) best = st
      }
      if (best) return { pending: best.pending, sessionName: best.sessionName || '' }
      const act = waitActiveSid ? waitStates.get(waitActiveSid) : null
      if (act && act.sessionName) return { pending: null, sessionName: act.sessionName }
      // 活跃会话还没拿到名字：回落到最近一个有名字的会话（保持旧行为 —— 名字不会突然变空）
      let named = null
      for (const st of waitStates.values()) {
        if (!st.sessionName) continue
        if (!named || (st.lastTs || 0) > (named.lastTs || 0)) named = st
      }
      return { pending: null, sessionName: (named && named.sessionName) || '' }
    }
`

const ORIGINAL_NOTEPENDING = `function notePendingEvent(sid, event, session) {
      try {
        const type = String((event && event.type) || '')
        const data = (event && event.data) || {}
        const now = Date.now()
        // v761：**对话名**有两个来源 —— ① \`session/title\` 事件（DSH 会话标题本身就是一条日志事件：
        //   \`session.append("session/title", { title, messageSeqs, source })\`，投影键 title 由它折叠而来；
        //   本插件已监听 session/event ⇒ 直接取 event.data.title，不需要任何新服务）；
        //   ② \`session\` 对象上的 name/title 等字段（不同 DSH 版本可能有、也可能没有）。
        //   ⚠️ 必须放在 type/data 声明**之后** —— 放前面会撞 const 的暂时性死区（TDZ），
        //   抛 ReferenceError 后被外层 try/catch 静默吞掉 ⇒ 整个挂起跟踪失效（本批真踩过）。
        if (type === 'session/title') {
          const ti = String(data.title == null ? '' : data.title).trim()
          if (ti) waitState.sessionName = ti.slice(0, 120)
          return
        }
        // 三个来源，按可靠性排序：① sessionTitle 服务（可折叠日志，含启动前的标题）
        // ② session/title 事件（启动后新增/更新）③ session 对象字段（版本相关，兜底）
        const svcName = titleFromService(session)
        if (svcName) waitState.sessionName = svcName
        else {
          const name = pickSessionName(session)
          if (name) waitState.sessionName = name
        }
        if (type === 'tool/call' && String(data.name || data.toolName || '') === WAIT_QUESTION_TOOL) {
          waitState.pending = { kind: 'question', id: eventCallId(event) || ('q' + now), ts: now, session: sid }
          return
        }
        if (type === 'tool/result') {
          if (waitState.pending && waitState.pending.kind === 'question') {
            const cid = eventCallId(event)
            if (!cid || cid === waitState.pending.id) waitState.pending = null
          }
          return
        }
        if (type === 'approval/asked') {
          waitState.pending = { kind: 'approval', id: String(data.id || ('a' + now)), ts: now, session: sid }
          return
        }
        if (type.indexOf('approval/') === 0) {
          if (waitState.pending && waitState.pending.kind === 'approval') {
            const id2 = String(data.id || '')
            if (!id2 || id2 === waitState.pending.id) waitState.pending = null
          }
          return
        }
        if (type === 'turn/end' || type === 'turn/start') waitState.pending = null
      } catch (err) {}
    }
`

const PATCHED_NOTEPENDING = `function notePendingEvent(sid, event, session) {
      try {
        const type = String((event && event.type) || '')
        const data = (event && event.data) || {}
        const now = Date.now()
        // v863：所有读写都落到**本会话自己的桶**上 —— 这是修掉跨会话污染的关键。
        // 旧实现直接写全局 waitState ⇒ 子 agent 的 turn/start 会清掉主会话的挂起。
        const st = waitBucket(sid)
        st.lastTs = now
        waitActiveSid = String(sid || 'default')
        // v761：**对话名**有两个来源 —— ① \`session/title\` 事件（DSH 会话标题本身就是一条日志事件：
        //   \`session.append("session/title", { title, messageSeqs, source })\`，投影键 title 由它折叠而来；
        //   本插件已监听 session/event ⇒ 直接取 event.data.title，不需要任何新服务）；
        //   ② \`session\` 对象上的 name/title 等字段（不同 DSH 版本可能有、也可能没有）。
        //   ⚠️ 必须放在 type/data 声明**之后** —— 放前面会撞 const 的暂时性死区（TDZ），
        //   抛 ReferenceError 后被外层 try/catch 静默吞掉 ⇒ 整个挂起跟踪失效（本批真踩过）。
        if (type === 'session/title') {
          const ti = String(data.title == null ? '' : data.title).trim()
          if (ti) st.sessionName = ti.slice(0, 120)
          return
        }
        // 三个来源，按可靠性排序：① sessionTitle 服务（可折叠日志，含启动前的标题）
        // ② session/title 事件（启动后新增/更新）③ session 对象字段（版本相关，兜底）
        const svcName = titleFromService(session)
        if (svcName) st.sessionName = svcName
        else {
          const name = pickSessionName(session)
          if (name) st.sessionName = name
        }
        if (type === 'tool/call' && String(data.name || data.toolName || '') === WAIT_QUESTION_TOOL) {
          st.pending = { kind: 'question', id: eventCallId(event) || ('q' + now), ts: now, session: sid }
          return
        }
        if (type === 'tool/result') {
          if (st.pending && st.pending.kind === 'question') {
            const cid = eventCallId(event)
            if (!cid || cid === st.pending.id) st.pending = null
          }
          return
        }
        if (type === 'approval/asked') {
          st.pending = { kind: 'approval', id: String(data.id || ('a' + now)), ts: now, session: sid }
          return
        }
        if (type.indexOf('approval/') === 0) {
          if (st.pending && st.pending.kind === 'approval') {
            const id2 = String(data.id || '')
            if (!id2 || id2 === st.pending.id) st.pending = null
          }
          return
        }
        // v863：只清**本会话**的挂起（旧实现无条件清全局槽位）
        if (type === 'turn/end' || type === 'turn/start') st.pending = null
      } catch (err) {}
    }
`

const ORIGINAL_WAITROUTE = `        res.writeHead(200, JSON_HEADERS)
        res.end(JSON.stringify({
          ok: true,
          pending: waitState.pending,
          sessionName: waitState.sessionName || '',
        }))
`

const PATCHED_WAITROUTE = `        // v863：状态已按会话分桶，这里用 waitView() **选一个**会话上报（挂件只有一个气泡）。
        //   返回结构保持 { ok, pending, sessionName } 不变 —— 前端 assets/whale-widget.js 只读
        //   这两个字段（pollWaitState），不认 session 字段，所以不需要改前端。
        const view = waitView()
        res.writeHead(200, JSON_HEADERS)
        res.end(JSON.stringify({
          ok: true,
          pending: view.pending,
          sessionName: view.sessionName || '',
        }))
`

const ORIGINAL_DISPOSED = `    disposers.push(ctx.on('session/disposed', (session) => {
      if (session && session.id) turnAggs.delete(session.id)
    }))
`

// 注意：`from` 不含上面那行注释（它在原文里已存在），所以 `to` 也不能重复它
const PATCHED_DISPOSED = `    disposers.push(ctx.on('session/disposed', (session) => {
      if (session && session.id) {
        turnAggs.delete(session.id)
        // v863：挂起状态也按会话分桶了 ⇒ 同样要清，否则长期运行会攒下已销毁会话的条目
        const gone = String(session.id)
        waitStates.delete(gone)
        if (waitActiveSid === gone) waitActiveSid = ''
      }
    }))
`


// —— 新增锚点表 ——
// 每一项：{ name, from, to, mark, hints }
//   from  上游原版里必须恰好出现 1 次的代码块
//   to    补丁后的代码块（revert 时反向替换，也必须恰好出现 1 次）
//   mark  打过补丁才有的标记，用于幂等判定与半打补丁检测
//   hints 漂移时用来打印"实际找到的片段"的搜索串
// ⑩ 账本 IO 退避 + update-check in-flight 去重
const ORIGINAL_LEDGER_IO = `    // Windows indexers can briefly hold a just-written file. Retry sharing
    // conflicts; never treat an unreadable existing ledger as an empty ledger.
    function ledgerIo(operation) {
      for (let attempt = 0; ; attempt++) {
        try { return operation() } catch (err) {
          if (attempt >= 5 || !['EBUSY', 'EPERM', 'EACCES'].includes(err.code)) throw err
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20 * (attempt + 1))
        }
      }
    }`

const PATCHED_LEDGER_IO = `    // Windows indexers can briefly hold a just-written file. Retry sharing
    // conflicts; never treat an unreadable existing ledger as an empty ledger.
    //
    // ⚠️ 退避**必须短**：本函数是同步的，\`Atomics.wait\` 在 Node 主线程上是真阻塞，
    //   而插件跑在 DSH 宿主进程里 —— 阻塞多久，模型流式输出就卡多久（同文件 4001 行
    //   \`npmCliVersion\` 的注释讲的是同一个坑）。旧值 \`20 * (attempt + 1)\` 单次操作最坏
    //   20+40+60+80+100 = 305ms，而 \`writeUsageLedger\` 一次写盘要过 4 个 ledgerIo
    //   （读旧账本 / 备份 / 写临时文件 / rename），最坏累计 1220ms。
    //   现在改成固定 5ms × 5 次 = 单次操作最坏 25ms，一次写盘最坏 100ms。
    //   取舍：重试耐心从 305ms 降到 25ms，Windows 索引器占用超过 25ms 时写盘会失败
    //   （\`writeUsageLedger\` 返回 false，调用方按既有逻辑报错/下次再写），
    //   换来的是宿主事件循环不会被账本 IO 拖住。彻底解法是把整条账本链 async 化，
    //   但 \`readUsageLedger\` 被 \`publicBalance\` / \`recordLedgerUsage\` / \`aboutPayload\` /
    //   \`readUsageSettings\` 等 12 处同步函数调用，改动面远大于本 bug 的收益。
    const LEDGER_RETRY_WAIT_MS = 5
    const LEDGER_RETRY_LIMIT = 5
    function ledgerIo(operation) {
      for (let attempt = 0; ; attempt++) {
        try { return operation() } catch (err) {
          if (attempt >= LEDGER_RETRY_LIMIT || !['EBUSY', 'EPERM', 'EACCES'].includes(err.code)) throw err
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, LEDGER_RETRY_WAIT_MS)
        }
      }
    }`

const ORIGINAL_UPDATE_CHECK = `    let updateCheckCache = null
    disposers.push(registerRoute({
      kind: 'exact',
      path: '/dsh-whale/update-check.json',
      handler: async (req, res) => {
        const now = Date.now()
        try {
          if (updateCheckCache && now - updateCheckCache.at < 10 * 60 * 1000) {
            res.writeHead(200, JSON_HEADERS)
            res.end(JSON.stringify(updateCheckCache.payload))
            return
          }
        } catch (err) {}
        let payload = null
        // v802：四个源**并行**试（单个源实测很不稳：npmmirror/jsdelivr 会超时、unpkg 会 302），
        //   并行后最坏也就 5 秒（串行会是 20 秒），谁先成功用谁，全失败就把每个源的原因都列出来。
        const results = await Promise.all(UPDATE_SOURCES.map(async (src) => {
          // v803：失败得**很快**（<1.5s，多为 DNS/连接抖动）就再试一次；超时那种就不重试了（不然最坏翻倍）
          const attempt = async () => {
            const t0 = Date.now()
            if (src.cli) return { v: await npmCliVersion(8000), ms: Date.now() - t0 }
            const j = await httpsGetJson(src.url, 5000, 0)
            const latest = String((j && j.version) || '')
            if (!latest) throw new Error('返回里没有 version')
            return { v: latest, ms: Date.now() - t0 }
          }
          try {
            const a = await attempt()
            return { ok: true, name: src.name, latest: a.v }
          } catch (err1) {
            // 只在"失败得很快"（<1.5s，多为连接抖动）时重试一次；超时那种不重试，避免最坏耗时翻倍
            const fast = !(err1 && /超时/.test(String(err1.message || '')))
            if (!fast) return { ok: false, name: src.name, why: String((err1 && err1.message) || err1).slice(0, 40) }
            try {
              const a2 = await attempt()
              return { ok: true, name: src.name, latest: a2.v }
            } catch (err2) {
              return { ok: false, name: src.name, why: String((err2 && err2.message) || err2).slice(0, 40) }
            }
          }
        }))
        const hit = results.filter((r) => r.ok)[0]
        if (hit) {
          payload = {
            ok: true,
            current: BUILD_VERSION,
            channel: BUILD_CHANNEL,
            latest: hit.latest,
            hasUpdate: hit.latest !== BUILD_VERSION,
            source: hit.name,
          }
        } else {
          // 全失败 ⇒ 把**每一个源**的原因都列出来（只报最后一个会让人以为只有 npmjs 挂了）
          payload = {
            ok: false,
            current: BUILD_VERSION,
            error: results.map((r) => r.name + '：' + r.why).join('；'),
            tried: UPDATE_SOURCES.map((s) => s.name),
          }
        }
        try { updateCheckCache = { at: now, payload: payload } } catch (err) {}
        res.writeHead(200, JSON_HEADERS)
        res.end(JSON.stringify(payload))
      },
    }))`

const PATCHED_UPDATE_CHECK = `    let updateCheckCache = null
    // v862：in-flight 去重。缓存只在**完成后**才写，所以 N 个并发请求同时 miss 时，
    //   旧代码会各自发起 5 个上游（4 个 https + 1 个 \`npm view\` 子进程）—— 8 并发就是
    //   40 个外部请求 + 8 个 npm 子进程，等于自己打自己。\`balance.json\` 早有
    //   \`balanceInFlight\`（3195 行附近）做同一件事，这里补齐。
    //   ⚠️ 清空**由 promise 自己负责**（IIFE 的 finally 里），不能放在 handler 的
    //   finally 里：handler 的 finally 由"第一个等到结果的请求"执行，它清空后，
    //   仍在 await 同一 promise 的请求不受影响，但**新到达**的请求会重新发起一轮。
    //   放在 IIFE 里则是在 promise settle 之前清空，此时 \`updateCheckCache\` 已经写好，
    //   新到达的请求直接命中缓存，不会重复打上游。
    let updateCheckInFlight = null
    disposers.push(registerRoute({
      kind: 'exact',
      path: '/dsh-whale/update-check.json',
      handler: async (req, res) => {
        const now = Date.now()
        try {
          if (updateCheckCache && now - updateCheckCache.at < 10 * 60 * 1000) {
            res.writeHead(200, JSON_HEADERS)
            res.end(JSON.stringify(updateCheckCache.payload))
            return
          }
        } catch (err) {}
        if (!updateCheckInFlight) updateCheckInFlight = runUpdateCheck(now)
        let payload = null
        try {
          payload = await updateCheckInFlight
        } catch (err) {
          // runUpdateCheck 内部已兜底，这里只防御"连兜底都抛"的极端情况
          payload = { ok: false, current: BUILD_VERSION, error: String((err && err.message) || err).slice(0, 160) }
        }
        res.writeHead(200, JSON_HEADERS)
        res.end(JSON.stringify(payload))
      },
    }))
    // 真正打上游的那一轮。**同一时刻只允许一个**（由 updateCheckInFlight 保证）。
    async function runUpdateCheck(now) {
      try {
        let payload = null
        // v802：四个源**并行**试（单个源实测很不稳：npmmirror/jsdelivr 会超时、unpkg 会 302），
        //   并行后最坏也就 5 秒（串行会是 20 秒），谁先成功用谁，全失败就把每个源的原因都列出来。
        const results = await Promise.all(UPDATE_SOURCES.map(async (src) => {
          // v803：失败得**很快**（<1.5s，多为 DNS/连接抖动）就再试一次；超时那种就不重试了（不然最坏翻倍）
          const attempt = async () => {
            const t0 = Date.now()
            if (src.cli) return { v: await npmCliVersion(8000), ms: Date.now() - t0 }
            const j = await httpsGetJson(src.url, 5000, 0)
            const latest = String((j && j.version) || '')
            if (!latest) throw new Error('返回里没有 version')
            return { v: latest, ms: Date.now() - t0 }
          }
          try {
            const a = await attempt()
            return { ok: true, name: src.name, latest: a.v }
          } catch (err1) {
            // 只在"失败得很快"（<1.5s，多为连接抖动）时重试一次；超时那种不重试，避免最坏耗时翻倍
            const fast = !(err1 && /超时/.test(String(err1.message || '')))
            if (!fast) return { ok: false, name: src.name, why: String((err1 && err1.message) || err1).slice(0, 40) }
            try {
              const a2 = await attempt()
              return { ok: true, name: src.name, latest: a2.v }
            } catch (err2) {
              return { ok: false, name: src.name, why: String((err2 && err2.message) || err2).slice(0, 40) }
            }
          }
        }))
        const hit = results.filter((r) => r.ok)[0]
        if (hit) {
          payload = {
            ok: true,
            current: BUILD_VERSION,
            channel: BUILD_CHANNEL,
            latest: hit.latest,
            hasUpdate: hit.latest !== BUILD_VERSION,
            source: hit.name,
          }
        } else {
          // 全失败 ⇒ 把**每一个源**的原因都列出来（只报最后一个会让人以为只有 npmjs 挂了）
          payload = {
            ok: false,
            current: BUILD_VERSION,
            error: results.map((r) => r.name + '：' + r.why).join('；'),
            tried: UPDATE_SOURCES.map((s) => s.name),
          }
        }
        try { updateCheckCache = { at: now, payload: payload } } catch (err) {}
        return payload
      } finally {
        // 在 promise settle **之前**清空：此刻 updateCheckCache 已写好，
        // 新到达的请求会命中缓存而不是再打一轮上游。
        updateCheckInFlight = null
      }
    }`

const NEW_ANCHORS = [
  {
    name: 'body 超限 413（readBodyLimited）',
    from: ORIGINAL_BODY, to: PATCHED_BODY, mark: MARK_BODY,
    hints: ['function readBodyMax(req, maxBytes)', 'readBodyMax(', 'req.destroy()'],
  },
  {
    name: 'catch 400→413：codex 设置',
    from: CATCH_400_FIXES[0][0], to: CATCH_400_FIXES[0][1], mark: CATCH_400_FIXES[0][1],
    hints: ['codexInvalidate()', 'res.writeHead(result.ok ? 200 : 500, JSON_HEADERS)'],
  },
  {
    name: 'catch 400→413：用量设置',
    from: CATCH_400_FIXES[1][0], to: CATCH_400_FIXES[1][1], mark: CATCH_400_FIXES[1][1],
    hints: ['readUsageSettings()', 'writeUsageSettings(parsed)'],
  },
  {
    name: 'catch 400→413：模型列表',
    from: CATCH_400_FIXES[2][0], to: CATCH_400_FIXES[2][1], mark: CATCH_400_FIXES[2][1],
    hints: ['apiModelsPayload()', 'apiSaveModel('],
  },
  {
    name: 'catch 400→413：角色上传',
    from: CATCH_400_FIXES[3][0], to: CATCH_400_FIXES[3][1], mark: CATCH_400_FIXES[3][1],
    hints: ['rolesPayload()', 'writeRolesIndex(index)'],
  },
  {
    name: 'catch 400→413：role-pin',
    from: CATCH_400_FIXES[4][0], to: CATCH_400_FIXES[4][1], mark: CATCH_400_FIXES[4][1],
    hints: ['roleIndexFind(id)', 'role.pinnedAt = parsed.pinned'],
  },
  {
    name: 'catch 400→413：role-delete',
    from: CATCH_400_FIXES[5][0], to: CATCH_400_FIXES[5][1], mark: CATCH_400_FIXES[5][1],
    hints: ['cannot delete default role', 'index.roles = index.roles.filter'],
  },
  {
    name: 'catch 400→413：音效',
    from: CATCH_400_FIXES[6][0], to: CATCH_400_FIXES[6][1], mark: CATCH_400_FIXES[6][1],
    hints: ['audioGroupsPayload()', 'unknown action'],
  },
  {
    name: 'catch 400→413：泡泡配置',
    from: CATCH_400_FIXES[7][0], to: CATCH_400_FIXES[7][1], mark: CATCH_400_FIXES[7][1],
    hints: ['loadBubbleConfig()', 'writeBubbleConfig(cfg)'],
  },
  {
    name: 'catch 400→413：泡泡图库',
    from: CATCH_400_FIXES[8][0], to: CATCH_400_FIXES[8][1], mark: CATCH_400_FIXES[8][1],
    hints: ['bubbleImgPayload()', 'writeBubbleImgIndex(index)'],
  },
  {
    name: '方法守卫：role-pin.json',
    from: ORIGINAL_GUARD_PIN, to: PATCHED_GUARD_PIN, mark: MARK_GUARD_PIN,
    hints: ["path: '/dsh-whale/role-pin.json'", 'role-pin.json'],
  },
  {
    name: '方法守卫：role-delete.json',
    from: ORIGINAL_GUARD_DELETE, to: PATCHED_GUARD_DELETE, mark: MARK_GUARD_DELETE,
    hints: ["path: '/dsh-whale/role-delete.json'", 'role-delete.json'],
  },
  {
    name: '方法守卫：bubble-img-upload.json',
    from: ORIGINAL_GUARD_UPLOAD, to: PATCHED_GUARD_UPLOAD, mark: MARK_GUARD_UPLOAD,
    hints: ["path: '/dsh-whale/bubble-img-upload.json'", 'bubble-img-upload.json'],
  },
  {
    name: '2027 节假日表',
    from: ORIGINAL_HOLIDAY, to: PATCHED_HOLIDAY, mark: MARK_HOLIDAY,
    hints: ['const HOLIDAY_VALLEY = {', "'2026-10-07': 1,", 'HOLIDAY_VALLEY'],
  },
  {
    name: 'peakHolidaysCoveredThrough 下发',
    from: ORIGINAL_HOLIDAY_FIELD, to: PATCHED_HOLIDAY_FIELD, mark: MARK_HOLIDAY_FIELD,
    hints: ['peakHolidays: HOLIDAY_VALLEY_LIST,', 'peakHolidays'],
  },
  {
    name: 'backupCorruptFile helper',
    from: ORIGINAL_BACKUP_HELPER, to: PATCHED_BACKUP_HELPER, mark: MARK_BACKUP_HELPER,
    hints: ['function ledgerBackupCorrupt(p, why)', 'function readUsageLedger()'],
  },
  {
    name: '配置损坏备份：readRolesIndex',
    from: ORIGINAL_READ_ROLES, to: PATCHED_READ_ROLES, mark: MARK_READ_ROLES,
    hints: ['function readRolesIndex()', 'ROLE_INDEX_NAME'],
  },
  {
    name: '配置损坏备份：readAudioIndex',
    from: ORIGINAL_READ_AUDIO, to: PATCHED_READ_AUDIO, mark: MARK_READ_AUDIO,
    hints: ['function readAudioIndex()', 'AUDIO_INDEX_NAME'],
  },
  {
    name: '配置损坏备份：readBubbleImgIndex',
    from: ORIGINAL_READ_BUBBLE_IMG, to: PATCHED_READ_BUBBLE_IMG, mark: MARK_READ_BUBBLE_IMG,
    hints: ['function readBubbleImgIndex()', 'BUBBLE_IMG_INDEX_NAME'],
  },
  {
    name: '配置损坏备份：loadBubbleConfig',
    from: ORIGINAL_READ_BUBBLE_CFG, to: PATCHED_READ_BUBBLE_CFG, mark: MARK_READ_BUBBLE_CFG,
    hints: ['function loadBubbleConfig()', 'BUBBLE_FILE_CANDIDATES'],
  },  {
    name: 'waitState 按会话分桶（定义）',
    from: ORIGINAL_WAITSTATE, to: PATCHED_WAITSTATE, mark: 'const waitStates = new Map()',
    hints: ['const waitState = { pending: null, sessionName: "" }', 'waitState', 'notePendingEvent'],
  },
  {
    name: 'waitState 按会话分桶（notePendingEvent）',
    from: ORIGINAL_NOTEPENDING, to: PATCHED_NOTEPENDING, mark: 'const st = waitBucket(sid)',
    hints: ['function notePendingEvent(sid, event, session)', 'waitState.pending = null', 'waitState.sessionName'],
  },
  {
    name: 'wait.json 返回当前活跃会话',
    from: ORIGINAL_WAITROUTE, to: PATCHED_WAITROUTE, mark: 'const view = waitView()',
    hints: ["path: '/dsh-whale/wait.json'", 'pending: waitState.pending', 'sessionName: waitState.sessionName'],
  },
  {
    name: 'session/disposed 清理挂起桶',
    from: ORIGINAL_DISPOSED, to: PATCHED_DISPOSED, mark: 'waitStates.delete(gone)',
    hints: ["ctx.on('session/disposed'", 'turnAggs.delete(session.id)', 'session/disposed'],
  },
  {
    name: '账本 IO 退避不再长阻塞事件循环',
    from: ORIGINAL_LEDGER_IO, to: PATCHED_LEDGER_IO, mark: 'const LEDGER_RETRY_WAIT_MS = 5',
    hints: ['function ledgerIo(operation)', 'Atomics.wait', 'EBUSY'],
  },
  {
    name: 'update-check 并发 in-flight 去重',
    from: ORIGINAL_UPDATE_CHECK, to: PATCHED_UPDATE_CHECK, mark: 'let updateCheckInFlight = null',
    hints: ['let updateCheckCache = null', 'Promise.all(UPDATE_SOURCES', 'update-check.json'],
  },

]

// ============================================================================
// 前端侧（assets/whale-widget.js）的两组修复
//
// ⑪ issue #339：onDocPointerMoveCursor 每次 pointermove 都强制同步布局
//    旧实现挂在 document 上、capture 阶段、无条件注册，每次移动做三件昂贵的事：
//      · document.elementFromPoint(x, y)          —— 强制同步布局
//      · isWhaleHit() 里 img.getBoundingClientRect() —— 又一次强制布局
//      · isWhaleHit() 里 getImageData(1,1)         —— canvas 回读，GPU→CPU 同步
//    修法三层：rAF 节流（一帧最多判定一次）+ 用事件自带的 e.target 代替 elementFromPoint
//    + 矩形与命中图 alpha 表都缓存。缓存**只用于光标路径**，点击/拖动仍现取现算。
//
// ⑫ issue #342：每秒轮询无 in-flight 守卫、页面隐藏时不暂停
//    pollWaitState / pollLastTurn 直接 fetch，响应慢于 1 秒时请求堆叠；后台仍每秒 2 个请求。
//    修法：各自一个 busy 布尔 + document.hidden 跳过 + visibilitychange 回前台立刻补一次。
// ============================================================================

// ⑪-1 express() 尾部：几何变了 ⇒ 光标路径的矩形缓存作废
const ORIGINAL_EXPRESS_TAIL = `  root.classList.toggle('dshwv-left', !!state.flip)
}
function settle() {`

const PATCHED_EXPRESS_TAIL = `  root.classList.toggle('dshwv-left', !!state.flip)
  // issue #339：几何变了 ⇒ 光标路径的矩形缓存作废（过渡期间还会再失效一次）
  try { invalidateCursorRectSoon() } catch (err) {}
}
function settle() {`

const MARK_EXPRESS_TAIL = `  try { invalidateCursorRectSoon() } catch (err) {}`

// ⑪-2 命中图 alpha 表：声明 + setupHitTest 开头清空
const ORIGINAL_HIT_DECL = `var hitFailed = false // 命中图加载失败（如图片 404/资源缺失）：退回矩形区域判定，绝不吞掉整页事件
function setupHitTest(url) {
  try {
    hitCanvas = document.createElement('canvas')
    hitCanvas.width = 610
    hitCanvas.height = 610
    hitReady = false
    hitFailed = false
    var probe = new Image()`

const PATCHED_HIT_DECL = `var hitFailed = false // 命中图加载失败（如图片 404/资源缺失）：退回矩形区域判定，绝不吞掉整页事件
// issue #339：命中图的 alpha 通道整张缓存（610×610 = 372KB）。
// 旧实现每次 isWhaleHit 都 getImageData(1,1) —— canvas 回读是 GPU→CPU 同步，
// 而 isWhaleHit 在每次 pointermove 上都会被调用。现在只在命中图建好时读一次整张，
// 之后查表（hitAlpha[y * 610 + x] > 10），语义与逐点读完全一致。
var hitAlpha = null
function setupHitTest(url) {
  try {
    hitCanvas = document.createElement('canvas')
    hitCanvas.width = 610
    hitCanvas.height = 610
    hitReady = false
    hitFailed = false
    hitAlpha = null
    var probe = new Image()`

const MARK_HIT_DECL = `var hitAlpha = null
function setupHitTest(url) {`

// ⑪-3 setupHitTest：整张读一次，只留 alpha
const ORIGINAL_HIT_READ = `        ctx.drawImage(probe, dx, dy, dw, dh)
        // v756（issue #144）：画布读回可能被浏览器**抹白** —— Firefox 开启「隐私保护 / resistFingerprinting」`

const PATCHED_HIT_READ = `        ctx.drawImage(probe, dx, dy, dw, dh)
        // issue #339：整张读一次（1.5MB 的 ImageData 只活在这一帧），只留 alpha（372KB）。
        // 读不出来（隐私保护/跨域污染）会抛错 → 落到下面的 catch，与旧行为一致。
        var full = ctx.getImageData(0, 0, 610, 610).data
        var alpha = new Uint8Array(610 * 610)
        for (var ai = 0, aj = 3; ai < alpha.length; ai++, aj += 4) alpha[ai] = full[aj]
        hitAlpha = alpha
        // v756（issue #144）：画布读回可能被浏览器**抹白** —— Firefox 开启「隐私保护 / resistFingerprinting」`

const MARK_HIT_READ = `        var full = ctx.getImageData(0, 0, 610, 610).data`

// ⑪-4 setupHitTest：不透明采样改查 alpha 表
const ORIGINAL_HIT_SAMPLE = `            if (ctx.getImageData(px, py, 1, 1).data[3] > 10) opaque++
          }
        }
        if (!opaque) { hitReady = false; hitFailed = true; applyHitClip(''); return }`

const PATCHED_HIT_SAMPLE = `            if (alpha[py * 610 + px] > 10) opaque++
          }
        }
        if (!opaque) { hitReady = false; hitFailed = true; hitAlpha = null; applyHitClip(''); return }`

const MARK_HIT_SAMPLE = `            if (alpha[py * 610 + px] > 10) opaque++`

// ⑪-5 whaleRectHit → whaleRectHitAt（可注入缓存矩形）
const ORIGINAL_RECT_HIT = `function whaleRectHit(e) {
  try {
    var fr = img.getBoundingClientRect()
    if (!fr || fr.width <= 0 || fr.height <= 0) return false
    return e.clientX >= fr.left && e.clientX <= fr.right && e.clientY >= fr.top && e.clientY <= fr.bottom
  } catch (err) { return false }
}`

const PATCHED_RECT_HIT = `function whaleRectHit(e) {
  return whaleRectHitAt(e.clientX, e.clientY)
}
function whaleRectHitAt(x, y, cachedRect) {
  try {
    var fr = cachedRect || img.getBoundingClientRect()
    if (!fr || fr.width <= 0 || fr.height <= 0) return false
    return x >= fr.left && x <= fr.right && y >= fr.top && y <= fr.bottom
  } catch (err) { return false }
}`

const MARK_RECT_HIT = `function whaleRectHitAt(x, y, cachedRect) {`

// ⑪-6 buildHitClipPath：改读 alpha 表，不再自己回读画布
const ORIGINAL_CLIP_PATH = `    var c = hitCanvas && hitCanvas.getContext ? hitCanvas.getContext('2d') : null
    if (!c) return ''
    var data = c.getImageData(0, 0, 610, 610).data // 只读一次（1.5MB），别逐行读
    var pts = []
    for (var y = 0; y < 610; y++) {
      var l = -1, r = -1
      var base = y * 610 * 4
      for (var x = 0; x < 610; x++) {
        if (data[base + x * 4 + 3] > 10) { if (l < 0) l = x; r = x }
      }`

const PATCHED_CLIP_PATH = `    if (!hitAlpha) return ''
    var data = hitAlpha // 整张 alpha 表（见 setupHitTest），不再逐点回读画布
    var pts = []
    for (var y = 0; y < 610; y++) {
      var l = -1, r = -1
      var base = y * 610
      for (var x = 0; x < 610; x++) {
        if (data[base + x] > 10) { if (l < 0) l = x; r = x }
      }`

const MARK_CLIP_PATH = `    var data = hitAlpha // 整张 alpha 表（见 setupHitTest），不再逐点回读画布`

// ⑪-7 isWhaleHit → isWhaleHitAt（可注入缓存矩形 + 查 alpha 表）
const ORIGINAL_IS_HIT = `function isWhaleHit(e) {
  // 命中图未就绪/失败时：绝不默认“全屏都是鲸鱼”。
  // 加载中 → 返回 false（不拦截页面）；加载失败 → 退回图像矩形区域，仅挂件区域可拖。
  if (!hitCanvas || !hitReady) {
    if (!hitFailed) return false
    return whaleRectHit(e)
  }
  try {
    var r = img.getBoundingClientRect()
    if (!r || r.width <= 0 || r.height <= 0) return false
    var lx = (e.clientX - r.left) / r.width * 610
    var ly = (e.clientY - r.top) / r.height * 610
    if (lx < 0 || ly < 0 || lx >= 610 || ly >= 610) return false
    if (state.flip) lx = 610 - lx
    var data
    try {
      data = hitCanvas.getContext('2d').getImageData(Math.floor(lx), Math.floor(ly), 1, 1).data
    } catch (err) {
      // v756（issue #144）：画布读不出来（隐私保护/跨域污染）→ 立刻降级为矩形判定，
      // 并且**记住**这个状态，后续调用直接走矩形，不再每次抛错。
      hitReady = false
      hitFailed = true
      return whaleRectHit(e)
    }
    return data[3] > 10
  } catch (err) {
    return false
  }
}`

const PATCHED_IS_HIT = `function isWhaleHit(e) {
  return isWhaleHitAt(e.clientX, e.clientY)
}
// issue #339：把「按坐标判定」抽出来，让高频的 pointermove 光标路径可以传入**缓存的矩形**
// （见 cursorImgRect），避免每次移动都 img.getBoundingClientRect() 强制同步布局。
// 点击/拖动/click 拦截这些低频且必须精确的路径仍然传 undefined ⇒ 现取现算，行为与旧版一致。
function isWhaleHitAt(x, y, cachedRect) {
  // 命中图未就绪/失败时：绝不默认“全屏都是鲸鱼”。
  // 加载中 → 返回 false（不拦截页面）；加载失败 → 退回图像矩形区域，仅挂件区域可拖。
  if (!hitCanvas || !hitReady) {
    if (!hitFailed) return false
    return whaleRectHitAt(x, y, cachedRect)
  }
  try {
    var r = cachedRect || img.getBoundingClientRect()
    if (!r || r.width <= 0 || r.height <= 0) return false
    var lx = (x - r.left) / r.width * 610
    var ly = (y - r.top) / r.height * 610
    if (lx < 0 || ly < 0 || lx >= 610 || ly >= 610) return false
    if (state.flip) lx = 610 - lx
    var ix = Math.floor(lx)
    var iy = Math.floor(ly)
    if (ix < 0) ix = 0
    if (ix > 609) ix = 609
    if (iy < 0) iy = 0
    if (iy > 609) iy = 609
    if (hitAlpha) return hitAlpha[iy * 610 + ix] > 10
    // 兜底：alpha 表没建起来（理论上不会发生）→ 退回逐点回读
    try {
      var data = hitCanvas.getContext('2d').getImageData(ix, iy, 1, 1).data
      return data[3] > 10
    } catch (err) {
      // v756（issue #144）：画布读不出来（隐私保护/跨域污染）→ 立刻降级为矩形判定，
      // 并且**记住**这个状态，后续调用直接走矩形，不再每次抛错。
      hitReady = false
      hitFailed = true
      return whaleRectHitAt(x, y, cachedRect)
    }
  } catch (err) {
    return false
  }
}`

const MARK_IS_HIT = `function isWhaleHitAt(x, y, cachedRect) {`

// ⑪-8 光标路径的矩形缓存 + onDocPointerMoveCursor 改成 rAF 节流
const ORIGINAL_CURSOR_HEAD = `function onDocPointerMoveCursor(e) {
  if (drag && drag.active) {`

const PATCHED_CURSOR_HEAD = `// —— issue #339：pointermove 光标判定的三层降本 ——
//   ① rAF 节流：pointermove 只记坐标，一帧最多判定一次（1000Hz 回报率鼠标 → 60Hz）；
//   ② 不再 document.elementFromPoint：事件自带的 e.target 就是同一次命中测试的结果，
//      拿它做 closest() 判断零成本（elementFromPoint 会强制同步布局）；
//   ③ 矩形与命中图都缓存：img.getBoundingClientRect() 只在失效后重算，命中图查 alpha 表。
// 缓存**只用于光标路径**；点击/拖动/click 拦截仍现取现算，避免缓存过期导致"点不动"。
var cursorRectCache = null
var cursorRectTimer = 0
function invalidateCursorRect() { cursorRectCache = null }
// express() 之后 left/top 有 .16s 过渡，过渡期间矩形在动：立刻失效一次，
// 再在过渡结束后（transitionend 或 260ms 兜底）失效一次，避免缓存停在过渡起点。
function invalidateCursorRectSoon() {
  invalidateCursorRect()
  if (cursorRectTimer) return
  cursorRectTimer = setTimeout(function () {
    cursorRectTimer = 0
    invalidateCursorRect()
  }, 260)
}
function cursorImgRect() {
  if (cursorRectCache) return cursorRectCache
  try { cursorRectCache = img.getBoundingClientRect() } catch (err) { cursorRectCache = null }
  return cursorRectCache
}
var cursorRafId = 0
var cursorPending = null
function onDocPointerMoveCursor(e) {
  if (drag && drag.active) {`

const MARK_CURSOR_HEAD = `var cursorRectCache = null`

// ⑪-9 主体：elementFromPoint → 记录坐标 + rAF
const ORIGINAL_CURSOR_BODY = `  var el = null
  try { el = document.elementFromPoint(e.clientX, e.clientY) } catch (err) {}`

const PATCHED_CURSOR_BODY = `  // ① 只记录，判定推迟到下一帧（同一帧内多次移动只算一次）
  cursorPending = { x: e.clientX, y: e.clientY, target: e.target || null }
  if (cursorRafId) return
  try {
    cursorRafId = requestAnimationFrame(flushCursorMove)
  } catch (err) {
    cursorRafId = 0
    flushCursorMove()
  }
}
function flushCursorMove() {
  cursorRafId = 0
  var p = cursorPending
  cursorPending = null
  if (!p) return
  applyCursorMove(p)
}
function applyCursorMove(p) {
  if (drag && drag.active) return
  // ② 事件自带的 target 就是 elementFromPoint 的答案，且不触发布局。
  //    只有拿不到 target 的极端情况才退回 elementFromPoint。
  var el = p.target
  if (!el) {
    try { el = document.elementFromPoint(p.x, p.y) } catch (err) { el = null }
  }`

const MARK_CURSOR_BODY = `function applyCursorMove(p) {`

// ⑪-10 主体：命中判定改走矩形粗判 + 缓存矩形
const ORIGINAL_CURSOR_OVER = `  var over = isWhaleHit(e)`

const PATCHED_CURSOR_OVER = `  // ③ 矩形粗判：指针在挂件矩形之外时连命中图都不查（也不碰任何 DOM 几何）
  var r = cursorImgRect()
  var over = false
  if (r && r.width > 0 && r.height > 0 &&
      p.x >= r.left && p.x <= r.right && p.y >= r.top && p.y <= r.bottom) {
    over = isWhaleHitAt(p.x, p.y, r)
  }`

const MARK_CURSOR_OVER = `    over = isWhaleHitAt(p.x, p.y, r)`

// ⑪-11 矩形缓存的失效点
const ORIGINAL_CURSOR_LISTEN = `document.addEventListener('pointermove', onDocPointerMoveCursor, true)
// 启动即应用一次菜单按钮可见性`

const PATCHED_CURSOR_LISTEN = `document.addEventListener('pointermove', onDocPointerMoveCursor, true)
// 矩形缓存的失效点：窗口尺寸/滚动、图片加载完成、过渡结束（left/top 有 .16s 过渡）。
try { window.addEventListener('resize', invalidateCursorRect, { passive: true }) } catch (err) {}
try { window.addEventListener('scroll', invalidateCursorRect, { capture: true, passive: true }) } catch (err) {}
try { img.addEventListener('load', invalidateCursorRect) } catch (err) {}
try { root.addEventListener('transitionend', invalidateCursorRect) } catch (err) {}
// 启动即应用一次菜单按钮可见性`

const MARK_CURSOR_LISTEN = `try { window.addEventListener('scroll', invalidateCursorRect, { capture: true, passive: true }) } catch (err) {}`

// ⑪-12 endDrag：拖动结束作废矩形缓存
const ORIGINAL_ENDDRAG = `  pressUp()
  root.classList.remove('dshwv-dragging')
  // issue #79 缺陷2`

const PATCHED_ENDDRAG = `  pressUp()
  root.classList.remove('dshwv-dragging')
  // issue #339：拖动期间挂件一直在动，光标路径的矩形缓存必须作废
  try { invalidateCursorRect() } catch (err) {}
  // issue #79 缺陷2`

const MARK_ENDDRAG = `  // issue #339：拖动期间挂件一直在动，光标路径的矩形缓存必须作废`

// ⑫-1 pollWaitState：in-flight 守卫 + 后台跳过
const ORIGINAL_POLL_WAIT_HEAD = `function pollWaitState() {
  try {
    fetch(WAIT_URL, { cache: 'no-store' })`

const PATCHED_POLL_WAIT_HEAD = `// issue #342：in-flight 守卫。宿主响应慢于 1 秒时，旧实现每秒再发一个 —— 请求会堆叠，
// 而且每个响应回来都要跑一遍渲染/去重逻辑。同一时刻只允许一个在飞。
var pollWaitBusy = false
function pollWaitState() {
  if (pollWaitBusy) return
  // 页面在后台不轮询：浏览器会把定时器节流到 1/分钟，但前台可见时是实打实的 2 req/s。
  // 回到前台由 visibilitychange 立刻补一次（见文件末尾）。
  if (document.hidden) return
  pollWaitBusy = true
  var done = function () { pollWaitBusy = false }
  try {
    fetch(WAIT_URL, { cache: 'no-store' })`

const MARK_POLL_WAIT_HEAD = `var pollWaitBusy = false`

// ⑫-2 pollWaitState 收尾 + pollLastTurn 开头
const ORIGINAL_POLL_WAIT_TAIL = `        if (on && sel && ev.soundOn !== false) playBindingSound({ on: true, sel: sel }, ev)
      })
      .catch(function () {})
  } catch (err) {}
}
function pollLastTurn() {
  try {
    fetch(LAST_TURN_URL, { cache: 'no-store' })`

const PATCHED_POLL_WAIT_TAIL = `        if (on && sel && ev.soundOn !== false) playBindingSound({ on: true, sel: sel }, ev)
      })
      .then(done, done)
  } catch (err) { done() }
}
var pollLastTurnBusy = false
function pollLastTurn() {
  if (pollLastTurnBusy) return
  if (document.hidden) return
  pollLastTurnBusy = true
  var done = function () { pollLastTurnBusy = false }
  try {
    fetch(LAST_TURN_URL, { cache: 'no-store' })`

const MARK_POLL_WAIT_TAIL = `var pollLastTurnBusy = false`

// ⑫-3 pollLastTurn 收尾 + 回前台立刻补一次
const ORIGINAL_POLL_TURN_TAIL = `      })
      .catch(function () {})
  } catch (err) {}
}
setInterval(function () { pollLastTurn(); pollWaitState() }, 1000)
}`

const PATCHED_POLL_TURN_TAIL = `      })
      .then(done, done)
  } catch (err) { done() }
}
setInterval(function () { pollLastTurn(); pollWaitState() }, 1000)
// issue #342：页面回到前台立刻补一次（后台期间被跳过的轮询不补，避免切回来瞬间打一串请求）。
// 两个 poll 各自有 in-flight 守卫，这里连调两次也不会并发。
try {
  document.addEventListener('visibilitychange', function () {
    try {
      if (document.hidden) return
      pollLastTurn()
      pollWaitState()
    } catch (err) {}
  })
} catch (err) {}
}`

const MARK_POLL_TURN_TAIL = `      pollLastTurn()
      pollWaitState()`

const FRONT_ANCHORS = [
  {
    file: FRONT_REL,
    name: 'express() 作废光标矩形缓存',
    from: ORIGINAL_EXPRESS_TAIL, to: PATCHED_EXPRESS_TAIL, mark: MARK_EXPRESS_TAIL,
    hints: ['function express()', "root.classList.toggle('dshwv-left'", 'function settle()'],
  },
  {
    file: FRONT_REL,
    name: '命中图 alpha 表（声明）',
    from: ORIGINAL_HIT_DECL, to: PATCHED_HIT_DECL, mark: MARK_HIT_DECL,
    hints: ['var hitFailed = false', 'function setupHitTest(url)', 'var probe = new Image()'],
  },
  {
    file: FRONT_REL,
    name: '命中图 alpha 表（整张读一次）',
    from: ORIGINAL_HIT_READ, to: PATCHED_HIT_READ, mark: MARK_HIT_READ,
    hints: ['ctx.drawImage(probe, dx, dy, dw, dh)', 'v756（issue #144）'],
  },
  {
    file: FRONT_REL,
    name: '命中图 alpha 表（不透明采样）',
    from: ORIGINAL_HIT_SAMPLE, to: PATCHED_HIT_SAMPLE, mark: MARK_HIT_SAMPLE,
    hints: ['opaque++', 'if (!opaque) { hitReady = false'],
  },
  {
    file: FRONT_REL,
    name: 'whaleRectHit → whaleRectHitAt',
    from: ORIGINAL_RECT_HIT, to: PATCHED_RECT_HIT, mark: MARK_RECT_HIT,
    hints: ['function whaleRectHit(e)', 'img.getBoundingClientRect()'],
  },
  {
    file: FRONT_REL,
    name: 'buildHitClipPath 改读 alpha 表',
    from: ORIGINAL_CLIP_PATH, to: PATCHED_CLIP_PATH, mark: MARK_CLIP_PATH,
    hints: ['function buildHitClipPath()', 'getImageData(0, 0, 610, 610)'],
  },
  {
    file: FRONT_REL,
    name: 'isWhaleHit → isWhaleHitAt',
    from: ORIGINAL_IS_HIT, to: PATCHED_IS_HIT, mark: MARK_IS_HIT,
    hints: ['function isWhaleHit(e)', 'getImageData(Math.floor(lx), Math.floor(ly), 1, 1)'],
  },
  {
    file: FRONT_REL,
    name: '光标矩形缓存 + onDocPointerMoveCursor 头',
    from: ORIGINAL_CURSOR_HEAD, to: PATCHED_CURSOR_HEAD, mark: MARK_CURSOR_HEAD,
    hints: ['function onDocPointerMoveCursor(e)', 'if (drag && drag.active) {'],
  },
  {
    file: FRONT_REL,
    name: '光标判定改 rAF 节流',
    from: ORIGINAL_CURSOR_BODY, to: PATCHED_CURSOR_BODY, mark: MARK_CURSOR_BODY,
    hints: ['var el = null', 'document.elementFromPoint(e.clientX, e.clientY)'],
  },
  {
    file: FRONT_REL,
    name: '光标判定改矩形粗判',
    from: ORIGINAL_CURSOR_OVER, to: PATCHED_CURSOR_OVER, mark: MARK_CURSOR_OVER,
    hints: ['var over = isWhaleHit(e)', 'setWidgetCursor(over'],
  },
  {
    file: FRONT_REL,
    name: '光标矩形缓存失效点',
    from: ORIGINAL_CURSOR_LISTEN, to: PATCHED_CURSOR_LISTEN, mark: MARK_CURSOR_LISTEN,
    hints: ["document.addEventListener('pointermove', onDocPointerMoveCursor, true)", '启动即应用一次菜单按钮可见性'],
  },
  {
    file: FRONT_REL,
    name: 'endDrag 作废光标矩形缓存',
    from: ORIGINAL_ENDDRAG, to: PATCHED_ENDDRAG, mark: MARK_ENDDRAG,
    hints: ['function endDrag(e, clickAllowed, cancelled)', "root.classList.remove('dshwv-dragging')"],
  },
  {
    file: FRONT_REL,
    name: 'pollWaitState in-flight 守卫',
    from: ORIGINAL_POLL_WAIT_HEAD, to: PATCHED_POLL_WAIT_HEAD, mark: MARK_POLL_WAIT_HEAD,
    hints: ['function pollWaitState()', 'fetch(WAIT_URL'],
  },
  {
    file: FRONT_REL,
    name: 'pollWaitState 收尾 + pollLastTurn 守卫',
    from: ORIGINAL_POLL_WAIT_TAIL, to: PATCHED_POLL_WAIT_TAIL, mark: MARK_POLL_WAIT_TAIL,
    hints: ['playBindingSound({ on: true, sel: sel }, ev)', 'function pollLastTurn()'],
  },
  {
    file: FRONT_REL,
    name: 'pollLastTurn 收尾 + 回前台补一次',
    from: ORIGINAL_POLL_TURN_TAIL, to: PATCHED_POLL_TURN_TAIL, mark: MARK_POLL_TURN_TAIL,
    hints: ['setInterval(function () { pollLastTurn(); pollWaitState() }, 1000)', 'visibilitychange'],
  },
]

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
  node patch.mjs --revert           还原到打补丁前（优先用 *.bak，两个文件一起还原）`

// —— 定位 ——

function looksLikePlugin(dir) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
    return pkg.name === PKG && fs.existsSync(path.join(dir, HOST_REL))
  } catch (err) { return false }
}

function resolveTargets(opts) {
  if (opts.dir) {
    const abs = path.resolve(opts.dir)
    if (looksLikePlugin(abs)) return [abs]
    const nested = path.join(abs, 'node_modules', PKG)
    if (looksLikePlugin(nested)) return [nested]
    if (fs.existsSync(path.join(abs, HOST_REL))) return [abs] // 没有 package.json 也认，交给后面报错
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

// —— 锚点表：按目标文件分组 ——
// 4 个原有锚点 + NEW_ANCHORS 表里的全部新增锚点，都落在 lib/index.js；
// FRONT_ANCHORS 全部落在 assets/whale-widget.js。
const HOST_ANCHORS = [
  {
    file: HOST_REL,
    name: 'connectionFence 栅栏兼容',
    from: ORIGINAL_FENCE, to: PATCHED_FENCE, mark: MARK_FENCE,
    hints: ['function connectionFence()', 'connectionFence', 'requestRejection'],
  },
  {
    file: HOST_REL,
    name: 'rejected() 栅栏分派',
    from: ORIGINAL_DISPATCH, to: PATCHED_DISPATCH, mark: MARK_DISPATCH,
    hints: ['code = conn.requestRejection(req)', 'conn.requestRejection(req)', 'requestRejection'],
  },
  {
    file: HOST_REL,
    name: 'root.inject 列表',
    from: ORIGINAL_INJECT, to: PATCHED_INJECT, mark: MARK_INJECT,
    hints: ["root.inject(['webServer'", 'root.inject(', 'inject('],
  },
  {
    file: HOST_REL,
    name: '音效查表原型链',
    from: ORIGINAL_SOUND, to: PATCHED_SOUND, mark: MARK_SOUND,
    hints: ['function serveSound(req, res, candidates)', 'serveSound(', 'SOUND_SETS['],
  },
  ...NEW_ANCHORS.map((a) => ({ ...a, file: HOST_REL })),
]

const ANCHORS = [...HOST_ANCHORS, ...FRONT_ANCHORS]
const anchorsFor = (rel) => ANCHORS.filter((a) => a.file === rel)
// 每个文件的锚点数（半打补丁检测按文件算）
const MARK_COUNT = Object.fromEntries(TARGET_FILES.map((rel) => [rel, anchorsFor(rel).length]))

// 返回 { state: 'patched' | 'original', total } 或抛错（漂移 / 半打补丁）
function inspectFile(src, rel) {
  const list = anchorsFor(rel)
  const total = list.length
  const marks = {}
  for (const a of list) marks[a.name] = src.includes(a.mark)
  const hit = Object.values(marks).filter(Boolean).length
  if (hit === total) return { state: 'patched', total }

  if (hit > 0) {
    // 只打了一部分：可能是别的补丁、或上游改过其中一处。不猜，直接失败。
    const err = new Error(
      `${rel} 处于"半打补丁"状态：${total} 处标记只命中 ${hit} 处。`
      + '\n  ' + Object.entries(marks).map(([k, v]) => `${k} 已改：${v ? '是' : '否'}`).join('\n  ')
      + '\n  请先 --revert，或手动核对后再跑。',
    )
    err.drift = true
    throw err
  }

  const counts = {}
  for (const a of list) counts[a.name] = countOf(src, a.from)
  if (Object.values(counts).every((n) => n === 1)) return { state: 'original', total }

  // 全部报出来，别让用户改完一处再撞下一处
  const problems = Object.entries(counts)
    .filter(([, n]) => n !== 1)
    .map(([name, n]) => `找不到 ${name} 的目标代码块（命中 ${n} 次，期望 1 次）。`
      + '\n上游可能改过这段。实际找到的内容片段：\n'
      + snippetAround(src, list.find((a) => a.name === name).hints))
  const err = new Error(problems.join('\n\n'))
  err.drift = true
  throw err
}

function applyPatchFile(src, rel) {
  let out = src
  // 用函数形式替换：补丁块里若出现 $& / $1 之类，字符串形式会被 String.replace 当替换模式解释
  for (const a of anchorsFor(rel)) out = out.replace(a.from, () => a.to)
  return out
}

function reversePatchFile(src, rel) {
  let out = src
  // 逆序还原，避免前一处还原出的原文被后一处误匹配
  for (const a of [...anchorsFor(rel)].reverse()) out = out.replace(a.to, () => a.from)
  return out
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

// 对**内存里的内容**做语法校验（先写临时文件再 node --check），用于"两个文件都验完再落盘"
function syntaxOkText(text, rel) {
  const tmp = path.join(os.tmpdir(), `dsh-whale-patch-${process.pid}-${path.basename(rel)}`)
  try {
    fs.writeFileSync(tmp, text)
    return syntaxOk(tmp)
  } finally {
    try { fs.unlinkSync(tmp) } catch (err) {}
  }
}

// —— 主流程 ——

function readVersion(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version || '未知' } catch (err) { return '未知' }
}

// 第一阶段：把两个文件都读进来、检查状态、算出新内容、验语法。任何一处失败都不写盘。
function planPatch(dir) {
  const plan = []
  for (const rel of TARGET_FILES) {
    const file = path.join(dir, rel)
    if (!fs.existsSync(file)) {
      return { error: `缺少 ${rel}（${file}）` }
    }
    const src = fs.readFileSync(file, 'utf8')
    let info
    try { info = inspectFile(src, rel) } catch (err) {
      return { error: err.message }
    }
    if (info.state === 'patched') {
      plan.push({ rel, file, src, next: src, state: 'patched', added: 0 })
      continue
    }
    const next = applyPatchFile(src, rel)
    if (next === src) {
      return { error: `${rel}：替换后内容未变化，说明锚点匹配异常。未写入。` }
    }
    const chk = syntaxOkText(next, rel)
    if (!chk.ok) {
      return { error: `${rel}：打补丁后 node --check 未通过，未写入。\n${chk.msg}` }
    }
    plan.push({
      rel, file, src, next, state: 'original',
      added: next.split('\n').length - src.split('\n').length,
    })
  }
  return { plan }
}

function doPatch(dir, opts) {
  const version = readVersion(dir)
  console.log(`\n插件目录：${dir}`)
  console.log(`上游版本：${PKG}@${version}`)
  console.log(`目标文件：${TARGET_FILES.join(' + ')}`)

  const planned = planPatch(dir)
  if (planned.error) {
    console.error(`\n失败：${planned.error}`)
    console.error('\n未写入任何文件。')
    return 1
  }
  const { plan } = planned

  let pending = 0
  for (const p of plan) {
    if (p.state === 'patched') {
      console.log(`  ${p.rel}：已是最新（${MARK_COUNT[p.rel]} 处锚点全部在位），无需改动。`)
    } else {
      pending++
      console.log(`  ${p.rel}：待打补丁（${MARK_COUNT[p.rel]} 处锚点，将新增 ${p.added} 行）`)
    }
  }
  if (pending === 0) {
    console.log('状态：已是最新（补丁已在位），无需改动。')
    return 0
  }

  if (opts.check) {
    console.log('--check：只报告，不写文件。')
    return 0
  }

  // 第二阶段：备份 + 落盘（两个文件都验过了，这里只做 IO）
  for (const p of plan) {
    if (p.state === 'patched') continue
    const backup = path.join(dir, backupRel(p.rel))
    // 已存在则不覆盖，保留最早的原始副本
    if (fs.existsSync(backup)) {
      console.log(`备份：${backupRel(p.rel)} 已存在，保留不覆盖。`)
    } else {
      fs.writeFileSync(backup, p.src)
      console.log(`备份：已写入 ${backupRel(p.rel)}`)
    }
    fs.writeFileSync(p.file, p.next)
    const chk = syntaxOk(p.file)
    if (!chk.ok) {
      fs.writeFileSync(p.file, p.src)
      console.error(`失败：${p.rel} 落盘后 node --check 未通过，已回滚到原内容。`)
      console.error(chk.msg)
      return 1
    }
    console.log(`语法：${p.rel} node --check 通过`)
  }
  console.log('完成：补丁已应用。重启 dsh 后生效。')
  return 0
}

// 第一阶段：算出每个文件要还原成什么。任何一处失败都不写盘。
function planRevert(dir) {
  const plan = []
  for (const rel of TARGET_FILES) {
    const file = path.join(dir, rel)
    if (!fs.existsSync(file)) {
      return { error: `缺少 ${rel}（${file}）` }
    }
    const src = fs.readFileSync(file, 'utf8')
    const backup = path.join(dir, backupRel(rel))

    // 先看当前状态：本来就是原版就直接收工，别把备份再写一遍
    let current = null
    try { current = inspectFile(src, rel) } catch (err) { current = null }
    if (current && current.state === 'original') {
      plan.push({ rel, file, src, target: src, how: null, state: 'original' })
      continue
    }

    let target = null
    let how = ''
    if (fs.existsSync(backup)) {
      const bak = fs.readFileSync(backup, 'utf8')
      // 备份必须是"未打补丁"的原版，否则不用它（避免把别的状态写回去）
      let bakClean = false
      try { bakClean = inspectFile(bak, rel).state === 'original' } catch (err) { bakClean = false }
      if (bakClean) { target = bak; how = `备份文件 ${backupRel(rel)} ` }
    }
    if (target === null) {
      let info
      try { info = inspectFile(src, rel) } catch (err) {
        return { error: err.message }
      }
      if (info.state === 'original') {
        plan.push({ rel, file, src, target: src, how: null, state: 'original' })
        continue
      }
      target = reversePatchFile(src, rel)
      how = '反向替换'
      if (target === src) {
        return { error: `${rel}：反向替换未产生变化。未写入。` }
      }
    }
    const chk = syntaxOkText(target, rel)
    if (!chk.ok) {
      return { error: `${rel}：还原后 node --check 未通过，未写入。\n${chk.msg}` }
    }
    plan.push({ rel, file, src, target, how, state: 'patched' })
  }
  return { plan }
}

function doRevert(dir, opts) {
  const version = readVersion(dir)
  console.log(`\n插件目录：${dir}`)
  console.log(`上游版本：${PKG}@${version}`)
  console.log(`目标文件：${TARGET_FILES.join(' + ')}`)

  const planned = planRevert(dir)
  if (planned.error) {
    console.error(`\n失败：${planned.error}`)
    console.error('\n未写入任何文件。')
    return 1
  }
  const { plan } = planned

  const todo = plan.filter((p) => p.state === 'patched')
  if (todo.length === 0) {
    console.log('状态：本来就是原版（补丁不在位），无需还原。')
    return 0
  }
  for (const p of todo) console.log(`  ${p.rel}：将用${p.how}还原`)

  if (opts.check) {
    console.log('--check：只报告，不写文件。')
    return 0
  }

  for (const p of todo) {
    fs.writeFileSync(p.file, p.target)
    const chk = syntaxOk(p.file)
    if (!chk.ok) {
      fs.writeFileSync(p.file, p.src)
      console.error(`失败：${p.rel} 还原后 node --check 未通过，已回滚。`)
      console.error(chk.msg)
      return 1
    }
    console.log(`还原：已用${p.how}还原 ${p.rel}`)
    console.log(`语法：${p.rel} node --check 通过`)
  }
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
