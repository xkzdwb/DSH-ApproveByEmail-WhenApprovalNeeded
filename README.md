# DSH-ApproveByEmail-WhenApprovalNeeded

给 DSH 加一条**邮件审批通道**：当 DSH 需要你批准一个敏感操作（比如提权执行命令、写工作区外的文件）时，
插件给你指定的邮箱**发一封邮件**，你**直接回复那封邮件**（回「同意」或「拒绝」）就能决定放行还是驳回。

界面上的审批弹窗照旧存在 —— **两条路并行抢答，谁先回按谁算**。

- 给 DSH 用：插件挂在 `approval/request` 瀑布的最外层，是**应答者**（answerer），不是工具。
- 自己用：`node tools/probe-mail.mjs --send --watch 300` 一条命令验证整条链路。
- **零依赖**：SMTP / IMAP / MIME 全是自己写的，只用 Node 内置模块。

适用场景：你不在电脑前，但手机上收到邮件就能放行；或者你想把「谁批准了什么」留一份邮件记录。

> ⚠️ 这会开一条**远程放行通道**：邮箱被人拿到 = 本机操作被放行。上线前请务必读第 6 节。

---

## 1. 它做什么、不做什么

| 做 | 不做 |
|---|---|
| 有审批请求时发通知邮件（含工具名、请求原因、会话、一次性令牌） | 不改任何工具的执行权限 |
| 轮询收件箱，认出「是你对某次请求的回复」并解析成同意 / 拒绝 | 不注册任何给模型用的工具，模型看不见它 |
| 与界面弹窗并行抢答，先到先得 | 不写入审批策略（`ask` / `never` 仍由 DSH 自己管） |
| 每次请求与结论写本地审计 JSONL | 不碰会话日志里的 `approval/asked` / `approval/decided` |

用的是 DSH 自己的审批接口（`@deepseek-ai/dsh-user-approval` 暴露的 `approval/request` 瀑布事件），
不是绕过它 —— 所以界面弹窗、审计、策略全都照常工作。

## 2. 工作原理

```
模型触发需要审批的操作
  └─ ctx.approval.request()            ← DSH 的审批服务（只在 turn 内有效）
       └─ waterfall('approval/request') 监听顺序：
            ① 本插件（prepend，最外层）
                 ├─ 立刻 next() ────────────→ ② 浏览器弹窗（dsh-api-remotes 转发）
                 │                                你点「授予权限」→ allowed-once
                 └─ 发通知邮件 + 轮询收件箱
                      你回复「同意 #令牌」→ allowed-once
                      你回复「拒绝 #令牌」→ rejected
            ③ 兜底：unavailable（fail-closed，绝不误放行）
```

**为什么必须 `prepend`**：桌面端已经有一个「最终应答者」——浏览器弹窗，它会把请求整个吃掉。
不抢在最外层，邮件就永远发不出去。这是本插件唯一需要「抢先」的地方。

**结论词表**（DSH 只认这四个）：`allowed-once`（唯一的放行）｜`rejected`｜`cancelled`｜`unavailable`。

## 3. 装进 DSH

1. 把仓库放到本机任意位置（下面的 `/absolute/path/to/...` 换成真实绝对路径，Windows 用正斜杠更稳）。
2. 复制授权码文件：

```bash
cp secrets.example.json secrets.json
```

3. 按 [examples/cordis.patch.snippet.yml](examples/cordis.patch.snippet.yml) 往
   `~/.dsh/profiles/<profile>/cordis.patch.yml` 的 `insert` 列表里加一项：

```yaml
    - id: approval-email
      name: "/absolute/path/to/DSH-ApproveByEmail-WhenApprovalNeeded/src/plugin.js"
      config:
        address: sender@example.com          # 发信 + 收回复的邮箱账号
        to: approver@example.com             # 收通知的邮箱（回复会回到 address）
        allowFrom:                           # 谁有资格审批（默认只认 address）
          - approver@example.com
        secretsFile: "/absolute/path/to/DSH-ApproveByEmail-WhenApprovalNeeded/secrets.json"
        pollIntervalMs: 5000
        waitMs: 0                            # 0 = 永不超时，一直等回复
```

装在 **profile 级**，所以任意工作区的会话都生效。

4. **重启 DSH**（插件在 HOST 启动时装载）。重启后 HOST 日志里会出现：

```
[approval-email] 已挂载：sender@example.com（SMTP smtp.163.com:465，IMAP imap.163.com:993，轮询 5000ms，永不超时）
```

> 想「用 A 账号发给 B 邮箱、B 回复来审批」？就按上面的写法：`address` = A（发信 + 收回复），
> `to` = B（收通知），`allowFrom` = B（有资格审批的人）。回复会回到 A 的收件箱，也就是插件轮询的那个。

## 4. 配置项

| 字段 | 默认 | 说明 |
|---|---|---|
| `address` | 必填 | 发信 + 收回复的邮箱账号（IMAP 轮询它的收件箱） |
| `to` | = `address` | 通知寄给谁；「用 A 发给 B」时写 B |
| `allowFrom` | `[]` | **谁有资格审批**；默认只认 `address` |
| `secretsFile` | — | 放授权码的 JSON（`{"authCode":"..."}`）；也可直接写 `authCode` |
| `authCode` | — | 邮箱的**应用专用密码 / 授权码**，不是登录密码 |
| `user` | `address` | 登录名，一般就是邮箱地址 |
| `displayName` | `DSH 审批` | 发件人显示名 |
| `subjectPrefix` | `[DSH 审批]` | 主题前缀 |
| `smtp` | `smtp.163.com:465 TLS` | `{ host, port, secure, starttls }` |
| `imap` | `imap.163.com:993 TLS` | `{ host, port, secure, mailbox }` |
| `pollIntervalMs` | `5000` | 收件箱轮询间隔 |
| `waitMs` | `0` | `0` = 永不超时 |
| `notifyOnly` | `false` | `true` = 只发通知，回复不作为放行依据 |
| `confirmByEmail` | `false` | 结论落地后再回一封「已处理」 |
| `allowFrom` | `[]` | 额外允许的发件人 |
| `auditFile` | 仓库内 `audit/audit.jsonl` | 本地审计账本 |
| `timeZone` | `Asia/Shanghai` | 邮件里展示时间的时区 |

默认值是按 **163 邮箱**写的（含 163 登录后必须发的 IMAP `ID` 命令）。换别的邮箱改 `smtp` / `imap` 即可。

## 5. 邮件长什么样、怎么回

主题：`[DSH 审批] #a1b2c3d4 需要你批准：bash`

正文（纯文本 + HTML 双份）：

```
DSH 需要你批准一次操作。

令牌：#a1b2c3d4
工具：bash
原因：escalate sandbox to danger-full-access: ...
会话：session-xxxx
工作区：/path/to/workspace
时间：2026-11-05 16:06:23

【直接回复本邮件即可决定】
批准：回复正文写「同意 #a1b2c3d4」
拒绝：回复正文写「拒绝 #a1b2c3d4」
```

回复规则：

| 你的回复 | 结果 |
|---|---|
| 正文含「同意 / 批准 / 通过 / 允许 / 放行 / approve / yes / ok」**且**带令牌 | `allowed-once` |
| 正文含「拒绝 / 驳回 / 不同意 / deny / no」**且**带令牌 | `rejected` |
| 只写「同意」，令牌在主题里 | 也认（主题带 `Re:` / `回复：` 等前缀即可） |
| 只有引用原文、没说结论 | 忽略，继续等 |
| 既说同意又说拒绝 | 忽略，继续等（宁可等你重发，也不误放行） |
| 没令牌 / 令牌过期 / 发件人不在白名单 / 不像回复 | 忽略 |

判定**只看你新写的那几句**：引用区会被砍掉，所以通知模板里印的「同意 #令牌 / 拒绝 #令牌」两个示例
不会被当成你的意思。

## 6. 安全边界（务必读）

1. **只认白名单发件人**：`address` + `allowFrom`，其它地址的邮件一律忽略。
2. **一次性令牌**：每个请求随机生成，结论落地即失效，迟到的回复无人认领。
3. **不是回复就不认**：必须带 `In-Reply-To` / `References`，或主题有 `Re:` / `回复：` 前缀；
   插件自己发出的通知带 `X-DSH-Approval: notify`，被投回同一收件箱也不会被误当成回复。
4. **fail-closed**：邮件没回、读不懂、发信失败 —— 都不会放行。发信失败时该请求自动退回界面审批。
5. **审计**：`audit/audit.jsonl` 记录 `asked / decided / unreadable / notify-failed / settled`。
6. **这是远程放行通道**：邮箱被盗 = 本机被放行。请给该邮箱开二次验证、单独使用；
   `secrets.json` 与 `audit/` 已在 `.gitignore` 里，**永远不要提交**。
7. 授权码只经 `secrets.json` 传给插件；日志里只出现掩码。

## 7. 验证

```bash
npm test          # 离线回归：39 项，不联网、不需要邮箱账号
```

覆盖 MIME 编解码（RFC 2047 / base64 / quoted-printable / multipart / HTML→文本 / 引用隔离）、
回复判定（同意、拒绝、「不同意」、双结论、令牌不符、只在主题里写结论）、配置校验、
假 SMTP 发信、假 IMAP 增量收信与水位线兜底，以及四条端到端用例：
邮件先到 → `allowed-once`、界面先点 → 界面结论说了算、发信失败不误放行、仅通知模式。

真机验证（163 邮箱，两个账号：A 发信、B 审批回复）：

```
[SMTP] 已投递（637ms）   主题：[DSH 审批] #40c10f69 需要你批准：probe-mail
[IMAP] 登录并选中收件箱成功
       收到候选回复 UID …：令牌 40c10f69／结论 allow
收到你的回复：同意（会被放行）
```

装进 DSH 后跑真实审批（审批人**只回邮件、没点界面弹窗**），命令随即执行成功；插件审计留下：

```json
{"kind":"asked",  "token":"…","tool":"pwsh","reason":"escalate sandbox to danger-full-access: …"}
{"kind":"decided","token":"…","decision":"allow","outcome":"allowed-once","source":"email"}
{"kind":"settled","token":"…","outcome":"allowed-once","source":"race"}
```

`source":"email"` 说明放行确实来自邮件回复，界面那条路一次都没用上。

## 8. 真机踩过的坑（都已修，欢迎照着避）

1. **邮箱服务商不返回 `UIDNEXT`**（163 实测：`SELECT` 没有 `[UIDNEXT n]`，`STATUS` 只回 `MESSAGES`）。
   只按 `UIDNEXT-1` 取水位线会退化成 0，等于每次重扫全邮箱。现在三级兜底：
   `SELECT 的 UIDNEXT → STATUS 的 UIDNEXT → UID SEARCH ALL 取现有最大 UID`。
2. **主题里的令牌被空格切开**：163 把长主题切成两个 RFC2047 编码词，中间的空白按 RFC 2047 §6.2 必须丢掉，
   否则收到的是 `#40c10f 69`，谁都认不出来。注意「编码词 + 地址」之间那个空格则必须保留。
3. **引用区标记五花八门**：163 用 `---- 回复的原邮件 ----` 外加一张管道表格，不在常见的
   「原始邮件 / Original Message」名单里。漏掉它，引用模板里的「批准 → 写「同意 #令牌」」会被当成你的意思，
   于是**一封「拒绝」会变成「既同意又拒绝」而静默失效**。
4. **163 登录后必须先发 IMAP `ID` 命令**，否则后续命令报 `Unsafe Login`。
5. **收费/企业邮箱多半要「应用专用密码」**，用登录密码会得到 `535 authentication failed`；
   顺带一提，账号名打错一个字母的报错和密码错一模一样。

## 9. 已知限制

1. **邮件里没有具体命令与参数** —— DSH 审批接口只外传工具名、原因与调用 id（硬限制）。
2. **只在 turn 内有效**：回复太晚（turn 已中止）时该回复作废，会话侧按 `cancelled` 处理。
3. **只有一次性放行**：DSH 没有「永久允许 / 记住规则」。
4. **邮件先到时界面弹窗不会自动消失**：它的答复会被丢弃（既有 UI 行为）。
5. **需要重启 DSH** 才加载。
6. 收件箱是**增量**读的：插件启动/首次请求之前的旧邮件一概不看。

## 10. 文件

| 文件 | 作用 |
|---|---|
| [src/plugin.js](src/plugin.js) | cordis 入口：读配置、prepend 挂载、卸载时收尾 |
| [src/answerer.mjs](src/answerer.mjs) | 核心：与界面抢答、令牌待办表、轮询生命周期、审计 |
| [src/config.mjs](src/config.mjs) | 配置归一化（含 secrets 文件） |
| [src/notify.mjs](src/notify.mjs) | 通知邮件文案（纯文本 + HTML） |
| [src/decision.mjs](src/decision.mjs) | 两道筛子：只看 header → 解正文出结论 |
| [src/token.mjs](src/token.mjs) | 一次性令牌生成与抽取 |
| [src/mime.mjs](src/mime.mjs) | MIME 编解码（RFC2047 / base64 / QP / multipart / HTML→文本 / 引用隔离） |
| [src/mail-smtp.mjs](src/mail-smtp.mjs) | 零依赖 SMTP（隐式 TLS / STARTTLS / AUTH LOGIN→PLAIN） |
| [src/mail-imap.mjs](src/mail-imap.mjs) | 零依赖 IMAP（`ID` 命令、UID 水位线、断线重连、`BODY.PEEK` 不改已读） |
| [src/socket.mjs](src/socket.mjs) | 共用的 TCP/TLS 行读取器（按字节，字面量安全） |
| [test/run-tests.mjs](test/run-tests.mjs) | 39 项离线回归 |
| [test/servers.mjs](test/servers.mjs) | 假 SMTP / 假 IMAP 服务端 |
| [tools/probe-mail.mjs](tools/probe-mail.mjs) | 真实邮箱连通性诊断 |
| [examples/cordis.patch.snippet.yml](examples/cordis.patch.snippet.yml) | 装配片段 |
| `secrets.example.json` | 授权码模板（复制成 `secrets.json` 再填） |

## 11. 许可

MIT，见 [LICENSE](LICENSE)。
