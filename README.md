# DSH-ApproveByEmail-WhenApprovalNeeded

给 DSH 加两条**邮件通道**，都用同一个邮箱、同一套令牌机制：

- **审批**（`approval/request`）：需要你批准敏感操作时发邮件，回「同意 / 拒绝」即可放行或驳回。
- **提问**（`user-questions/request`）：AI 给出选项让你选时也发邮件，回「1. 2」这样的行就能作答。

- 给 DSH 用：插件挂在两个瀑布的最外层，是**应答者**而不是工具。
- 自己用：`node tools/probe-mail.mjs --send --watch 300` 一条命令验证整条链路。

---

## 1. 它做什么、不做什么

| 做 | 不做 |
|---|---|
| 有审批请求时发通知邮件（含工具名、请求原因、会话、令牌） | 不改任何工具的执行权限 |
| 轮询收件箱，认出「是你对某次请求的回复」并解析成同意 / 拒绝 | 不注册任何给模型用的工具，模型看不见它 |
| 默认是唯一通道：发邮件、等你回复（`showApprovalCard` / `showQuestionCard` 可把界面卡也打开） | 不写入审批策略（`ask` / `never` 还是 DSH 自己管） |
| 每次请求与结论写本地审计 JSONL | 不碰会话日志里的 `approval/asked` / `approval/decided` |

用的是 DSH 自己的审批接口（`@deepseek-ai/dsh-user-approval` 的 `approval/request` 瀑布事件），
不是绕过它——所以界面弹窗、审计、策略全都照常。

## 2. 工作原理

```
模型触发需要审批的操作
  └─ ctx.approval.request()            ← DSH 的审批服务（turn 内才有效）
       └─ waterfall('approval/request') 监听顺序：
            ① 本插件（prepend，最外层）
                 ├─ 发通知邮件 + 轮询收件箱
                 │     你回复「同意 #令牌」→ allowed-once
                 │     你回复「拒绝 #令牌」→ rejected
                 └─ 默认到此为止（不弹卡）
                    showApprovalCard: true 时才 next() ──→ ② 浏览器弹窗
            ③ 兜底：unavailable（fail-closed）
```

**为什么必须 `prepend`**：桌面端已经有浏览器弹窗这个「最终应答者」，它会把请求整个吃掉。
不抢在最外层，邮件就永远发不出去。这也是本插件唯一需要「抢先」的地方。

**结论词表**（DSH 只认这四个）：`allowed-once`（唯一的放行）｜`rejected`｜`cancelled`｜`unavailable`。

### 提问通道

```
模型调用 ask_user_question
  └─ ctx.userQuestions.ask()           ← 只在 turn 内有效
       └─ waterfall('user-questions/request')：
            ① 本插件（prepend）
                 ├─ 发提问邮件 + 轮询收件箱
                 │     你回「1. 2」→ 返回 { answers: [{ id, selected: ['B 方案'] }] }
                 └─ 默认到此为止（不弹卡）
                    showQuestionCard: true 时才 next() ──→ ② 浏览器选项卡
            ③ 兜底：没有应答者 → 整个提问失败（fail-closed）
```

**为什么提问也默认不弹卡（实测推翻了「投影会收卡」的说法）**：
我一开始以为选项卡跟着会话投影走、邮件答完会自动消失 —— **真机上是错的**。源码确认了两层原因：

1. 投影只跟踪 **timed** 版 `ask_user_question`（schema 里带 `timeout`）。本机部署是阻塞式旧版
   schema（顶层只有 `questions`），`tool/call` 那步就被 `if (!fold.timed) return fold` 跳过，
   这道题从未进过投影的 `active`。
2. 更关键的是客户端 `reconcile` 的删除条件：

   ```js
   for (const card of cards.values()) {
     if (card.pending.callId === void 0 || card.pending.review !== void 0 || rows.has(card.pending.key)
         || card.hasRequest() || card.pending.hasWaterfall()) continue;   // 有活着的请求就永不删
     card.remove();
   }
   ```

   只要卡片背后还挂着那条**转发过来的请求**（`hasRequest()` / `hasWaterfall()`），就永远不删，
   投影怎么写都没用；而那条请求只有「用户自己点」或「客户端自己作答」才会结束。

结论：**卡片一旦弹出，Host 侧没有任何办法撤回**（审批卡、提问卡都一样）。
所以插件默认不转发、不弹卡，让邮件成为唯一通道 —— 没有卡，也就没有关不掉的卡。
代价是界面上不再出现选项按钮/审批按钮；要恢复就把 `showQuestionCard` / `showApprovalCard` 打开。

## 3. 装进 DSH

> 发布版用占位符：把 `/path/to/...` 换成真实绝对路径，`sender@example.com` / `approver@example.com` 换成你的邮箱。
> 授权码写在 `secrets.json`（由 `secrets.example.json` 复制），它已在 `.gitignore` 里。

`~/.dsh/profiles/desktop/cordis.patch.yml` 的 `insert` 列表里加一项（完整片段见
[examples/cordis.patch.snippet.yml](examples/cordis.patch.snippet.yml)）：

```yaml
    - id: approval-email
      name: "/path/to/DSH-ApproveByEmail-WhenApprovalNeeded/src/plugin.js"
      config:
        address: sender@example.com          # 发信 + 收回复的邮箱账号
        to: approver@example.com             # 收通知的邮箱（回复会回到 address）
        allowFrom:                         # 谁有资格审批（默认只认 address）
          - approver@example.com
        secretsFile: "/path/to/DSH-ApproveByEmail-WhenApprovalNeeded/secrets.json"
        pollIntervalMs: 5000
        waitMs: 0
        # 界面卡片默认都不弹（弹了邮件答完也收不掉）；想让界面也能点就打开下面两项，
        # 代价是邮件答完后卡片留在屏幕上，需要你点一下。
        showApprovalCard: false
        showQuestionCard: false
```

装成 profile 级（全局），所以**任意工作区**的会话都生效；插件文件本身放在
`/path/to/DSH-ApproveByEmail-WhenApprovalNeeded\`。

**改完必须重启 DSH**（插件在 HOST 启动时装载）。重启后 HOST 日志里会出现：

```
[approval-email] 已挂载：sender@example.com（SMTP smtp.163.com:465，IMAP imap.163.com:993，轮询 5000ms，永不超时）
```

## 4. 配置项

| 字段 | 默认 | 说明 |
|---|---|---|
| `address` | 必填 | 发信 + 收回复的邮箱账号（IMAP 轮询它的收件箱） |
| `to` | = `address` | 通知寄给谁；「用 A 发给 B」时写 B |
| `allowFrom` | `[]` | **谁有资格审批**；默认只认 `address`，上面的用法里要写 B |
| `secretsFile` | — | 放授权码的 JSON（`{"authCode":"..."}`）；也可直接写 `authCode` |
| `authCode` | — | 163 的**客户端授权码**，不是登录密码 |
| `user` | `address` | 登录名，一般就是邮箱地址 |
| `displayName` | `DSH 审批` | 发件人显示名 |
| `subjectPrefix` | `[DSH 审批]` | 审批邮件的主题前缀 |
| `questionSubjectPrefix` | `[DSH 提问]` | 提问邮件的主题前缀 |
| `showApprovalCard` | `false` | 审批是否同时在界面弹卡。默认关：审批卡弹出后 Host 侧没有关闭通道，邮件批完会一直留在屏幕上。设成 `true` 就是旧的「并行抢答」（卡片可能残留） |
| `showQuestionCard` | `false` | 提问是否同时在界面弹选项卡。默认关，理由同上（源码已确认：卡片背后挂着转发请求时永不删除）。设成 `true` 恢复界面选项按钮，但邮件答完卡片会留着 |
| `smtp` | `smtp.163.com:465 TLS` | `{ host, port, secure, starttls }` |
| `imap` | `imap.163.com:993 TLS` | `{ host, port, secure, mailbox }` |
| `pollIntervalMs` | `5000` | 收件箱轮询间隔 |
| `waitMs` | `0` | **0 = 永不超时**（按你的要求持续等待） |
| `notifyOnly` | `false` | `true` = 只发通知，回复不作为放行依据 |
| `confirmByEmail` | `false` | 结论落地后再回一封「已处理」（默认关，免打扰） |
| `allowFrom` | `[]` | 额外允许的发件人；默认只认 `address` |
| `auditFile` | 插件目录 `audit/audit.jsonl` | 本地审计 |
| `timeZone` | `Asia/Shanghai` | 邮件里展示时间的时区 |

### 两种工作模式

| 模式 | 配置 | 桌面 | 邮件答完后 |
|---|---|---|---|
| **A 纯邮件**（默认） | 两个开关都 `false` | 不弹卡，没有按钮 | 无卡可残留 |
| **B 桌面 + 邮件** | 两个开关都 `true` | 卡片照常出现，可点 | 卡片留在屏幕上，**点任意一项即关闭** |

B 模式里点哪一项都不改变已经记录的结果（邮件答案先到时，界面这次提交会被丢弃），
那个点击实际上只起「关闭卡片」的作用。想切到 B 就把 `showApprovalCard` / `showQuestionCard`
都设成 `true`，然后重启 DSH。

## 5. 邮件长什么样、怎么回

主题：`[DSH 审批] #a1b2c3d4 需要你批准：bash`

正文（纯文本 + HTML 双份）：

```
DSH 需要你批准一次操作。

令牌：#a1b2c3d4
工具：bash
原因：grantWrite(/path/to/...)
调用：call_abc123
会话：sess_xxx
工作区：/path/to/...
时间：2026-11-05 15:40:12

【直接回复本邮件即可决定】
批准：回复正文写「同意 #a1b2c3d4」
拒绝：回复正文写「拒绝 #a1b2c3d4」
```

回复规则：

| 你的回复 | 结果 |
|---|---|
| 正文含「同意 / 批准 / 通过 / 允许 / 放行 / approve / yes / ok」**且**带令牌 | `allowed-once` |
| 正文含「拒绝 / 驳回 / 不同意 / deny / no」**且**带令牌 | `rejected` |
| 只有引用原文、没说结论 | 忽略，继续等 |
| 既说同意又说拒绝 | 忽略，继续等（怕误放行） |
| 没令牌 / 令牌过期 / 发件人不对 / 不是回复 | 忽略 |

识别只看**你新写的那几句**（引用区会被砍掉），所以通知模板里印着的「同意 #令牌 / 拒绝 #令牌」
两个示例不会被当成你的意思。

### 提问邮件长什么样、怎么回

主题：`[DSH 提问] #a1b2c3d4 需要你选择：方案`

```
DSH 需要你做一个选择。

令牌：#a1b2c3d4

【问题 1】方案
用哪个方案？
  1) A 方案 — 改动小
  2) B 方案 — 更彻底
【问题 2】要不要顺便补测试？
  1) 要
  2) 不要

【怎么回】直接回复本邮件，每行一题：
· 单选：`1. 2` = 第 1 题选第 2 个选项
· 多选：`1. 2,3`
· 自己写：`1. 自定义：你的文字`
· 也可以直接写选项原文：`1. 选项文字`
· 不想答某题就不写它（会记为跳过）
```

| 你的回复 | 结果 |
|---|---|
| `1. 2` | 第 1 题选第 2 个选项 |
| `1. 文档, 打包`（多选题） | 两个都选 |
| `1. 自定义：先 A 后 B` | 走「自定义」答案 |
| `1. A 方案` | 按选项原文匹配 |
| 只有一道题时直接回 `2` | 也认 |
| 没写某一题 | 该题记为跳过（`selected: []`） |
| 一题都读不出来 | 忽略，继续等（界面上的卡还在） |

答完之后：工具调用结束、答案返回；因为默认不弹卡，界面上本来就没有需要收的按钮
（`showQuestionCard: true` 时卡片会留着，要你点一下才消失 —— 这就是默认关掉它的原因）。

## 6. 安全边界

1. **只认一个发件人**：`address`（可用 `allowFrom` 加白名单）。其他地址的邮件一律忽略。
2. **一次性令牌**：每个请求随机生成，结论落地即失效，迟到的回复无人认领。
3. **不是回复就不认**：必须有 `In-Reply-To` / `References`，或主题带 `Re:` / `答复：` 等前缀；
   我们自己发出去的通知带 `X-DSH-Approval: notify`，投回同一个收件箱也不会被误当成回复。
4. **fail-closed**：邮件没回、说不清、发信失败 —— 都不会放行；发信失败时该请求自动退回界面审批。
5. **审计**：`audit/audit.jsonl` 记录 `asked / decided / unreadable / notify-failed / settled`。
6. **这等于开了一条远程放行通道**：邮箱被人拿到 = 本机被放行。请给邮箱开二次验证，授权码单独保管，
   `secrets.json` 不要进任何仓库、不要发群里。
7. 授权码只写在 `secrets.json`，不进 `cordis.patch.yml`；日志里只出现掩码。

## 7. 排错

| 现象 | 原因与处理 |
|---|---|
| HOST 日志 `配置不可用，插件未挂载` | 缺 `authCode` 或 `address` 不合法；插件会安全地不挂载，界面审批照常 |
| 日志 `审批邮件发送失败（本请求改由界面审批）` | SMTP 不通（授权码错 / 网络 / 被限流）；界面照旧可用 |
| 日志 `收信失败（下轮自动重连重试）` | IMAP 断线或登录失败；插件会一直重连 |
| `SMTP … 535 Error: authentication failed` | 授权码不对，或 163 没开 SMTP/IMAP 服务 |
| `IMAP … NO LOGIN Login error or password error` | 同上（同一把授权码） |
| 邮件根本没到 | 先 `node tools/probe-mail.mjs --send`，看是发信还是收信的问题 |
| 回复了但 DSH 没反应 | `node tools/probe-mail.mjs --watch 300` 看它能不能认出你那封；认不出就把候选行发我 |

## 8. 验证状态

**离线回归：50 项全过**（`node test/run-tests.mjs`）。覆盖 MIME 编解码、
回复判定（同意 / 拒绝 / 不同意 / 引用隔离 / 令牌不符 / 双结论 / 主题判定）、
**提问的邮件渲染与答案解析（题号、选项原文、自定义、多选、跳题、答非所问）**、配置校验、
假 SMTP 发信、假 IMAP 增量收信（含 163 必需的 ID 命令、以及「服务端不给 UIDNEXT」的兜底）、
六条端到端（审批邮件先到、界面前点、发信失败不误放行、仅通知模式、**提问邮件答完返回完整答案批次**、
**审批默认不弹卡**），以及一组**照抄实测邮件**的用例（见下）。

**真机验收 ①（命令行直连，2026-11-05，sender@example.com → approver@example.com）：全链路跑通。**

```
[SMTP] 已投递（637ms）   主题：[DSH 审批] #abcd1234 需要你批准：probe-mail
[IMAP] 登录并选中收件箱成功（含 163 要求的 ID 命令）
[IMAP] 开始盯收件箱 …
       收到候选回复 UID 1624272441：令牌 abcd1234／结论 allow
收到你的回复：同意（会被放行）
```

**真机验收 ②（重启 DSH 后跑真实审批）：通过，且放行确实来自邮件。**
触发一次真实的权限升级请求（往工作区外写文件），审批人**只回邮件、没点界面弹窗**，命令随即执行成功。
插件自己的审计日志（`audit/audit.jsonl`）留下了三段 —— 这是「插件确实挂在 HOST 里」的直接证据：

```json
{"kind":"asked","token":"abcd1234","tool":"pwsh","reason":"escalate sandbox to danger-full-access: …","session":"session-8efee44d-…"}
{"kind":"decided","token":"abcd1234","uid":1624272442,"decision":"allow","outcome":"allowed-once","source":"email"}
{"kind":"settled","token":"abcd1234","outcome":"allowed-once","source":"race"}
```

`source":"email"` 是关键：请求先被本插件截住（`prepend` 生效）→ 通知邮件发出 →
60 秒后轮询到回复、令牌对上、判定 `allowed-once` → 操作随即执行，界面弹窗那条路一次都没用上。

真机暴露并修掉了三个只有真邮件才会出现的问题，每个都补了回归用例：

1. **账号名写错一位就全线 535**。`sender@example.com` 与 `sender@example.com` 只差一个 `k`，
   前者 SMTP 回 `535 authentication failed`、IMAP 回 `NO LOGIN Login error or password error`，
   而两者用的是同一把授权码 —— 所以「协议三步都走完才拒」基本就是账号名或授权码的问题。
2. **163 不返回 UIDNEXT**：`SELECT` 里没有 `[UIDNEXT n]`，`STATUS (UIDNEXT)` 也只回 `MESSAGES`。
   原来按 `UIDNEXT-1` 取水位线会退化成 0，导致重扫全邮箱。现在的三级兜底是
   `SELECT 的 UIDNEXT → STATUS 的 UIDNEXT → UID SEARCH ALL 取现有最大 UID`；
   实测水位线取到 `1624272440`（2 封历史邮件），新邮件才处理。
3. **主题里的令牌被空格切开**：163 会把长主题切成两个 RFC2047 编码词，实测收到的是
   `#40c10f 69`。按 RFC 2047 §6.2，相邻编码词之间的空白必须丢掉；改之前令牌在主题里根本认不出来
   （那一次是靠正文里的令牌兜住的）。同时也要保留「编码词 + 地址」之间那个有意义的空格，两件事都写了用例。
4. **引用区标记是「---- 回复的原邮件 ----」**（还带一张管道表格），不在原来的「原始邮件 / Original Message」
   名单里，导致引用区整段漏进「你新写的话」——于是引用模板里的
   「批准 → 写「同意 #令牌」」会被当成你的意思：**一封「拒绝」会被判成「既同意又拒绝」而不生效**。
   补上该标记后，实测同一封信的可用文本从
   `"同意 #abcd1234\n\n\n\n---- 回复的原邮件 ----"` 变成干净的 `"同意 #abcd1234"`。

## 9. 已知限制

1. **邮件里没有具体命令与参数** —— DSH 审批接口只外传工具名、原因与调用 id（硬限制）。
2. **只在 turn 内有效**：你回得太晚（turn 已被中止）时回复作废，会话侧按 `cancelled` 处理。
3. **只有一次性放行**：DSH 没有「永久允许 / 记住规则」。
4. **界面卡片关不掉**（审批卡、提问卡都一样，已用源码确认）。客户端只要还握着那条转发过来的请求，
   `reconcile` 就会跳过这张卡的删除；Host 侧没有任何撤回 API。所以两者默认都不弹卡
   （`showApprovalCard` / `showQuestionCard` 均为 `false`），邮件成为唯一通道。
   打开它们就回到「界面 + 邮件并行」，代价是邮件答完后卡片留在屏幕上，得点一下才消失。
5. **需要重启 DSH** 才加载。
6. 收件箱是**增量**读的：插件启动/首次请求之前的旧邮件一概不看（水位线取 `UIDNEXT`，
   服务端不给就退到 `UID SEARCH ALL` 的最大 UID）。
7. **限时提问（`askTimed`）**：超时后问题转为「continued」，此后答案走 Remote 的 `answer` 方法，
   本插件只负责前台那次等待；超时后回复的邮件不会自动生效。

## 10. 文件

| 文件 | 作用 |
|---|---|
| [src/plugin.js](src/plugin.js) | cordis 入口：读配置、两个瀑布各挂一个 prepend 应答者、卸载时收尾 |
| [src/answerer.mjs](src/answerer.mjs) | 核心：与界面抢答、令牌待办表、轮询生命周期、审计（审批与提问共用） |
| [src/config.mjs](src/config.mjs) | 配置归一化（含 secrets 文件） |
| [src/notify.mjs](src/notify.mjs) | 审批通知邮件文案（纯文本 + HTML） |
| [src/decision.mjs](src/decision.mjs) | 审批的两道筛子：只看 header → 解正文出结论 |
| [src/questions.mjs](src/questions.mjs) | 提问的邮件渲染（题号/选项）与回复解析（序号/原文/自定义/多选/跳题） |
| [src/token.mjs](src/token.mjs) | 一次性令牌生成与抽取 |
| [src/mime.mjs](src/mime.mjs) | MIME 编解码（RFC2047 / base64 / QP / multipart / HTML→文本 / 引用隔离） |
| [src/mail-smtp.mjs](src/mail-smtp.mjs) | 零依赖 SMTP（465 隐式 TLS / STARTTLS / AUTH LOGIN→PLAIN） |
| [src/mail-imap.mjs](src/mail-imap.mjs) | 零依赖 IMAP（含 163 必需的 ID 命令、UID 水位线、断线重连） |
| [src/socket.mjs](src/socket.mjs) | 共用的 TCP/TLS 行读取器（按字节，字面量安全） |
| [test/run-tests.mjs](test/run-tests.mjs) | 50 项离线回归 |
| [test/servers.mjs](test/servers.mjs) | 假 SMTP / 假 IMAP 服务端 |
| [tools/probe-mail.mjs](tools/probe-mail.mjs) | 真实邮箱连通性诊断 |
| [examples/cordis.patch.snippet.yml](examples/cordis.patch.snippet.yml) | 装配片段 |
| `secrets.json` | 授权码（唯一存放处，勿提交） |
