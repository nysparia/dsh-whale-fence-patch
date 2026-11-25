#!/usr/bin/env node
// dsh-whale-fence-patch —— 给已安装的 dsh-whale-widget 打上游 bug 的补丁。
//
// 改 lib/index.js 里的七组（共 24 个锚点）：
//   ① connectionFence()           —— 栅栏兼容（DSH >= 0.2.2-rc.2 的 admit）
//   ② rejected() 的栅栏分派        —— 同上
//   ③ root.inject 列表             —— 补 connection.authentication，否则 admit 恒抛
//   ④ 音效路由的原型链查表          —— ?set=__proto__ 等键名导致 400
//   ⑤ body 超限返回 413            —— readBodyLimited + 9 处 catch 透出 err.status
//   ⑥ 三个 POST-only 路由的方法守卫  —— GET 打进来 405 而不是 400
//   ⑦ 2027 年节假日 + 覆盖终点下发   —— HOLIDAY_VALLEY 补 29 条，下发 peakHolidaysCoveredThrough
//   ⑧ 配置文件损坏备份              —— backupCorruptFile + 四个读取函数
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

// —— 新增锚点表 ——
// 每一项：{ name, from, to, mark, hints }
//   from  上游原版里必须恰好出现 1 次的代码块
//   to    补丁后的代码块（revert 时反向替换，也必须恰好出现 1 次）
//   mark  打过补丁才有的标记，用于幂等判定与半打补丁检测
//   hints 漂移时用来打印"实际找到的片段"的搜索串
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
// 4 个原有锚点 + NEW_ANCHORS 表里的全部新增锚点
const MARK_COUNT = 4 + NEW_ANCHORS.length

function inspect(src) {
  const marks = {
    connectionFence: src.includes(MARK_FENCE),
    rejected分派: src.includes(MARK_DISPATCH),
    inject列表: src.includes(MARK_INJECT),
    音效查表: src.includes(MARK_SOUND),
  }
  for (const a of NEW_ANCHORS) marks[a.name] = src.includes(a.mark)
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
  for (const a of NEW_ANCHORS) counts[a.name] = countOf(src, a.from)
  if (Object.values(counts).every((n) => n === 1)) return { state: 'original' }

  // 四处都报，别让用户改完一处再撞下一处
  const hints = {
    connectionFence: ['function connectionFence()', 'connectionFence'],
    rejected分派: ['code = conn.requestRejection(req)', 'conn.requestRejection(req)', 'requestRejection'],
    inject列表: ["root.inject(['webServer'", 'root.inject(', 'inject('],
    音效查表: ['function serveSound(req, res, candidates)', 'serveSound(', 'SOUND_SETS['],
  }
  for (const a of NEW_ANCHORS) hints[a.name] = a.hints
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
  let out = src.replace(ORIGINAL_FENCE, PATCHED_FENCE)
    .replace(ORIGINAL_DISPATCH, PATCHED_DISPATCH)
    .replace(ORIGINAL_INJECT, PATCHED_INJECT)
    .replace(ORIGINAL_SOUND, PATCHED_SOUND)
  // 用函数形式替换：补丁块里若出现 $& / $1 之类，字符串形式会被 String.replace 当替换模式解释
  for (const a of NEW_ANCHORS) out = out.replace(a.from, () => a.to)
  return out
}

function reversePatch(src) {
  let out = src.replace(PATCHED_FENCE, ORIGINAL_FENCE)
    .replace(PATCHED_DISPATCH, ORIGINAL_DISPATCH)
    .replace(PATCHED_INJECT, ORIGINAL_INJECT)
    .replace(PATCHED_SOUND, ORIGINAL_SOUND)
  // 逆序还原，避免前一处还原出的原文被后一处误匹配
  for (const a of [...NEW_ANCHORS].reverse()) out = out.replace(a.to, () => a.from)
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
