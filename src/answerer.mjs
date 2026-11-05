// 审批应答核心：一个「最外层」应答者。
//   1. 先把请求交给下游（浏览器弹窗）——所以界面照旧弹，不会因为邮件而变慢；
//   2. 同时发一封通知邮件，并开始轮询收件箱等你的回复；
//   3. 两条路谁先给出结论就用谁：界面 = allowed-once/rejected，邮件 = allowed-once/rejected。
// 邮件这条线永不超时（按你的要求持续等待）；turn 被中止时由 DSH 侧裁定 cancelled，
// 这里只负责把待办清理干净，不让轮询泄漏。
import { newToken } from './token.mjs'
import { buildNotification } from './notify.mjs'
import { screenHeaders, readDecision } from './decision.mjs'
import { appendAudit } from './audit.mjs'
import { newMessageId } from './mime.mjs'

/**
 * 造一个应答者。
 * @param options.settings - readSettings() 的产物。
 * @param options.deps - { sendMail, createWatcher, log, auditFile, now }
 * @returns { handle(req, next), stop(), pendingCount() }
 */
export function createAnswerer({ settings, deps }) {
  const { sendMail, createWatcher, log, auditFile, now = () => new Date() } = deps

  /** token → { resolve, req, messageId, askedAt } */
  const pending = new Map()
  let watcher = null
  let timer = null
  let polling = false
  let closeRequested = false
  let lastPollError = null

  function audit(record) {
    void appendAudit(auditFile, record, log)
  }

  function uniqueToken() {
    let token = newToken()
    while (pending.has(token)) token = newToken()
    return token
  }

  /** 发通知邮件。失败只告警：界面那条路必须照常可用。 */
  async function notify(token, req) {
    const domain = settings.address.split('@')[1] ?? 'localhost'
    const messageId = newMessageId(domain)
    const entry = pending.get(token)
    if (entry !== undefined) entry.messageId = messageId

    const { subject, text, html } = buildNotification({ settings, token, req, now: now() })
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
      messageId,
      extraHeaders: {
        'X-DSH-Approval': 'notify',
        'X-DSH-Approval-Token': token,
      },
      log,
    })
    audit({ kind: 'asked', token, messageId, tool: req?.toolName, reason: req?.reason, session: req?.agent?.session?.id })
    log(`已发出审批邮件 #${token}（工具 ${req?.toolName ?? '?'}）`)
  }

  // ---- 收件箱轮询 ----

  function schedule(delay) {
    if (timer !== null) return
    timer = setTimeout(() => {
      timer = null
      void tick()
    }, Math.max(0, delay))
    timer.unref?.()
  }

  function ensureWatcher() {
    if (watcher === null) {
      watcher = createWatcher({
        ...settings.imap,
        user: settings.user,
        authCode: settings.authCode,
        log,
      })
    }
    if (timer === null && !polling) schedule(0)
  }

  function stopWatcher() {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    if (polling) {
      closeRequested = true
      return
    }
    const current = watcher
    watcher = null
    if (current !== null) void current.close().catch((error) => log(`关闭收信连接失败（忽略）：${error?.message ?? error}`))
  }

  /** 处理一封候选邮件：认令牌 → 出结论。 */
  function handleMessage(message) {
    const tokens = [...pending.keys()]
    const result = readDecision({ headerText: message.headerText, bodyText: message.bodyText, tokens })
    if (result.token === null) {
      log(`收到一封像回复的邮件（UID ${message.uid}），但没有待办令牌对得上，忽略`)
      return
    }
    const entry = pending.get(result.token)
    if (entry === undefined) return
    if (result.decision === null) {
      log(`#${result.token} 的回复没读明白（${result.note}），继续等`)
      audit({ kind: 'unreadable', token: result.token, uid: message.uid, note: result.note })
      return
    }
    pending.delete(result.token)
    const outcome = result.decision === 'allow' ? 'allowed-once' : 'rejected'
    audit({ kind: 'decided', token: result.token, uid: message.uid, decision: result.decision, outcome, source: 'email' })
    log(`按邮件回复 #${result.token}：${result.decision === 'allow' ? '批准' : '拒绝'}`)
    entry.resolve(outcome)
  }

  async function tick() {
    if (pending.size === 0 || watcher === null) {
      stopWatcher()
      return
    }
    polling = true
    try {
      const messages = await watcher.poll({
        filter: (headerText) => screenHeaders(headerText, { address: settings.address, allowFrom: settings.allowFrom }) !== null,
      })
      lastPollError = null
      for (const message of messages) handleMessage(message)
    } catch (error) {
      const detail = String(error?.message ?? error)
      if (detail !== lastPollError) {
        lastPollError = detail
        log(`收信失败（下轮自动重连重试）：${detail}`)
      }
    } finally {
      polling = false
      if (pending.size > 0) schedule(settings.pollIntervalMs)
      else if (closeRequested) {
        closeRequested = false
        stopWatcher()
      }
    }
  }

  // ---- 对外接口 ----

  /**
   * 一个待审批请求进来。
   * @param req - approval/request 的请求对象。
   * @param next - 下游应答者（桌面端就是浏览器弹窗）。
   * @returns 四个结论之一。
   */
  async function handle(req, next) {
    // 立刻把请求转给下游：界面弹窗不等邮件。
    const downstream = Promise.resolve().then(() => next())

    const token = uniqueToken()
    if (settings.notifyOnly) {
      pending.set(token, { resolve: () => {}, req, messageId: undefined, askedAt: now().toISOString() })
      void notify(token, req)
        .catch((error) => log(`通知邮件发送失败（界面审批不受影响）：${error?.message ?? error}`))
        .finally(() => pending.delete(token))
      return downstream
    }

    let settle
    const emailAnswer = new Promise((resolve) => {
      settle = resolve
    })
    pending.set(token, { resolve: settle, req, messageId: undefined, askedAt: now().toISOString() })

    const onAbort = () => {
      if (pending.delete(token)) {
        audit({ kind: 'abandoned', token, reason: 'turn 被中止' })
        settle('cancelled')
      }
    }
    req?.signal?.addEventListener?.('abort', onAbort, { once: true })

    ensureWatcher()
    void notify(token, req).catch((error) => {
      // 邮件出不去就撤掉这个令牌：只留界面这条线，绝不因为邮件故障而误放行或卡住。
      pending.delete(token)
      log(`审批邮件发送失败（本请求改由界面审批）：${error?.message ?? error}`)
      audit({ kind: 'notify-failed', token, error: String(error?.message ?? error) })
    })

    try {
      const outcome = await Promise.race([downstream, emailAnswer])
      audit({ kind: 'settled', token, outcome, source: 'race' })
      return outcome
    } finally {
      pending.delete(token)
      req?.signal?.removeEventListener?.('abort', onAbort)
    }
  }

  /** 插件卸载/停用时调用：放掉所有等待与连接。 */
  async function stop() {
    for (const [token, entry] of [...pending.entries()]) {
      pending.delete(token)
      entry.resolve('unavailable')
    }
    stopWatcher()
  }

  return {
    handle,
    stop,
    pendingCount: () => pending.size,
    /** 仅供诊断：现在正在等哪些令牌。 */
    pendingTokens: () => [...pending.keys()],
  }
}
