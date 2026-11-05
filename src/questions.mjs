// 提问（ask_user_question）的邮件渲染与回复解析。
//
// Host 侧的约定（@deepseek-ai/dsh-user-questions）：
//   请求：{ questions: [{ id, question, detail?, header?, options?: [{ label, description? }], multiSelect? }],
//           agent?, signal?, wait?: { callId, timed? } }
//   答案：{ answers: [{ id, selected: string[], custom? }] }  —— 每道题必须恰好出现一次
//         单选题用 custom 时 selected 留空；多选题 custom 与 selected 可以并存；
//         跳过的题给 { id, selected: [] }。
import { parseHeaders, parseMessage, extractNewText } from './mime.mjs'
import { extractTokens } from './token.mjs'
import { requestContext } from './notify.mjs'

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

function escapeHtml(text) {
  return String(text ?? '').replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char])
}

/** 取一道题的显示名：优先 header，其次截断的问题正文。 */
function questionTitle(question, index) {
  const header = String(question?.header ?? '').trim()
  if (header !== '') return header
  const text = String(question?.question ?? '').trim().replace(/\s+/g, ' ')
  return text.length > 40 ? `${text.slice(0, 40)}…` : text || `问题 ${index + 1}`
}

/** 把请求里的题目归一化成渲染/解析都要用的形状。 */
export function normalizeQuestions(request) {
  const list = Array.isArray(request?.questions) ? request.questions : []
  return list.map((question, index) => ({
    index,
    id: String(question?.id ?? `q${index + 1}`),
    header: String(question?.header ?? ''),
    question: String(question?.question ?? ''),
    detail: question?.detail === undefined ? undefined : String(question.detail),
    multiSelect: question?.multiSelect === true,
    options: (Array.isArray(question?.options) ? question.options : []).map((option, optionIndex) => ({
      number: optionIndex + 1,
      label: String(option?.label ?? ''),
      description: option?.description === undefined ? undefined : String(option.description),
    })),
  }))
}

/**
 * 拼提问邮件。
 * @param options.settings - 归一化配置。
 * @param options.token - 一次性令牌（不带 `#`）。
 * @param options.request - user-questions/request 的请求对象。
 * @param options.now - 当前时间。
 * @returns { subject, text, html }
 */
export function buildQuestionMail({ settings, token, request, now = new Date() }) {
  const questions = normalizeQuestions(request)
  const info = requestContext(request)
  const marked = `#${token}`
  const title = questions.length === 0 ? '需要你选择' : questionTitle(questions[0], 0)
  const subject = `${settings.questionSubjectPrefix} ${marked} 需要你选择：${title}`
  const time = formatTime(now, settings.timeZone)

  const lines = [
    'DSH 需要你做一个选择。',
    '',
    `令牌：${marked}`,
    `会话：${info.sessionId}`,
    `工作区：${info.workspace}`,
    `时间：${time}`,
    '',
  ]

  for (const question of questions) {
    lines.push(`【问题 ${question.index + 1}】${question.header || ''}`.trimEnd())
    lines.push(question.question)
    if (question.detail !== undefined && question.detail !== '') {
      const detail = question.detail.replace(/\s*\n\s*/g, ' ').trim()
      lines.push(`  说明：${detail.length > 300 ? `${detail.slice(0, 300)}…` : detail}`)
    }
    if (question.options.length === 0) {
      lines.push('  （没有预设选项，请直接写你的答案）')
    } else {
      for (const option of question.options) {
        lines.push(`  ${option.number}) ${option.label}${option.description ? ` — ${option.description}` : ''}`)
      }
      if (question.multiSelect) lines.push('  （可多选）')
    }
    lines.push('')
  }

  lines.push(
    '【怎么回】直接回复本邮件，每行一题：',
    '· 单选：`1. 2` = 第 1 题选第 2 个选项',
    '· 多选：`1. 2,3`',
    '· 自己写：`1. 自定义：你的文字`',
    '· 也可以直接写选项原文：`1. 选项文字`',
    '· 不想答某题就不写它（会记为跳过）',
    '',
    `· 只有一道题时，直接回「2」或选项原文也行`,
    `· 认令需要令牌 ${marked}；令牌不符的回复一律忽略`,
  )

  const text = lines.join('\n')

  const blocks = questions.map((question) => {
    const options = question.options.length === 0
      ? '<p style="color:#666">（没有预设选项，请直接写你的答案）</p>'
      : `<ol>${question.options.map((option) => `<li><b>${escapeHtml(option.label)}</b>${option.description ? ` — ${escapeHtml(option.description)}` : ''}</li>`).join('')}</ol>`
    return [
      `<div style="margin:14px 0 0"><div style="font-weight:700">【问题 ${question.index + 1}】${escapeHtml(question.header)}</div>`,
      `<div style="white-space:pre-wrap;margin:4px 0">${escapeHtml(question.question)}</div>`,
      question.detail ? `<div style="color:#666;font-size:12px">说明：${escapeHtml(question.detail.slice(0, 300))}</div>` : '',
      options,
      question.multiSelect ? '<div style="color:#666;font-size:12px">（可多选）</div>' : '',
      '</div>',
    ].join('')
  }).join('')

  const html = [
    '<div style="font-family:-apple-system,Segoe UI,Microsoft YaHei,sans-serif;font-size:14px;line-height:1.7;color:#222">',
    '<p>DSH 需要你做一个选择。</p>',
    `<p style="font-size:20px;font-weight:700;letter-spacing:1px">令牌：${marked}</p>`,
    `<div style="color:#666;font-size:12px">会话：${escapeHtml(info.sessionId)}｜工作区：${escapeHtml(info.workspace)}｜${escapeHtml(time)}</div>`,
    blocks,
    '<hr style="border:none;border-top:1px solid #eee;margin:16px 0">',
    '<p><b>直接回复本邮件，每行一题：</b><br>',
    '单选 <code>1. 2</code>（第 1 题选第 2 项）｜多选 <code>1. 2,3</code>｜自己写 <code>1. 自定义：文字</code><br>',
    '不写某题就记为跳过；只有一道题时直接回「2」也行。</p>',
    '</div>',
  ].join('')

  return { subject, text, html }
}

// ---------------------------------------------------------------- 回复解析

/** 把一段文字按选项匹配成 label。 */
function matchOption(text, question) {
  const raw = String(text ?? '').trim()
  if (raw === '') return undefined
  const candidates = question.options
  // 纯数字 = 选项序号
  if (/^\d+$/.test(raw)) {
    const option = candidates.find((item) => item.number === Number(raw))
    return option?.label
  }
  const lower = raw.toLowerCase()
  const exact = candidates.find((item) => item.label.trim().toLowerCase() === lower)
  if (exact !== undefined) return exact.label
  const starts = candidates.find((item) => item.label.trim().toLowerCase().startsWith(lower))
  if (starts !== undefined && lower.length >= 2) return starts.label
  const contains = candidates.find((item) => item.label.toLowerCase().includes(lower))
  return contains?.label
}

/** 解析一题的回答文本：可能是序号/原文，也可能带「自定义：」。 */
function readItem(text, question) {
  const raw = String(text ?? '').trim()
  if (raw === '') return null

  const customMatch = /^(?:自定义|custom)\s*[:：]\s*([\s\S]+)$/i.exec(raw)
  if (customMatch !== null) {
    const custom = customMatch[1].trim()
    if (custom === '') return null
    return { selected: [], custom }
  }

  if (question.options.length === 0) return { selected: [], custom: raw }

  const parts = raw.split(/[,，、;；\s]+/).filter((piece) => piece !== '')
  const selected = []
  for (const part of parts) {
    const label = matchOption(part, question)
    if (label !== undefined && !selected.includes(label)) selected.push(label)
  }
  if (selected.length === 0) {
    // 匹配不到选项：当作自由填写（相当于界面上的「自定义」）
    return { selected: [], custom: raw }
  }
  if (!question.multiSelect) selected.length = 1
  return { selected }
}

/**
 * 解析提问回复。
 * @param options.headerText - header 区。
 * @param options.bodyText - 正文区（latin1）。
 * @param options.tokens - 当前待办令牌集合。
 * @param options.request - 对应的请求（要按它的题目顺序出答案）。
 * @returns { token, value, note } —— value 为 AskUserQuestionAnswer，null 表示还没读明白。
 */
export function interpretAnswer({ headerText, bodyText, tokens, request }) {
  const headers = parseHeaders(headerText)
  const subject = headers.decoded('subject') ?? ''
  const body = parseMessage(headerText, bodyText)
  const fresh = extractNewText(body)

  const pending = new Set(tokens)
  const inSubject = extractTokens(subject).filter((token) => pending.has(token))
  const inBody = extractTokens(`${fresh}\n${body}`).filter((token) => pending.has(token))
  const token = inSubject[0] ?? inBody[0] ?? null
  if (token === null) return { token: null, value: null, note: '没找到待办令牌' }

  const questions = normalizeQuestions(request)
  /** 题号（1 起）→ 该题的回答文本 */
  const picked = new Map()

  // 「1. 2」「第 2 题：同意」「Q1: A」「1) 2」
  const linePattern = /^[\s>*·-]*(?:第\s*)?(?:问题\s*|q|Q)?\s*(\d+)\s*[.、:：=)）]\s*(.+)$/gm
  for (const match of fresh.matchAll(linePattern)) {
    const index = Number(match[1])
    if (!picked.has(index)) picked.set(index, match[2].trim())
  }

  // 没有「题号.答案」写法时，再认两种很自然的写法（实测真人就这么回）：
  //   · 只有一道题 → 整段就是答案
  //   · 多道题、一行一个纯答案（`1` / `1`，或 `邮件通道正常` / `B 选项`）→ 按题目顺序对应
  if (picked.size === 0) {
    const lines = fresh.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== '')
    const numbered = /^[\s>*·-]*(?:第\s*)?(?:问题\s*|q|Q)?\s*\d+\s*[.、:：=)）]/
    if (questions.length === 1) {
      const single = fresh.trim()
      if (single !== '') picked.set(1, single)
    } else if (lines.length === questions.length && lines.every((line) => !numbered.test(line))) {
      lines.forEach((line, index) => picked.set(index + 1, line))
    }
  }

  const answers = []
  for (const question of questions) {
    const pickedText = picked.get(question.index + 1)
    const item = pickedText === undefined ? null : readItem(pickedText, question)
    if (item === null) {
      answers.push({ id: question.id, selected: [] })
      continue
    }
    answers.push({ id: question.id, ...item })
  }

  const answered = answers.filter((item) => item.selected.length > 0 || item.custom !== undefined)
  if (answered.length === 0) {
    return { token, value: null, note: '没读出一道题的答案' }
  }
  return { token, value: { answers }, note: null }
}
