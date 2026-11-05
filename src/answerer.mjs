// 应答核心：一套机制，两种用途。
//   审批（approval/request）  → 结论是 allowed-once / rejected
//   提问（user-questions/request）→ 结论是 { answers: [{ id, selected, custom? }] }
//
// 共同点：抢一个一次性令牌 → 发邮件 → 轮询收件箱 → 你把回复发回来 → 带着结论返回。
// 差别只在「邮件怎么渲染」和「回复怎么解释」，所以这两件事做成可替换的适配器。
//
// 界面那条路（是否先 next() 交给浏览器）两者不同：
//   · 提问：一定要交给界面（弹选项卡）。你在邮件里答完后，工具调用结束、会话投影关闭，
//     卡片由投影自动收掉 —— 这正是「邮件回复后收回选项按钮」的实现方式。
//   · 审批：卡片一旦弹出就没有 Host 侧的关闭通道（客户端只在用户点击或插件卸载时销毁它），
//     所以默认不弹，免得邮件批完之后屏幕上留一张永远不消失的卡。想要旧的并行模式把
//     showApprovalCard 设成 true。
import { newToken } from './token.mjs'
import { buildNotification } from './notify.mjs'
import { screenHeaders, readDecision } from './decision.mjs'
import { buildQuestionMail, interpretAnswer } from './questions.mjs'
import { appendAudit } from './audit.mjs'
import { newMessageId } from './mime.mjs'
import { parseHeaders, parseMessage, extractNewText } from './mime.mjs'
import { extractTokens } from './token.mjs'

/**
 * 先从邮件里认出「这是哪个待办」。必须先定令牌，才能拿到对应的请求
 * （提问的解析要知道题目与选项，而题目在请求里）。
 * @param headerText - header 区。
 * @param bodyText - 正文区（latin1）。
 * @param tokens - 当前待办令牌集合。
 * @returns 命中的令牌，或 null。
 */
function findToken(headerText, bodyText, tokens) {
  const subject = parseHeaders(headerText).decoded('subject') ?? ''
  const body = parseMessage(headerText, bodyText)
  const fresh = extractNewText(body)
  const open = new Set(tokens)
  const inSubject = extractTokens(subject).filter((token) => open.has(token))
  if (inSubject.length > 0) return inSubject[0]
  const inBody = extractTokens(`${fresh}\n${body}`).filter((token) => open.has(token))
  return inBody[0] ?? null
}

/** 审批的适配器：邮件模板 + 「同意/拒绝」解析。 */
const APPROVAL = {
  label: '审批',
  render: ({ settings, token, req, now }) => buildNotification({ settings, token, req, now }),
  interpret: ({ headerText, bodyText, tokens }) => {
    const result = readDecision({ headerText, bodyText, tokens })
    const value = result.decision === null ? null : result.decision === 'allow' ? 'allowed-once' : 'rejected'
    return { token: result.token, value, note: result.note }
  },
  describeAsked: (req) => `工具 ${req?.toolName ?? '?'}`,
  describeValue: (value) => String(value),
}

/** 提问的适配器：选项清单 + 序号/原文/自定义解析。 */
const QUESTION = {
  label: '提问',
  render: ({ settings, token, req, now }) => buildQuestionMail({ settings, token, request: req, now }),
  interpret: ({ headerText, bodyText, tokens, req }) => interpretAnswer({ headerText, bodyText, tokens, request: req }),
  describeAsked: (req) => `${Array.isArray(req?.questions) ? req.questions.length : 0} 道题`,
  describeValue: (value) => {
    const answers = Array.isArray(value?.answers) ? value.answers : []
    return answers.map((item) => `${item.id}:${item.selected.join('|')}${item.custom === undefined ? '' : '+custom'}`).join(' ')
  },
}

/**
 * 造一个应答者。
 * @param options.settings - readSettings() 的产物。
 * @param options.deps - { sendMail, createWatcher, log, auditFile, now }
 * @param options.kind - 'approval' | 'question'
 * @returns { handle(req, next), stop(), pendingCount(), pendingTokens() }
 */
export function createAnswerer({ settings, deps, kind = 'approval' }) {
  const { sendMail, createWatcher, log, auditFile, now = () => new Date() } = deps
  const adapter = kind === 'question' ? QUESTION : APPROVAL

  /** token → { resolve, fail, req, messageId, askedAt } */
  const pending = new Map()
  let watcher = null
  let timer = null
  let polling = false
  let closeRequested = false
  let lastPollError = null

  function audit(record) {
    void appendAudit(auditFile, { kind: adapter.label, ...record }, log)
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

    const { subject, text, html } = adapter.render({ settings, token, req, now: now() })
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
    audit({ kind: 'asked', token, messageId, what: adapter.describeAsked(req), session: req?.agent?.session?.id })
    log(`已发出${adapter.label}邮件 #${token}（${adapter.describeAsked(req)}）`)
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
    const token = findToken(message.headerText, message.bodyText, tokens)
    if (token === null) {
      log(`收到一封像回复的邮件（UID ${message.uid}），但没有待办令牌对得上，忽略`)
      return
    }
    const entry = pending.get(token)
    if (entry === undefined) return
    const result = adapter.interpret({
      headerText: message.headerText,
      bodyText: message.bodyText,
      tokens,
      req: entry.req,
    })
    if (result.token === null) {
      log(`收到一封像回复的邮件（UID ${message.uid}），但令牌对不上，忽略`)
      return
    }
    if (result.value === null || result.value === undefined) {
      log(`#${result.token} 的回复没读明白（${result.note ?? '无结论'}），继续等`)
      audit({ kind: 'unreadable', token: result.token, uid: message.uid, note: result.note })
      return
    }
    pending.delete(result.token)
    audit({ kind: 'decided', token: result.token, uid: message.uid, result: adapter.describeValue(result.value), source: 'email' })
    log(`按邮件回复 #${result.token}：${adapter.describeValue(result.value)}`)
    entry.resolve(result.value)
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
   * 一个待决策请求进来。
   * @param req - approval/request 或 user-questions/request 的请求对象。
   * @param next - 下游应答者（桌面端就是浏览器界面）。
   * @returns 结论：审批是四个词之一；提问是 AskUserQuestionAnswer。
   */
  async function handle(req, next) {
    // 是否同时把请求交给界面。两条通道默认都不交，原因同一个（已用客户端源码确认）：
    // 客户端一旦收到转发请求，卡片就只能由「用户点击 / 客户端自己作答」结束 ——
    // 它 reconcile 时对 card.hasRequest() / hasWaterfall() 的卡片直接 continue，永不删除，
    // 投影关不关都没用。所以「邮件答完 ⇒ 卡片自动消失」在转发的前提下做不到；
    // 卡片弹出来却收不掉，比不弹更糟。想弹卡就把对应的开关打开。
    const wantsUi = (kind === 'question' ? settings.showQuestionCard : settings.showApprovalCard) === true
    const ui = Promise.withResolvers()
    let uiStarted = false
    const startUi = () => {
      if (uiStarted) return
      uiStarted = true
      Promise.resolve().then(() => next()).then(ui.resolve, ui.reject)
    }
    if (wantsUi) startUi()

    const token = uniqueToken()
    if (kind === 'approval' && settings.notifyOnly) {
      pending.set(token, { resolve: () => {}, fail: () => {}, req, messageId: undefined, askedAt: now().toISOString() })
      void notify(token, req)
        .catch((error) => log(`通知邮件发送失败（界面审批不受影响）：${error?.message ?? error}`))
        .finally(() => pending.delete(token))
      startUi()
      return ui.promise
    }

    let settle
    let fail
    const emailAnswer = new Promise((resolve, reject) => {
      settle = resolve
      fail = reject
    })
    // 卸载/中止时这里会 reject；调用方可能已经走开（比如 turn 被中止后），
    // 挂一个空 catch 免得变成 unhandledRejection 把宿主进程带下去。
    void emailAnswer.catch(() => {})
    pending.set(token, { resolve: settle, fail, req, messageId: undefined, askedAt: now().toISOString() })

    const onAbort = () => {
      if (pending.delete(token)) {
        audit({ kind: 'abandoned', token, reason: 'turn 被中止' })
        fail(new Error('turn 被中止'))
      }
    }
    req?.signal?.addEventListener?.('abort', onAbort, { once: true })

    ensureWatcher()
    void notify(token, req).catch((error) => {
      pending.delete(token)
      log(`${adapter.label}邮件发送失败（${uiStarted ? '界面那条路不受影响' : '改由界面处理'}）：${error?.message ?? error}`)
      audit({ kind: 'notify-failed', token, error: String(error?.message ?? error) })
      // 邮件出不去时兜底：回到界面，绝不把请求卡死在无人可见的状态。
      startUi()
    })

    try {
      const outcome = await Promise.race([ui.promise, emailAnswer])
      audit({ kind: 'settled', token, result: adapter.describeValue(outcome), source: uiStarted ? 'race' : 'email' })
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
      entry.fail(new Error('approval-email 已卸载，等待中的请求已放掉'))
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
