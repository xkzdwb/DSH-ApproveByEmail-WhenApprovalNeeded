// DSH 插件入口：把「邮件审批通道」挂到 approval/request 瀑布的最外层。
//
// 为什么是 prepend：桌面端已经有一个最终应答者（浏览器弹窗，经 dsh-api-remotes 转发），
// 它会把请求整个吃掉。不抢在最外层，邮件永远发不出去。
//
// 装配（~/.dsh/profiles/desktop/cordis.patch.yml 的 insert 列表）：
//   - id: approval-email
//     name: "/path/to/DSH-ApproveByEmail-WhenApprovalNeeded/src/plugin.js"
//     config:
//       address: sender@example.com
//       secretsFile: "/path/to/DSH-ApproveByEmail-WhenApprovalNeeded/secrets.json"
//       pollIntervalMs: 5000
// 改完需要重启 DSH 才会加载（插件在 HOST 启动时装载）。
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readSettings } from './config.mjs'
import { createAnswerer } from './answerer.mjs'
import { sendMail } from './mail-smtp.mjs'
import { MailboxWatcher } from './mail-imap.mjs'

const name = 'approval-email'
const inject = ['approval']
const here = dirname(fileURLToPath(import.meta.url))

/**
 * 插件入口。整体兜一层：本插件属于「多一条路」，配置写错不该把 DSH 启动拖下水——
 * 失败时只在 HOST 日志里说明，界面审批照常。
 * @param ctx - cordis 上下文。
 * @param rawConfig - profile patch 里的 config。
 */
function apply(ctx, rawConfig) {
  const log = (message) => console.warn(`[${name}] ${message}`)

  let settings
  try {
    settings = readSettings(rawConfig)
  } catch (error) {
    log(`配置不可用，插件未挂载（界面审批不受影响）：${error?.message ?? error}`)
    return
  }

  const answerer = createAnswerer({
    settings,
    deps: {
      sendMail,
      createWatcher: (options) => new MailboxWatcher(options),
      log,
      auditFile: settings.auditFile === '' ? join(here, '..', 'audit', 'audit.jsonl') : settings.auditFile,
    },
  })

  ctx.on('approval/request', (req, next) => answerer.handle(req, next), { prepend: true })
  ctx.effect(() => () => {
    log('正在卸载：放掉等待中的审批与收信连接')
    void answerer.stop()
  }, `${name}: 邮件审批通道`)

  log(`已挂载：${settings.address}（SMTP ${settings.smtp.host}:${settings.smtp.port}，IMAP ${settings.imap.host}:${settings.imap.port}，`
    + `轮询 ${settings.pollIntervalMs}ms，${settings.waitMs === 0 ? '永不超时' : `${settings.waitMs}ms 超时`}`
    + `${settings.notifyOnly ? '，仅通知模式' : ''}）`)
}

export { apply, inject, name }
