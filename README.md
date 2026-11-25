# dsh-whale-fence-patch

> **社区补丁，非上游官方。** 上游 `dsh-whale-widget` 自 0.4.2（2026-10-11）起没有新版本，本仓库是第三方临时方案。上游修复后请卸载。

给已安装的 [`dsh-whale-widget`](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget) 打上游 bug 的补丁，共十组：

| # | 修的问题 | 锚点数 | 净增行 |
|---|---|---|---|
| ① ② ③ | **信任栅栏兼容** —— 让它在 DSH 0.2.2-rc.2 及以上版本上正常工作 | 3 | +24 |
| ④ | **音效路由的原型链查表崩溃** —— `?set=__proto__` 之类的键名返回 400 | 1 | +13 |
| ⑤ | **body 超限返回 413 而不是断连** —— 600KB body 原来得到 curl exit=56 | 10 | +21 |
| ⑥ | **三个 POST-only 路由加方法守卫** —— GET 打进来 405 而不是 400 | 3 | +18 |
| ⑦ | **2027 年节假日 + 覆盖终点下发** —— 节假日表只到 2026-10-07 | 2 | +32 |
| ⑧ | **配置文件损坏备份** —— 坏 JSON 被静默覆盖，数据永久丢失 | 5 | +41 |
| ⑨ | **waitState 跨会话状态污染** —— 子 agent 一开跑就清掉主会话的提问气泡 | 4 | +64 |
| ⑩ | **账本 IO 退避阻塞事件循环 + update-check 并发打爆上游** —— `Atomics.wait` 退避最坏 305ms 卡住宿主；8 并发发起 8 轮上游 | 2 | +42 |

共 **30 个锚点**。① ② ③ 是同一组（栅栏），④ 与栅栏无关，⑤~⑩ 是另外六个独立 bug。

**本仓库不包含上游的任何代码或素材**，只有一个改写脚本（`patch.mjs`）和它的测试。脚本就地修改你机器上已经装好的那份上游副本，素材仍然用上游的。

## 症状

在 DSH 0.2.2-rc.2 及以上的宿主上，插件加载时会打一条 warn：

```
[whale-balance] 宿主信任栅栏不可用（connection.requestRejection 缺失）：已启用插件自带的回环/同源校验，…
```

随后出现两类行为偏差：

1. **宿主返回的 401 / 503 被吞掉。** 插件本该把宿主的拒绝码原样透出，实际却当成"没被拒"放行到路由。
2. **宿主已通过 `trustedHosts` 信任的非回环权威被插件误判 403。** 也就是上游 [issue #277](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget/issues/277) 报的那条：用反代或局域网地址打开面板，挂件的接口全 403。该 issue 下的复现记录显示，把 `Host` 头改成中继域名即可在本机复现，不需要真的开远端。

## 根因

DSH 在 **0.2.2-rc.2** 移除了 `connection.requestRejection`，改用 `connection.admit(request) -> { peer } | { rejection: 401|403|503 }`。

迁移指南：`docs/upgrade-guide/v0.2.2-rc.2/connection-page-peer/guide.md`（DSH 仓库内），其中第 5 条明确写着"使用 `admit` 替代 `requestRejection`"。

插件的 `connectionFence()` 只认 `requestRejection`：

```js
function connectionFence() {
  try {
    const conn = ctx.get('connection') || ctx.connection
    return conn && typeof conn.requestRejection === 'function' ? conn : null
  } catch (err) { return null }
}
```

新版宿主上这个函数恒返回 `null`，于是：

- 加载时打上面那条 warn；
- `rejected()` 里 `if (!conn) return false` 短路，宿主栅栏整层失效；
- 自校验因为"栅栏不可用"而收紧，把宿主已信任的权威判成 403。

## 第二个 bug：音效路由的原型链查表崩溃

这一条**与栅栏无关**，在旧版 DSH 上同样存在，只是被 400 掩盖着不容易注意到。

### 症状

`/dsh-whale/sound/press.mp3` 和 `/dsh-whale/sound/release.mp3` 两个路由，当 `?set=` 参数是 JavaScript 原型链上的键名时返回 **400**，且响应头**没有 `Content-Type`**：

```
GET /dsh-whale/sound/press.mp3?set=duck          → 200
GET /dsh-whale/sound/press.mp3?set=fx1           → 200
GET /dsh-whale/sound/press.mp3?set=__proto__     → 400  ← BUG
GET /dsh-whale/sound/press.mp3?set=constructor   → 400  ← BUG
GET /dsh-whale/sound/press.mp3?set=toString      → 400  ← BUG
GET /dsh-whale/sound/press.mp3?set=valueOf       → 400  ← BUG
GET /dsh-whale/sound/press.mp3?set=hasOwnProperty → 400 ← BUG
```

没有 `Content-Type` 是关键线索：这个 400 不是插件自己写的，是宿主 webserver 的兜底 catch 产生的（`packages/host/webserver/src/index.ts:660`，`res.writeHead(400); res.end()`）。

### 根因

`SOUND_SETS` 是普通对象字面量：

```js
const SOUND_SETS = {
  duck: { press: [...], release: [...] },
  fx1:  { press: [...], release: [...] },
}
```

`SOUND_SETS['__proto__']` 返回 `Object.prototype`，`SOUND_SETS['constructor']` 返回 `Function` —— 两者都 **truthy**，所以 `|| SOUND_SETS.duck` 的兜底不生效。随后 `set.press` 是 `undefined`，`loadSound` 里 `for (const p of candidates)` 抛：

```
TypeError: candidates is not iterable
    at loadSound
    at serveSound
    at handler
```

这个异常没人接，冒到宿主兜底 catch，变成 400。

同一个 truthy 判断还让自定义音效组分支进不去（`!SOUND_SETS[setName]` 对原型键也是 `false`），所以直接掉到 `serveSound(req, res, set.press)`。

### 修法

查表改走 `Object.hasOwn`，并在 `serveSound` 里加第二道防线：

```js
function soundSetFor(name) {
  return Object.hasOwn(SOUND_SETS, name) ? SOUND_SETS[name] : SOUND_SETS.duck
}
```

两个 handler 的自定义组判定也改成 `!Object.hasOwn(SOUND_SETS, setName)`，`serveSound` 里改成 `Array.isArray(candidates) ? loadSound(candidates) : null`。

**为什么不在 `soundSetFromUrl` 里做白名单拒绝**：`?set=` 同时承载自定义音效组 id（`group_xxx`），白名单会把用户自建的组一起拒掉。

**为什么不只加 `Array.isArray` 兜底**：那样 `?set=__proto__` 会变成 404（"sound unavailable"）而不是降级到 duck。语义上"未知组名回退默认音效"才是这个路由原本的意图，`Object.hasOwn` 直接表达它。

### 同类模式排查

`lib/index.js` 里所有 `OBJ[userInput]` 形式的查表都逐个验过：

| 查表 | 原型键下的行为 | 结论 |
|---|---|---|
| `SOUND_SETS[key]`（两个 handler） | 返回 `Object.prototype` / `Function` → 抛 TypeError | **不安全，已修** |
| `PRESET_FRAGMENTS[fragId]` | truthy，但只用于 `if` 判定与取 `.name`/`.mime`，取到 `undefined` 后走默认值 | 安全（不抛） |
| `BUILTIN_FRAGMENT_FILES[fragId]` | truthy → 进 `loadSound(undefined)` | **会抛**，但入口 `audioFragmentPath` 有 `/^[A-Za-z0-9_-]{1,64}$/` 正则先挡掉 `__proto__` 等键名 | 实际不可达 |
| `PRESET_GROUPS[groupId]` | truthy → `preset[slot]` 是 `undefined` | 安全（返回 undefined，调用方有兜底） |
| `DEFAULT_BUBBLE_IMGS.find(...)` | 数组，无原型链问题 | 安全 |

## 第五处：body 超限返回 413 而不是断连

### 症状

POST 一个超过路由上限的 body，客户端拿到的是**连接被重置**，不是 413：

```
$ curl -X POST --data-binary @600kb.json http://127.0.0.1:3080/dsh-whale/bubble.json
curl: (56) Recv failure: Connection reset by peer
（状态码 000，不是 413）
```

`/dsh-whale/bubble.json` 的上限是 512KB，`bubble-img-upload.json` 是 10MB，`role-pin.json` / `role-delete.json` 是 8KB。

### 根因

`readBodyMax` 超限时先 `reject` 再 `req.destroy()`：

```js
req.on('data', (c) => {
  size += c.length
  if (size > maxBytes) {
    reject(new Error('body too large'))
    req.destroy()          // ← 直接销毁 socket
    return
  }
  chunks.push(c)
})
```

`req.destroy()` 销毁的是底层 socket。调用方（路由 handler）随后 `res.writeHead(413)` 写出的响应**根本到不了客户端** —— 连接已经没了，客户端看到的是 RST。

### 修法

抽出 `readBodyLimited`，超限时**排空**而不是销毁：

```js
function readBodyLimited(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let overflow = false
    req.on('data', (c) => {
      if (overflow) return          // 已超限：继续吃掉剩余数据，别让客户端撞 RST
      size += c.length
      if (size > maxBytes) {
        overflow = true
        chunks.length = 0
        req.resume()                // ← 排空，不是 destroy
        const error = new Error('body too large')
        error.status = 413          // ← 带上状态码
        reject(error)
        return
      }
      chunks.push(c)
    })
    req.on('end', () => { if (!overflow) resolve(Buffer.concat(chunks).toString('utf8')) })
    req.on('error', (err) => { if (!overflow) reject(err) })
  })
}
```

`readBody` / `readBodyMax` 都委托给它。这与 DSH 自己的 `readBoundedBody` 同一做法（`packages/host/open-in-app/src/index.ts:93`，那里也是 `resume()` 后返回 null）。

**光有 `status = 413` 还不够**：9 处 `catch (err)` 里写死了 `res.writeHead(400, ...)`，会把 413 压回 400。这 9 处必须一起改成 `res.writeHead(err.status || 400, ...)`。

### 哪些 400 不能改

`res.writeHead(400, JSON_HEADERS)` 在上游出现 22 次，其中 **13 次是业务错误**，必须保持 400 —— 它们不是 `readBodyMax` 抛的，`err.status` 是 `undefined`：

| 保持 400 的业务错误 | 位置 |
|---|---|
| `missing scale` | size.json |
| `invalid image data` / `image too large` | roles.json、bubble-img-upload.json |
| `cannot delete default role` | role-delete.json |
| `invalid wav data` / `audio too large` | audio.json |
| `cannot delete preset group` / `cannot delete preset fragment` | audio.json |
| `unknown action` | audio.json、bubble-img-upload.json |
| `invalid bubble config` | bubble.json |

改动只落在 `catch (err) {` 紧跟的那一行。锚点用「catch 行 + writeHead 行 + res.end 行」的窗口，每个窗口在原文里恰好出现 1 次 —— 业务 400 的窗口前面是 `if (...) {`，不会误匹配。

### 验证结果

| 用例 | 补丁前 | 补丁后 |
|---|---|---|
| 600KB body → `/dsh-whale/bubble.json`（512KB 上限） | curl exit=56，状态码 000 | **413**，`{"ok":false,"error":"body too large"}`，curl exit=0 |
| 小 body（`{"items":[],"lib":[]}`） | 200 | 200（不回归） |
| 413 之后同一条连接再发一次 | — | 413（连接可复用，服务健康） |

## 第六处：三个 POST-only 路由加方法守卫

### 症状

`role-pin.json`、`role-delete.json`、`bubble-img-upload.json` 三个路由是纯写接口，但用 GET 打进去返回 **400**，而不是 405：

```
GET /dsh-whale/role-pin.json          → 400  ← BUG（应为 405）
GET /dsh-whale/role-delete.json       → 400  ← BUG
GET /dsh-whale/bubble-img-upload.json → 400  ← BUG
```

### 根因

三个 handler 开头没有方法检查，直接进 `try`：

```js
handler: async (req, res) => {
  try {
    const body = await readBodyMax(req, 8192)
    const parsed = JSON.parse(body)     // ← GET 没有 body，JSON.parse('') 抛错
```

GET 请求没有 body，`readBodyMax` 返回空串，`JSON.parse('')` 抛 `SyntaxError: Unexpected end of JSON input`，被 `catch` 成 400。

400 在语义上是错的：请求本身没问题，是**方法**不被支持。405 才能让客户端（和中间层）正确区分。

### 修法

三个 handler 开头各加一段守卫：

```js
// 纯写接口：GET 打进来必须 405，不能落到「空 body → JSON.parse 抛错 → 400」。
if (req.method !== 'POST' && req.method !== 'PUT') {
  res.writeHead(405, { ...JSON_HEADERS, Allow: 'POST, PUT' })
  res.end(JSON.stringify({ ok: false, error: '不支持的请求方法' }))
  return
}
```

`Allow: POST, PUT` 是 405 的必备响应头（RFC 9110 §15.5.6）。

**为什么允许 PUT**：上游这三个路由本来就接受 PUT（`if (req.method === 'PUT' || req.method === 'POST')` 之类），守卫只拦 GET/HEAD/DELETE 等，不放宽也不收紧写路径。

### 哪些路由不能加

`roles.json`、`audio.json`、`bubble.json` 有 GET 只读分支（GET 返回当前配置，POST/PUT 写入）。给它们加 POST/PUT 守卫会把只读功能一起废掉。测试里有一条断言专门守着这个不误伤。

### 验证结果

| 用例 | 补丁前 | 补丁后 |
|---|---|---|
| `GET role-pin.json` | 400 | **405** + `Allow: POST, PUT` |
| `GET role-delete.json` | 400 | **405** |
| `GET bubble-img-upload.json` | 400 | **405** |
| `POST role-pin.json`（真实 role id） | 200 | 200（不回归） |
| `PUT role-pin.json` | 200 | 200（不回归） |
| `GET roles.json` / `audio.json` / `bubble.json` | 200 | 200（未被误伤） |

## 第七处：2027 年节假日

### 症状

`HOLIDAY_VALLEY` 只到 `'2026-10-07': 1,`。2027 年的法定节假日全部缺失，`isHolidayValley()` 查不到就退回普通峰谷判断 —— **节假日按高峰计价**，账目算错。前端「时段倒计时」也跟着算错切换点。

### 根因

节假日表是硬编码的，每年 11 月国务院发布次年安排后必须手工补。上游停在 0.4.2（2026-10-11），2027 年的安排（2026-11-05 发布）没进来。

### 修法

按《国务院办公厅关于 2027 年部分节假日安排的通知》（国办发明电〔2026〕10 号，2026-11-05）补 29 条：

| 节日 | 日期 | 天数 |
|---|---|---|
| 元旦 | 2027-01-01 – 01-03 | 3 |
| 春节 | 2027-02-05 – 02-13 | 9 |
| 清明 | 2027-04-03 – 04-05 | 3 |
| 劳动节 | 2027-05-01 – 05-05 | 5 |
| 端午 | 2027-06-09 | 1 |
| 中秋 | 2027-09-15 | 1 |
| 国庆 | 2027-10-01 – 10-07 | 7 |

调休上班日（2027 年为 1/31、2/14、5/8、9/26、10/9）全部落在周末，按"周末也算谷价"的规则本来就是谷价，无需单列。

同时新增 `HOLIDAY_VALLEY_COVERED_THROUGH = '2027-12-31'`，并在 `/dsh-whale/balance.json` 里下发 `peakHolidaysCoveredThrough`。前端据此判断"当前日期已超出已知安排"，超出时明确降级而不是静默算错。

**为什么这个字段重要**：没有它，2028 年的节假日会被当成普通工作日按高峰计价，而且**没有任何信号**。有了它，挂件能显示"节假日安排未覆盖"。

### 验证结果

```
GET /dsh-whale/balance.json
  peakHolidays: 总 62 条，2026 33 条，2027 29 条
  2027 首尾: 2027-01-01 … 2027-10-07
  peakHolidaysCoveredThrough = '2027-12-31'
```

## 第八处：配置文件损坏备份

### 症状

四份 JSON 配置（`.dshw-bubble.json` 泡泡配置、`roles.json` 角色索引、`audio.json` 音效索引、`bubble-imgs.json` 泡泡图库索引）被写坏后：

1. GET 返回默认结构（`config: null` / 空列表），看起来像"配置丢了"；
2. **下一次写入直接覆盖坏文件** —— 坏内容永久丢失，无法恢复。

实测：写坏 `.dshw-bubble.json` 后 GET 返回 `config:null`，POST 一次就没了。

### 根因

四个读取函数都是 `catch (err) {}` 空吞：

```js
function readRolesIndex() {
  const dir = pickRoleDir()
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, ROLE_INDEX_NAME), 'utf8'))
    if (parsed && Array.isArray(parsed.roles)) { ... return parsed }
  } catch (err) {}          // ← 解析失败静默返回默认结构
  return defaultRolesIndex()
}
```

`catch` 把「文件不存在」和「文件损坏」当成同一件事，都返回默认结构。调用方拿到默认结构后照常写入，坏文件就被覆盖了。

### 修法

新增 `backupCorruptFile(p, why, tag)`，与账本已有的 `ledgerBackupCorrupt` 同一做法：

```js
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
```

四个读取函数改成「读文件」与「解析」两段 try：

- 第一段只 `readFileSync`。`ENOENT` 是首次运行的正常情况，**不备份**，直接返回默认结构；其他错误（EACCES 等）备份。
- 第二段 `JSON.parse`。失败时 `backupCorruptFile(p, 'bad-json', tag)`；解析成功但结构不对（缺 `roles` / `groups` / `images` 数组，或 `v !== 1`）时 `backupCorruptFile(p, 'bad-structure', tag)`。

四个 tag 分别是 `whale-roles` / `whale-audio` / `whale-bubble-imgs` / `whale-bubble`，日志里能直接看出是哪份配置坏了。

**备份失败不能阻止插件工作**：目录只读或文件被占用时，`backupCorruptFile` catch 住只打日志，返回 `null`，读取函数继续用默认结构。宁可丢备份，不能让插件整个挂掉。

**`loadBubbleConfig` 的特殊处理**：它遍历 `BUBBLE_FILE_CANDIDATES` 多个候选路径。坏文件备份后 `continue` 看下一个候选 —— 那里可能还有一份能用的配置。

### 验证结果

```
$ echo 'this is not json {{{' > /tmp/final-home/.dshw-bubble.json
$ curl -b cookie http://127.0.0.1:31799/dsh-whale/bubble.json
{"ok":true,"config":null}

$ ls /tmp/final-home/.dshw-bubble.json*
/tmp/final-home/.dshw-bubble.json.corrupt-1795582333903.bak   ← 新增，21 字节（正是写坏的内容）
```

服务端日志：

```
[whale-bubble] 配置文件损坏（bad-json）→ 已备份为 /tmp/final-home/.dshw-bubble.json.corrupt-1795582333903.bak，并用默认结构重建（原文件未删除）
```


## 第九处：waitState 跨会话状态污染

### 症状

主会话正在等用户回答提问（挂件显示"等待输入"气泡），此时子 agent 开始跑 —— 气泡消失、对话名变成子 agent 的。用户以为提问被取消了，于是不去回答，主会话就一直卡着。

### 根因

挂起状态是**单个全局对象**，而 `session/event` 监听器覆盖**所有会话**（含子 agent）：

```js
const waitState = { pending: null, sessionName: "" }
```

`notePendingEvent(sid, event, session)` 里三处都写这个全局槽位：

```js
waitState.sessionName = ...                                  // 任何会话的标题都会覆盖
waitState.pending = { kind: 'question', ..., session: sid }  // 带了 session 字段，但清除时从不检查
if (type === 'turn/end' || type === 'turn/start') waitState.pending = null   // 无条件清除
```

所以子 agent 的 `turn/start` 会把主会话的挂起清掉。复现（`diag/waitstate-before.mjs`，跑在上游原版上）：

```
主会话提问后 waitState = {"pending":{"kind":"question","id":"q1",...,"session":"main"},"sessionName":"主会话"}
子 agent turn/start 后 waitState = {"pending":null,"sessionName":"子agent"}
```

### 修法

按会话分桶（`Map<sid, { pending, sessionName, lastTs }>`），再用 `waitView()` **选一个**会话上报 —— 挂件只有一个气泡，最终仍要选一个：

- **有挂起的会话优先**（多个挂起取最近的一条）；
- 都没有挂起时，回落到最近有事件的会话（只为拿 `sessionName`）。

⚠️ 只按"最近有事件的会话"选是**不够**的：子 agent 一开跑就成了最近会话，主会话的提问气泡照样消失 —— 那正是本 bug。挂起优先级是修复的必要条件。

⚠️ 子 agent 的挂起**不**按 `subagentMuteOn()` 静音：那个开关管的是"子智能体**完成**时不提示"（已经结束、只是告知），而挂起是"卡住等用户动手"，静音等于让子 agent 永久挂死且用户毫无信号。另外子代理不允许提问，所以 `question` 类实际只来自主会话；能走到这里的子 agent 挂起只可能是 `approval` —— 那恰恰最该让用户看见。

四处锚点：① 状态定义（+`waitBucket`/`waitView`）② `notePendingEvent` ③ `wait.json` 响应体 ④ `session/disposed` 清理（避免已销毁会话的条目长期堆积，另有 200 条上限按 `lastTs` 淘汰）。

`wait.json` 的返回结构**不变**（`{ ok, pending, sessionName }`），前端 `assets/whale-widget.js` 只读这两个字段，不需要改。

### 验证结果

```
$ node diag/waitstate-before.mjs      # 上游原版：bug 复现
$ node diag/waitstate-check.mjs       # 修复后：45 通过 / 0 失败
$ node diag/waitstate-e2e-module.mjs  # 加载真实模块跑真实注册路径：19 通过 / 0 失败
```

变异测试（把 `st.pending = null` 改回"清所有会话"）：4 条用例变红，说明用例真的咬得住。


## 安装

```bash
node patch.mjs --profile web
```

`web` 换成你实际使用的 profile 名。脚本会：

1. 定位 `~/.dsh/profiles/web/node_modules/dsh-whale-widget`；
2. 读 `package.json` 打印版本号；
3. 逐字节匹配上游 0.4.2 的 **30 个锚点**，任何一个找不到就**失败退出**（不猜位置）；
4. 备份原文件到 `lib/index.js.bak`（已存在则不覆盖）；
5. 写入补丁，跑 `node --check` 验证语法，不通过则回滚。

改完重启 dsh 生效。

其他用法：

```bash
node patch.mjs                    # 遍历 ~/.dsh/profiles/*/node_modules/dsh-whale-widget
node patch.mjs --path <dir>       # 直接指定插件目录
node patch.mjs --profile web --check   # 只报告会改什么，不写文件
```

脚本是幂等的：已经打过补丁会报告"已是最新"并退出 0。

## 卸载

```bash
node patch.mjs --profile web --revert
```

优先用 `lib/index.js.bak` 还原；备份不在时用反向替换。还原后文件与上游原版逐字节一致（已用 `sha256sum` 验证）。还原完重启 dsh。

## 测试

```bash
node test/fence.test.mjs --path ~/.dsh/profiles/web/node_modules/dsh-whale-widget
```

测试从**打过补丁的** `lib/index.js` 里抽出栅栏代码段（`const TRUSTED_AUTHORITIES` 到 `// 统一注册入口` 之间），用 `new Function` 包一层，喂给不同形态的 connection 服务。覆盖：

- 常规 10 例（回环 / 伪造 Host / 跨站 / 跨源 Origin / 畸形 Host / 读写方法），legacy 与 modern 两种形态逐条一致；
- trustedHosts 交界 4 例 × 3 种场景；
- `admit` 返回形态 13 例（owner / 非 owner / 无 principal / 401 / 403 / 503 / undefined / null / 抛异常 / 与 `requestRejection` 并存时的优先级）；
- 401 / 503 透出与异常 fail-closed；
- 没有 connection 服务时的降级路径；
- inject 列表必须含 `connection.authentication`（静态断言）。

音效那组（第二个 bug）从同一份 `lib/index.js` 里抽出 `serveSound` / `soundSetFor` / 两个 handler 整段，注入假 `fs` 真跑一遍：

- 12 个原型键（`__proto__` / `constructor` / `toString` / `valueOf` / `hasOwnProperty` / `isPrototypeOf` / `propertyIsEnumerable` / `toLocaleString` / `__defineGetter__` / `__lookupGetter__` / `__lookupSetter__` / `__defineSetter__`）× 2 个路由，断言不抛异常、返回 200、字节等于 duck；
- `soundSetFor` 对原型键返回 `SOUND_SETS.duck`；
- `duck` / `fx1` 各自取到自己的音频（不回归）；
- 无 set / 空 set / 未知组名都降级到 duck；
- 静态断言：剥掉注释后不再有裸的 `SOUND_SETS[userInput]` 查表，两个 handler 都用 `Object.hasOwn`；
- 静态断言：`serveSound` 有 `Array.isArray` 第二道防线。

第五~九处（新增锚点）的测试分两类：

**行为类**（抽函数段，注入假 `req` / `fs` 真跑）：

- `readBodyMax` 超限：错误带 `status=413`、**不** `destroy`、**要** `resume`；
- `readBody`（8192 上限）同样带 413；
- 未超限正常返回文本；恰好等于上限不算超限（边界）；
- 超限后 `end` 事件不覆盖 `reject`（overflow 标志生效）；
- `backupCorruptFile` 把坏文件改名成 `.corrupt-<时间戳>.bak` 并返回备份路径；
- `backupCorruptFile` 备份失败（EACCES）不抛异常，只打日志、返回 `null`。

**静态类**（对源码断言）：

- `err.status || 400` 恰好出现 10 次（9 处新增 + 1 处上游原有）；
- 9 个业务错误（`cannot delete default role` / `invalid image data` / `unknown action` 等）必须仍是裸 400；
- 三个 POST-only 路由都有 `req.method !== 'POST' && req.method !== 'PUT'` 守卫，405 带 `Allow: POST, PUT`；
- `roles.json` / `audio.json` / `bubble.json` **没有**这个守卫（不误伤 GET 只读分支）；
- `HOLIDAY_VALLEY` 含 29 条 2027 日期，2026 的 33 条未被删；
- `HOLIDAY_VALLEY_COVERED_THROUGH = '2027-12-31'` 且已下发为 `peakHolidaysCoveredThrough`；
- 四个读取函数都调 `backupCorruptFile`，区分 `bad-json` / `bad-structure`，且跳过 `ENOENT`；
- 四个读取函数里不再有空 `catch (err) {}`。

全部通过时退出 0。共 **34 个测试**（原有 20 + 新增 14）。

## 许可与素材声明

- **本仓库不包含上游的任何代码或素材。** 仓库里只有 `patch.mjs`、`test/fence.test.mjs`、文档和许可文件。补丁以字符串常量的形式描述"把哪两段改成什么"，不复制上游文件。
- 上游 `dsh-whale-widget` 的**代码**（`lib/`、`cordis.patch.yml`、`package.json`、文档）是 MIT。
- 上游的 **`assets/**`（约 6.6MB 图片 / 动图 / 音效）和 `icon.png` 不在 MIT 覆盖范围内**。上游 `PROVENANCE.md` 写明它们"仅授权随本插件运行使用，不授予再许可"。因此本仓库不重新分发它们 —— 补丁只改用户已安装副本里的 `lib/index.js`，素材仍由那份副本提供。
- 本补丁只改 `lib/index.js`，共 **30 个锚点**：栅栏三处（净增 24 行）、音效查表一处（净增 13 行）、body 超限十处（净增 21 行）、方法守卫三处（净增 18 行）、节假日两处（净增 32 行）、损坏备份五处（净增 41 行）、waitState 分桶四处（净增 64 行）、账本 IO 退避一处（净增 14 行）、update-check 去重一处（净增 28 行）。

## 上游状态

上游 `dsh-whale-widget` 停在 **0.4.2（2026-10-11）**，此后零合并，仓库有 180 个 open issue。本补丁是社区临时方案，不是上游的正式修复。

**上游修复这个问题后，请卸载本补丁**（`--revert`），不要长期叠着。

## 栅栏补丁改了三处，不是两处

第三处是 `root.inject([...])` 的列表，必须加上 `'connection.authentication'`。

**为什么**：`admit()` 内部访问 `this.authentication`，而 Cordis 的 `ctx` proxy 会把这个属性解析成 `connection.authentication` 服务。插件没 inject 这个服务时，属性访问抛：

```
cannot get property "connection.authentication" without inject
```

于是 `admit` 每次都抛异常，被 fail-closed 成 403 —— 补丁等于没打，而且症状和没打补丁时一模一样（都是 403），很难看出来。

这个坑**只能在真实 DSH 进程里暴露**，进程内模拟（直接构造 connection 对象）测不出来。测试里有一条静态断言守着它。

## 验证记录

在真实 DSH **0.2.3-alpha.2** 进程里端到端验证过（临时 `DSH_HOME`，独立 profile，未触碰任何真实 profile）：

| 用例 | 结果 | 期望 |
|---|---|---|
| 回环 + 回环 cookie | 200 | 200 |
| 宿主信任的权威 + 对应 cookie | **200** | 200 |
| 伪造 Host + 有效 cookie | 403 | 403 |
| 宿主信任的权威 + 无 cookie | 401 | 401 |
| `Sec-Fetch-Site: cross-site` | 403 | 403 |
| 跨源 Origin | 403 | 403 |
| POST 回环（写配置） | 非 403 | 非 403 |
| POST 宿主信任的权威（写配置） | 403 | 403 |

补丁前，第二行是 **403**（就是 issue #277）；补丁后是 200。启动日志里那条 `宿主信任栅栏不可用` 的 warn 也消失了。

### 第五~八处的端到端验证

同一进程（DSH 0.2.3-alpha.2，`DSH_HOME=/tmp/final-home`，profile `verify`，端口 31799，`--trusted-host harness.internal:31799`）。插件用**新版 `patch.mjs` 从上游原版重新打**，结果与上游修复版逐字节相同（`sha256` 一致）后才起服务。

| 用例 | 结果 | 期望 |
|---|---|---|
| `GET sound/press.mp3?set=__proto__` | 200，`audio/mpeg` | 200 |
| `?set=constructor` / `toString` / `valueOf` / `hasOwnProperty` | 200，`audio/mpeg` | 200 |
| `?set=duck` / `fx1`（不回归） | 200，`audio/mpeg` | 200 |
| `GET role-pin.json` | **405** + `Allow: POST, PUT` | 405 |
| `GET role-delete.json` | **405** | 405 |
| `GET bubble-img-upload.json` | **405** | 405 |
| `POST role-pin.json`（真实 role id） | 200 | 非 405 |
| `PUT role-pin.json` | 200 | 非 405 |
| `GET roles.json` / `audio.json` / `bubble.json` / `bubble-imgs.json` | 200 | 200（未被误伤） |
| 600KB body → `bubble.json`（512KB 上限） | **413**，`{"ok":false,"error":"body too large"}`，curl exit=0 | 413 |
| 小 body → `bubble.json` | 200 | 200 |
| 413 后同连接再发一次 | 413（连接可复用） | 不崩 |
| `balance.json` 的 `peakHolidays` | 62 条（2026 33 + 2027 29） | 含 29 条 2027 |
| `balance.json` 的 `peakHolidaysCoveredThrough` | `'2027-12-31'` | 已下发 |
| 写坏 `.dshw-bubble.json` → GET `bubble.json` | `{"ok":true,"config":null}` + 生成 `.corrupt-*.bak` | 备份生成 |
| 回环 + 回环 cookie | 200 | 200 |
| 信任权威 `harness.internal:31799` + 对应 cookie | **200** | 200 |
| 信任权威 + 回环 cookie（权威不匹配） | 401 | 401 |
| 伪造 Host + 信任权威的 cookie | 403 | 403 |
| 信任权威 + 无 cookie | 401 | 401 |
| `Sec-Fetch-Site: cross-site` | 403 | 403 |
| 跨源 Origin | 403 | 403 |

服务端日志里出现第八处的运行时证据：

```
[whale-bubble] 配置文件损坏（bad-json）→ 已备份为 /tmp/final-home/.dshw-bubble.json.corrupt-1795582333903.bak，并用默认结构重建（原文件未删除）
```

## 已知限制

- 只在 **DSH 0.2.3-alpha.2** 上端到端验证过。0.2.2-rc.2 到 0.2.3-alpha.2 之间的版本没有逐个验证。
- 补丁按上游 0.4.2 的代码逐字节匹配 30 个锚点。上游一旦改动其中任何一处，脚本会失败退出而不是猜位置 —— 这是有意的，但意味着上游发新版后需要人工更新锚点。
- 半打补丁（24 处只命中一部分）会被显式拒绝，并逐处报告哪一处没打上，不会静默写坏文件。
- 只处理 `lib/index.js`。如果上游把栅栏逻辑挪到别的文件，补丁不适用。
- 写请求（POST/PUT/PATCH/DELETE）仍然只允许回环来源，这是上游 0.3.15 起的既有策略（`writeRejection`），本补丁没有放宽。远端管理仍需 `DSHW_ADMIN_HOSTS`。

## 参考

同一问题的其他实现，用来对照逻辑：

- [`roost-qq/dsh-roost` 的 `src/fence.js`](https://raw.githubusercontent.com/roost-qq/dsh-roost/main/src/fence.js) —— 最完整，处理了 `admit` 返回 `undefined` 要回退、`peer.principal.kind` 缺席要放行；
- [`AaronWu77/dsh-remote-ssh` 的 `src/web.ts`](https://raw.githubusercontent.com/AaronWu77/dsh-remote-ssh/main/src/web.ts) —— 简洁的双 API 分派；
- [`iasiv5/dsh-stock-kanban` issue #1](https://github.com/iasiv5/dsh-stock-kanban/issues/1) —— 别的插件遇到同一 API 迁移，硬 fail-closed 导致全路由 403。
