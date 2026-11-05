// 判断「这封来信算不算一次审批回复」，以及它到底说了「同意」还是「拒绝」。
// 两段式：先只看 header（决定要不要下载正文），再解正文做判定。全程 fail-closed：
// 发件人不对、不是回复、没令牌、说不清 —— 一律当作「不是给你的答案」。
import { parseHeaders, parseMessage, extractNewText } from './mime.mjs'
import { extractTokens } from './token.mjs'

/** 同意的说法。 */
const ALLOW_RE = /(同意|批准|通過|通过|允许|允許|放行|approve[d]?|allow(?:ed)?|\byes\b|\bok\b)/i
/** 拒绝的说法。 */
const DENY_RE = /(拒绝|拒絕|驳回|駁回|不同意|不允许|不允許|禁止|deny|denied|reject(?:ed)?|\bno\b)/i
/** 回复前缀：中英文邮件客户端各不相同。 */
const REPLY_PREFIX_RE = /^\s*(re|答复|答覆|回复|回覆|aw|sv)\s*[:：]/i

/** 从 From 头里取出纯地址。 */
export function senderAddress(value) {
  const text = String(value ?? '')
  const angled = /<([^<>]+)>/.exec(text)
  return (angled === null ? text : angled[1]).trim().toLowerCase()
}

/**
 * 只读 header 的第一道筛子。
 * @param headerText - header 区（latin1）。
 * @param options.address - 唯一认可的收件人/发件人地址。
 * @param options.allowFrom - 额外允许的发件人。
 * @returns { from, subject } 或 null（不关心这封）。
 */
export function screenHeaders(headerText, { address, allowFrom = [] } = {}) {
  const headers = parseHeaders(headerText)

  // 我们自己发出去的通知被投回同一个收件箱时，别把自己的通知当成回复。
  if (String(headers.get('x-dsh-approval') ?? '').trim().toLowerCase() === 'notify') return null

  const from = senderAddress(headers.decoded('from'))
  const allowed = new Set([String(address ?? '').toLowerCase(), ...allowFrom.map((item) => String(item).toLowerCase())])
  if (from === '' || !allowed.has(from)) return null

  const subject = headers.decoded('subject') ?? ''
  const isReply = headers.has('in-reply-to') || headers.has('references') || REPLY_PREFIX_RE.test(subject)
  if (!isReply) return null

  return { from, subject }
}

/**
 * 在一段文字里找结论。
 * @param text - 待判定的文字。
 * @returns 'allow' | 'deny' | 'ambiguous' | null
 */
function readIntent(text) {
  // 「不同意 / 不允许」这类词里嵌着「同意 / 允许」，先把它们拿掉再找同意的说法。
  const allowText = text.replace(/不同意|不允許|不允许|不批准|不通過|不通过|不放行/g, '')
  const allow = ALLOW_RE.test(allowText)
  const deny = DENY_RE.test(text)
  if (allow && deny) return 'ambiguous'
  if (deny) return 'deny'
  if (allow) return 'allow'
  return null
}

/**
 * 第二道：解正文，给出令牌与结论。
 * @param options.headerText - header 区。
 * @param options.bodyText - 正文区（latin1）。
 * @param options.tokens - 当前待办令牌集合。
 * @returns { token, decision, note } —— decision 为 'allow' | 'deny' | null（null 表示先别动）。
 */
export function readDecision({ headerText, bodyText, tokens }) {
  const headers = parseHeaders(headerText)
  const subject = headers.decoded('subject') ?? ''
  const body = parseMessage(headerText, bodyText)
  const fresh = extractNewText(body)

  const pending = new Set(tokens)
  const inSubject = extractTokens(subject).filter((token) => pending.has(token))
  const inBody = extractTokens(`${fresh}\n${body}`).filter((token) => pending.has(token))
  const token = inSubject[0] ?? inBody[0] ?? null
  if (token === null) return { token: null, decision: null, note: '没找到待办令牌' }

  // 先只看你新写的那几句：引用的原文里两个示例都有，不隔离就会误判。
  const fromBody = readIntent(fresh)
  if (fromBody === 'ambiguous') return { token, decision: null, note: '同一封里既有同意也有拒绝，等你重发一封说清楚' }
  if (fromBody !== null) return { token, decision: fromBody, note: null }

  // 正文里没有结论，才看主题——而且要砍掉我们自己写的那半句
  // （「需要你批准：bash」里的「批准」不是你的意思，是通知模板的措辞）。
  const subjectOnly = subject
    .replace(/^\s*(re|答复|答覆|回复|回覆|aw|sv)\s*[:：]\s*/i, '')
    .replace(new RegExp(`#${token}[\\s\\S]*$`), '')
  const fromSubject = readIntent(subjectOnly)
  if (fromSubject === 'ambiguous') return { token, decision: null, note: '主题里既有同意也有拒绝，等你重发一封说清楚' }
  if (fromSubject !== null) return { token, decision: fromSubject, note: null }

  return { token, decision: null, note: '没读出「同意 / 拒绝」' }
}
