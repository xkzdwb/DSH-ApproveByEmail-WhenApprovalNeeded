// 通知邮件的文案。纯文本与 HTML 两份，内容一致——手机、网页、客户端都看得清。

/** 按配置时区格式化时间。 */
function formatTime(date, timeZone) {
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).format(date)
  } catch {
    return date.toISOString()
  }
}

/** 从请求里尽量挖出「这是哪个会话、哪个工作区」，挖不到就写未知。 */
export function requestContext(req) {
  const session = req?.agent?.session
  const cwd = session?.header?.cwd ?? session?.cwd ?? session?.meta?.cwd ?? undefined
  return {
    tool: String(req?.toolName ?? '(未知工具)'),
    reason: String(req?.reason ?? req?.displayReason ?? '（未提供原因）'),
    callId: req?.callId === undefined ? '（无）' : String(req.callId),
    sessionId: String(session?.id ?? '（未知会话）'),
    workspace: cwd === undefined ? '（未知）' : String(cwd),
    agentId: String(req?.agent?.id ?? '（未知）'),
  }
}

/**
 * 拼通知邮件。
 * @param options.settings - 归一化配置。
 * @param options.token - 一次性令牌（不带 `#`）。
 * @param options.req - approval/request 的请求对象。
 * @param options.now - 当前时间。
 * @returns { subject, text, html }
 */
export function buildNotification({ settings, token, req, now = new Date() }) {
  const info = requestContext(req)
  const time = formatTime(now, settings.timeZone)
  const marked = `#${token}`
  const subject = `${settings.subjectPrefix} ${marked} 需要你批准：${info.tool}`

  const text = [
    'DSH 需要你批准一次操作。',
    '',
    `令牌：${marked}`,
    `工具：${info.tool}`,
    `原因：${info.reason}`,
    `调用：${info.callId}`,
    `会话：${info.sessionId}`,
    `工作区：${info.workspace}`,
    `时间：${time}`,
    '',
    '【直接回复本邮件即可决定】',
    `批准：回复正文写「同意 ${marked}」`,
    `拒绝：回复正文写「拒绝 ${marked}」`,
    '',
    '说明：',
    '· 批准只对这一次操作有效，不记忆、不永久放行。',
    '· DSH 界面上的审批弹窗同时有效，邮件与界面哪个先回，就按哪个算。',
    '· 受 DSH 审批接口限制，本邮件不含具体命令与参数，只有工具名与请求原因。',
    `· 认令必须带令牌 ${marked}；令牌不符、发件人不符的回复一律忽略。`,
  ].join('\n')

  const rows = [
    ['工具', info.tool],
    ['原因', info.reason],
    ['调用', info.callId],
    ['会话', info.sessionId],
    ['工作区', info.workspace],
    ['时间', time],
  ]
  const html = [
    '<div style="font-family:-apple-system,Segoe UI,Microsoft YaHei,sans-serif;font-size:14px;line-height:1.7;color:#222">',
    '<p>DSH 需要你批准一次操作。</p>',
    `<p style="font-size:20px;font-weight:700;letter-spacing:1px">令牌：${marked}</p>`,
    '<table cellpadding="6" cellspacing="0" style="border-collapse:collapse">',
    ...rows.map(([key, val]) => `<tr><td style="color:#666;white-space:nowrap">${escapeHtml(key)}</td><td>${escapeHtml(val)}</td></tr>`),
    '</table>',
    '<p style="margin-top:16px"><b>直接回复本邮件即可决定：</b></p>',
    `<p>批准 → 正文写「同意 ${marked}」<br>拒绝 → 正文写「拒绝 ${marked}」</p>`,
    '<p style="color:#666;font-size:12px">批准只对这一次操作有效；界面弹窗同时有效，先到先算；本邮件不含具体命令与参数。</p>',
    '</div>',
  ].join('\n')

  return { subject, text, html }
}

function escapeHtml(text) {
  return String(text ?? '').replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char])
}
