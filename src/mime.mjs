// MIME 编解码（够用就好）：
//   发信——主题 RFC2047 编码、正文 base64、multipart/alternative；
//   收信——拆 multipart、解 base64 / quoted-printable、按 charset 解码、HTML 转纯文本。
// 约定：所有「原始」字符串都是 latin1（每个字符 = 一个字节），只在叶子节点转 Buffer 解码。
import { randomUUID } from 'node:crypto'

/** 常用 charset 别名 → TextDecoder 认得的名字。 */
const CHARSET_ALIASES = {
  utf8: 'utf-8',
  'utf-8': 'utf-8',
  gb2312: 'gbk',
  gb18030: 'gbk',
  gbk: 'gbk',
  big5: 'big5',
  latin1: 'windows-1252',
  'iso-8859-1': 'windows-1252',
  'us-ascii': 'utf-8',
  ascii: 'utf-8',
}

/**
 * 按 charset 解码字节。
 * @param bytes - Buffer。
 * @param charset - MIME 里的 charset 名。
 * @returns 解码后的字符串（不抛错，认不出就退回 UTF-8 容错解码）。
 */
export function decodeCharset(bytes, charset) {
  const name = String(charset ?? 'utf-8').trim().toLowerCase().replace(/^["']|["']$/g, '')
  const target = CHARSET_ALIASES[name] ?? name
  try {
    return new TextDecoder(target, { fatal: false }).decode(bytes)
  } catch {
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes)
  }
}

/** latin1 字符串 → 字节。 */
function bytes(raw) {
  return Buffer.from(raw, 'latin1')
}

/**
 * 解码一个 header 值里的 RFC2047 编码词（=?UTF-8?B?...?= / ?Q?...?=）。
 * @param value - 原始 header 值（latin1）。
 * @returns 解码后的可读文本（非 ASCII 的裸字节按 UTF-8 容错处理）。
 */
export function decodeWords(value) {
  const text = String(value ?? '')
  const pattern = /=\?([^?\s]+)\?([BbQq])\?([^?]*)\?=/g
  let out = ''
  let last = 0
  let afterEncodedWord = false
  for (const match of text.matchAll(pattern)) {
    const gap = text.slice(last, match.index)
    // RFC 2047 §6.2：相邻两个编码词之间的空白必须忽略。
    // 163 会把长主题切成好几个编码词（实测 `#40c10f` / `69` 被切开），
    // 要是把中间那个空格留下来，令牌就变成了 `#40c10f 69`，谁都认不出来。
    const dropGap = afterEncodedWord && /^[\s]*$/.test(gap)
    if (!dropGap) out += decodePlainSegment(gap)
    const charset = match[1]
    const encoding = match[2].toUpperCase()
    const payload = match[3]
    if (encoding === 'B') {
      out += decodeCharset(Buffer.from(payload, 'base64'), charset)
    } else {
      // Q 编码：`_` 是空格，`=XX` 是十六进制字节。
      const decoded = payload.replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)))
      out += decodeCharset(bytes(decoded), charset)
    }
    last = match.index + match[0].length
    afterEncodedWord = true
  }
  out += decodePlainSegment(text.slice(last))
  return out
}

/**
 * 未被编码的片段：纯 ASCII 原样返回；含裸 8bit（老客户端直接塞 UTF-8 字节）才按 UTF-8 容错解一次。
 * 注意只对「原文片段」做这件事——对已经解码好的字符串再做会把它毁掉。
 * @param segment - header 里的字面片段（latin1）。
 * @returns 可读文本。
 */
function decodePlainSegment(segment) {
  if (!/[^\x00-\x7F]/.test(segment)) return segment
  return decodeCharset(bytes(segment), 'utf-8')
}

/**
 * 需要时把 header 值编成 RFC2047（纯 ASCII 原样返回）。
 * @param value - 待编码文本。
 * @returns 可直接写进 header 的值。
 */
export function encodeHeader(value) {
  const text = String(value ?? '')
  if (/^[\x20-\x7E]*$/.test(text)) return text
  return `=?UTF-8?B?${Buffer.from(text, 'utf8').toString('base64')}?=`
}

/** 生成一个 Message-ID（域用发信邮箱，收信端回复时会带上它）。 */
export function newMessageId(domain) {
  return `<dsh-approval-${randomUUID()}@${domain}>`
}

/** base64 正文按 76 列折行。 */
function base64Body(text) {
  const encoded = Buffer.from(text, 'utf8').toString('base64')
  return encoded.replace(/(.{76})/g, '$1\r\n')
}

/**
 * 拼一封 multipart/alternative 邮件。
 * @param options - { from, fromName, to, subject, text, html, messageId, date, extraHeaders }
 * @returns 完整的 RFC5322 文本（CRLF 行尾，可直接 DATA 发送）。
 */
export function buildMail({ from, fromName, to, subject, text, html, messageId, date = new Date(), extraHeaders = {} }) {
  const boundary = `dsh-${randomUUID()}`
  const lines = [
    `From: ${fromName ? `${encodeHeader(fromName)} <${from}>` : from}`,
    `To: ${to}`,
    `Subject: ${encodeHeader(subject)}`,
    `Date: ${date.toUTCString()}`,
    `Message-ID: ${messageId}`,
    'MIME-Version: 1.0',
    ...Object.entries(extraHeaders).map(([key, value]) => `${key}: ${value}`),
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    base64Body(text),
    `--${boundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    base64Body(html ?? `<pre>${text.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c])}</pre>`),
    `--${boundary}--`,
    '',
  ]
  return lines.join('\r\n')
}

/**
 * 拆出 header 区与正文区。同时返回展开（unfold）后的 header 文本。
 * @param raw - 整封或某个 part 的原始文本（latin1）。
 * @returns { headerText, body }
 */
export function splitMessage(raw) {
  const index = raw.search(/\r?\n\r?\n/)
  if (index < 0) return { headerText: raw, body: '' }
  const separator = raw.slice(index).match(/^\r?\n\r?\n/)[0]
  return { headerText: raw.slice(0, index), body: raw.slice(index + separator.length) }
}

/**
 * 解析 header 区成 Map（键小写；同名多值用数组）。
 * @param headerText - header 区（latin1）。
 * @returns { get(name), decoded(name), has(name) }
 */
export function parseHeaders(headerText) {
  const map = new Map()
  const unfolded = String(headerText ?? '').replace(/\r?\n[ \t]+/g, ' ')
  for (const line of unfolded.split(/\r?\n/)) {
    const index = line.indexOf(':')
    if (index <= 0) continue
    const name = line.slice(0, index).trim().toLowerCase()
    const value = line.slice(index + 1).trim()
    const existing = map.get(name)
    if (existing === undefined) map.set(name, value)
    else if (Array.isArray(existing)) existing.push(value)
    else map.set(name, [existing, value])
  }
  return {
    raw: map,
    has: (name) => map.has(String(name).toLowerCase()),
    get: (name) => {
      const found = map.get(String(name).toLowerCase())
      return Array.isArray(found) ? found[0] : found
    },
    all: (name) => {
      const found = map.get(String(name).toLowerCase())
      return found === undefined ? [] : Array.isArray(found) ? found : [found]
    },
    decoded: (name) => {
      const found = map.get(String(name).toLowerCase())
      const first = Array.isArray(found) ? found[0] : found
      return first === undefined ? undefined : decodeWords(first)
    },
  }
}

/** 解析 Content-Type 的 type 与参数。 */
export function parseContentType(value) {
  const text = String(value ?? 'text/plain')
  const [type, ...rest] = text.split(';')
  const params = {}
  for (const piece of rest) {
    const index = piece.indexOf('=')
    if (index <= 0) continue
    const key = piece.slice(0, index).trim().toLowerCase()
    let param = piece.slice(index + 1).trim()
    if (param.startsWith('"') && param.endsWith('"')) param = param.slice(1, -1)
    params[key] = param
  }
  return { type: type.trim().toLowerCase(), params }
}

/** 按 Content-Transfer-Encoding 还原成字节。 */
export function decodeTransfer(body, encoding) {
  const kind = String(encoding ?? '7bit').trim().toLowerCase()
  if (kind === 'base64') return Buffer.from(body.replace(/[^A-Za-z0-9+/=]/g, ''), 'base64')
  if (kind === 'quoted-printable') {
    const cleaned = body.replace(/=(?:\r?\n|$)/g, '')
    const decoded = cleaned.replace(/=([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)))
    return bytes(decoded)
  }
  return bytes(body)
}

/** HTML 转纯文本（够看懂「同意 / 拒绝」就行）。 */
export function htmlToText(html) {
  return String(html ?? '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&amp;/gi, '&')
    .replace(/&#x?([0-9a-fA-F]+);/g, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/\r?\n{3,}/g, '\n\n')
}

/**
 * 递归解析一封（或一个 part 的）邮件正文，取出可读的纯文本。
 * @param headerText - header 区（latin1）。
 * @param body - 正文区（latin1）。
 * @returns 解码后的纯文本；HTML-only 邮件会被转成文本。
 */
export function parseMessage(headerText, body) {
  const headers = parseHeaders(headerText)
  const contentType = parseContentType(headers.get('content-type'))
  const encoding = headers.get('content-transfer-encoding')

  if (contentType.type.startsWith('multipart/')) {
    const boundary = contentType.params.boundary
    if (!boundary) return decodeCharset(decodeTransfer(body, encoding), contentType.params.charset)
    const parts = splitMultipart(body, boundary)
    let fallback = ''
    for (const part of parts) {
      const parsed = parseMessage(part.headerText, part.body)
      if (parsed !== '') {
        if (parseContentType(parseHeaders(part.headerText).get('content-type')).type === 'text/plain') return parsed
        if (fallback === '') fallback = parsed
      }
    }
    return fallback
  }

  if (contentType.type === 'text/html') {
    return htmlToText(decodeCharset(decodeTransfer(body, encoding), contentType.params.charset))
  }
  if (contentType.type.startsWith('text/')) {
    return decodeCharset(decodeTransfer(body, encoding), contentType.params.charset)
  }
  return ''
}

/** 按 boundary 切分 multipart 正文。 */
export function splitMultipart(body, boundary) {
  const marker = `--${boundary}`
  const lines = String(body).split(/\r?\n/)
  const parts = []
  let current = null
  for (const line of lines) {
    if (line.startsWith(marker)) {
      if (current !== null) parts.push(current.join('\r\n'))
      if (line.startsWith(`${marker}--`)) { current = null; break }
      current = []
      continue
    }
    if (current !== null) current.push(line)
  }
  if (current !== null) parts.push(current.join('\r\n'))
  return parts.map((part) => splitMessage(part))
}

/**
 * 只保留「你新写的那几句」，砍掉被引用的原文。
 * 引入的原文里往往同时含「同意 #token」「拒绝 #token」两个示例，不砍掉就会误判。
 * @param text - 解码后的正文。
 * @returns 新写内容的文本。
 */
export function extractNewText(text) {
  const lines = String(text ?? '').split(/\r?\n/)
  // 各家客户端的引用分隔线都不同，这里覆盖：163 的「---- 回复的原邮件 ----」+ 管道表格、
  // Outlook 的「-----原始邮件-----」、Gmail/Apple 的「On … wrote:」、「发件人：」、`>`、竖线。
  const cut = /^\s*(>|\||在\s.*(写道|寫道)|-{2,}.*(回复的原邮件|回覆的原郵件|回复的邮件|原始邮件|原始郵件|原邮件|原郵件|Original Message)|_{5,}|发件人[:：]|發件人[:：]|From:\s|On .* wrote:|Sent from my|------------------)/i
  const kept = []
  for (const line of lines) {
    if (cut.test(line)) break
    kept.push(line)
  }
  return kept.join('\n').trim()
}
