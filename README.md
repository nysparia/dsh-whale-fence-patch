# dsh-whale-fence-patch

> **社区补丁，非上游官方。** 上游 `dsh-whale-widget` 自 0.4.2（2026-10-11）起没有新版本，本仓库是第三方临时方案。上游修复后请卸载。

给已安装的 [`dsh-whale-widget`](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget) 打两个上游 bug 的补丁：

1. **信任栅栏兼容**（约 30 行）—— 让它在 DSH 0.2.2-rc.2 及以上版本上正常工作；
2. **音效路由的原型链查表崩溃**（约 13 行）—— `?set=__proto__` 之类的键名会让路由返回 400。这是**与栅栏无关的第二个 bug**，在旧版 DSH 上同样存在。

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

## 安装

```bash
node patch.mjs --profile web
```

`web` 换成你实际使用的 profile 名。脚本会：

1. 定位 `~/.dsh/profiles/web/node_modules/dsh-whale-widget`；
2. 读 `package.json` 打印版本号；
3. 逐字节匹配上游 0.4.2 的四段目标代码，找不到就**失败退出**（不猜位置）；
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

全部通过时退出 0。共 20 个测试。

## 许可与素材声明

- **本仓库不包含上游的任何代码或素材。** 仓库里只有 `patch.mjs`、`test/fence.test.mjs`、文档和许可文件。补丁以字符串常量的形式描述"把哪两段改成什么"，不复制上游文件。
- 上游 `dsh-whale-widget` 的**代码**（`lib/`、`cordis.patch.yml`、`package.json`、文档）是 MIT。
- 上游的 **`assets/**`（约 6.6MB 图片 / 动图 / 音效）和 `icon.png` 不在 MIT 覆盖范围内**。上游 `PROVENANCE.md` 写明它们"仅授权随本插件运行使用，不授予再许可"。因此本仓库不重新分发它们 —— 补丁只改用户已安装副本里的 `lib/index.js`，素材仍由那份副本提供。
- 本补丁只改 `lib/index.js`，共四处锚点：栅栏两处（净增 24 行）、inject 列表一处、音效查表一处（净增 13 行）。

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

## 已知限制

- 只在 **DSH 0.2.3-alpha.2** 上端到端验证过。0.2.2-rc.2 到 0.2.3-alpha.2 之间的版本没有逐个验证。
- 补丁按上游 0.4.2 的代码逐字节匹配四处锚点。上游一旦改动其中任何一处，脚本会失败退出而不是猜位置 —— 这是有意的，但意味着上游发新版后需要人工更新锚点。
- 半打补丁（四处只命中一部分）会被显式拒绝，并逐处报告哪一处没打上，不会静默写坏文件。
- 只处理 `lib/index.js`。如果上游把栅栏逻辑挪到别的文件，补丁不适用。
- 写请求（POST/PUT/PATCH/DELETE）仍然只允许回环来源，这是上游 0.3.15 起的既有策略（`writeRejection`），本补丁没有放宽。远端管理仍需 `DSHW_ADMIN_HOSTS`。

## 参考

同一问题的其他实现，用来对照逻辑：

- [`roost-qq/dsh-roost` 的 `src/fence.js`](https://raw.githubusercontent.com/roost-qq/dsh-roost/main/src/fence.js) —— 最完整，处理了 `admit` 返回 `undefined` 要回退、`peer.principal.kind` 缺席要放行；
- [`AaronWu77/dsh-remote-ssh` 的 `src/web.ts`](https://raw.githubusercontent.com/AaronWu77/dsh-remote-ssh/main/src/web.ts) —— 简洁的双 API 分派；
- [`iasiv5/dsh-stock-kanban` issue #1](https://github.com/iasiv5/dsh-stock-kanban/issues/1) —— 别的插件遇到同一 API 迁移，硬 fail-closed 导致全路由 403。
