// 连通性诊断：直接和邮箱服务商的 SMTP / IMAP 对话，不经过 DSH。
// 用法（在仓库根目录下）：
//   node tools/probe-mail.mjs --send                  只发一封测试通知
//   node tools/probe-mail.mjs --watch 300             只收信，盯 5 分钟
//   node tools/probe-mail.mjs --send --watch 300      发完等你的回复（推荐：一次验证全链路）
//   node tools/probe-mail.mjs --imap-only             只验 IMAP 登录
//
// 邮箱与地址从这三个地方取，优先级从高到低：
//   --address / --to / --allow-from 命令行参数
//   secrets.json 里的 address / to / allowFrom 字段
//
// 退出码：0 成功 / 2 SMTP 失败 / 3 IMAP 失败 / 4 没等到回复 / 5 参数或配置有问题
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readSettings } from '../src/config.mjs'
import { sendMail } from '../src/mail-smtp.mjs'
import { MailboxWatcher } from '../src/mail-imap.mjs'
import { buildNotification } from '../src/notify.mjs'
import { screenHeaders, readDecision } from '../src/decision.mjs'
import { newToken } from '../src/token.mjs'
import { newMessageId } from '../src/mime.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const secretsFile = join(here, '..', 'secrets.json')

function argValue(flag, fallback = undefined) {
  const index = process.argv.indexOf(flag)
  return index >= 0 && process.argv[index + 1] !== undefined && !process.argv[index + 1].startsWith('--')
    ? process.argv[index + 1]
    : fallback
}

const wantsSend = process.argv.includes('--send')
const wantsImapOnly = process.argv.includes('--imap-only')
const wantsSmtpOnly = process.argv.includes('--smtp-only')
const watchSeconds = Number(argValue('--watch', '0'))
const token = String(argValue('--token', newToken()))

const say = (message) => console.log(message)
const mask = (text) => `${String(text).slice(0, 2)}****${String(text).slice(-2)}`

/** secrets.json 里的 address / to / allowFrom 可以当默认值用。 */
let secrets = {}
try {
  secrets = JSON.parse(readFileSync(secretsFile, 'utf8'))
} catch {
  /* 没有 secrets 文件就只认命令行参数 */
}

const address = argValue('--address', secrets.address ?? '')
const to = argValue('--to', secrets.to ?? address)
const allowFrom = argValue('--allow-from', secrets.allowFrom ?? address)

if (address === '') {
  say('没给发信邮箱。用 --address 指定，或把它写进 secrets.json 的 address 字段（可参考 secrets.example.json）。')
  process.exit(5)
}

let settings
try {
  settings = readSettings({ address, to, allowFrom: [allowFrom], secretsFile, pollIntervalMs: 3000 })
} catch (error) {
  say(`配置有问题：${error?.message ?? error}`)
  process.exit(5)
}

say(`邮箱：${settings.address} → ${settings.to}（授权码 ${mask(settings.authCode)}）`)
say(`SMTP ${settings.smtp.host}:${settings.smtp.port}${settings.smtp.secure ? ' (TLS)' : ''}｜IMAP ${settings.imap.host}:${settings.imap.port}${settings.imap.secure ? ' (TLS)' : ''}`)

if (!wantsImapOnly && !wantsSmtpOnly && !wantsSend && watchSeconds === 0) {
  say('什么都没让做。用 --send 发一封，或 --watch <秒> 收信。')
  process.exit(5)
}

if (wantsSend || wantsSmtpOnly) {
  const { subject, text, html } = buildNotification({
    settings,
    token,
    req: {
      toolName: 'probe-mail',
      reason: '连通性测试（不是真的审批请求）',
      callId: 'probe',
      agent: { id: 'probe', session: { id: 'probe', header: { cwd: process.cwd() } } },
    },
  })
  say(`\n[SMTP] 正在发测试邮件，令牌 #${token} …`)
  const started = Date.now()
  try {
    await sendMail({
      ...settings.smtp,
      user: settings.user,
      pass: settings.authCode,
      from: settings.address,
      fromName: settings.displayName,
      to: settings.to,
      subject,
      text,
      html,
      messageId: newMessageId(settings.address.split('@')[1] ?? 'localhost'),
      extraHeaders: { 'X-DSH-Approval': 'notify', 'X-DSH-Approval-Token': token },
      log: (message) => say(`       · ${message}`),
    })
    say(`[SMTP] 已投递（${Date.now() - started}ms）`)
    say(`       主题：${subject}`)
  } catch (error) {
    say(`[SMTP] 失败：${error?.message ?? error}`)
    if (wantsSmtpOnly) process.exit(2)
  }
}

if (wantsImapOnly || watchSeconds > 0) {
  say(`\n[IMAP] 连接 ${settings.imap.host}:${settings.imap.port} …`)
  const watcher = new MailboxWatcher({
    ...settings.imap,
    user: settings.user,
    authCode: settings.authCode,
    log: (message) => say(`       · ${message}`),
  })

  // 先空跑一次，确认登录/SELECT 都通（有的服务商还要求登录后先发 ID 命令）。
  try {
    await watcher.poll({ filter: () => false })
    say('[IMAP] 登录并选中收件箱成功')
  } catch (error) {
    say(`[IMAP] 失败：${error?.message ?? error}`)
    await watcher.close()
    process.exit(3)
  }

  if (wantsImapOnly) {
    await watcher.close()
    say('\nIMAP 正常。')
    process.exit(0)
  }

  say(`[IMAP] 开始盯收件箱 ${watchSeconds} 秒，等你回复令牌 #${token} 的邮件…`)
  const deadline = Date.now() + watchSeconds * 1000
  let decided = null
  try {
    while (Date.now() < deadline) {
      const messages = await watcher.poll({
        filter: (headerText) => screenHeaders(headerText, { address: settings.address, allowFrom: settings.allowFrom }) !== null,
      })
      for (const message of messages) {
        const result = readDecision({ headerText: message.headerText, bodyText: message.bodyText, tokens: [token] })
        say(`       收到候选回复 UID ${message.uid}：令牌 ${result.token ?? '对不上'}／结论 ${result.decision ?? '说不清'}${result.note ? `（${result.note}）` : ''}`)
        if (result.token === token && result.decision !== null) decided = result.decision
      }
      if (decided !== null) break
      await new Promise((resolve) => setTimeout(resolve, settings.pollIntervalMs))
    }
  } catch (error) {
    say(`[IMAP] 轮询出错：${error?.message ?? error}`)
    await watcher.close()
    process.exit(3)
  }
  await watcher.close()

  if (decided === null) {
    say(`\n没在 ${watchSeconds} 秒内等到有效回复。若你确实回了，把上面的候选行发我。`)
    process.exit(4)
  }
  say(`\n收到你的回复：${decided === 'allow' ? '同意（会被放行）' : '拒绝（会被驳回）'}`)
  say('全链路正常：发信 + 收信 + 认令牌 + 判定都对。')
  process.exit(0)
}

say('\n仅发信完成。')
process.exit(0)
