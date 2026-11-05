// 离线回归：不联网、不登录，用假 SMTP / 假 IMAP 把整条链路跑一遍。
// 跑法：node test/run-tests.mjs（退出码 0 = 全过）
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startFakeSmtp, startFakeImap } from './servers.mjs'
import { buildMail, splitMessage, parseHeaders, parseMessage, encodeHeader, decodeWords, decodeTransfer, htmlToText, extractNewText } from '../src/mime.mjs'
import { newToken, extractTokens } from '../src/token.mjs'
import { screenHeaders, readDecision } from '../src/decision.mjs'
import { readSettings } from '../src/config.mjs'
import { sendMail } from '../src/mail-smtp.mjs'
import { MailboxWatcher } from '../src/mail-imap.mjs'
import { createAnswerer } from '../src/answerer.mjs'

const ADDRESS = 'sender@example.com'
let pass = 0
let fail = 0

function check(name, fn) {
  try {
    fn()
    pass += 1
    console.log(`  ok   ${name}`)
  } catch (error) {
    fail += 1
    console.log(`  FAIL ${name}\n       ${error?.message ?? error}`)
  }
}

async function checkAsync(name, fn) {
  try {
    await fn()
    pass += 1
    console.log(`  ok   ${name}`)
  } catch (error) {
    fail += 1
    console.log(`  FAIL ${name}\n       ${error?.message ?? error}`)
  }
}

function group(title) {
  console.log(`\n${title}`)
}

/** 等一个条件成立（测试里用来避免魔法 sleep）。 */
async function waitFor(predicate, { timeoutMs = 5000, stepMs = 20, what = '条件' } = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, stepMs))
  }
  throw new Error(`等待${what}超时（${timeoutMs}ms）`)
}

/** 造一封「回复」邮件：正文新写一句，后面跟着引用原文（两个示例都在里面，专门用来踩坑）。 */
function replyMessage({ uid, token, decision, from = ADDRESS, prefix = '[DSH 审批]', quote = true, plainSubject = false }) {
  const quoted = quote
    ? ['', `在 2026年11月5日 15:40，DSH 审批 <${ADDRESS}> 写道：`, `> 批准：回复正文写「同意 #${token}」`, `> 拒绝：回复正文写「拒绝 #${token}」`].join('\n')
    : ''
  const body = `${decision} #${token}\n${quoted}\n`
  const subject = `${plainSubject ? decision : 'Re:'} ${prefix} #${token} 需要你批准：bash`
  const header = [
    `From: DSH Approval <${from}>`,
    `To: <${ADDRESS}>`,
    `Subject: ${encodeHeader(subject)}`,
    `Message-ID: <reply-${uid}@163.com>`,
    `In-Reply-To: <notify-${token}@163.com>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
  ].join('\r\n')
  return { uid, header, body: Buffer.from(body, 'utf8').toString('base64') }
}

// ---------------------------------------------------------------- MIME

group('MIME 编解码')
check('纯 ASCII 主题不做编码', () => {
  assert.equal(encodeHeader('hello'), 'hello')
})
check('中文主题编码后能解回原文', () => {
  const original = '需要你批准：#a1b2c3d4'
  const encoded = encodeHeader(original)
  assert.match(encoded, /^=\?UTF-8\?B\?/)
  assert.equal(decodeWords(encoded), original)
})
check('RFC2047 的 Q 编码也能解', () => {
  assert.equal(decodeWords('=?utf-8?Q?=E5=90=8C=E6=84=8F?='), '同意')
})
check('裸 8bit 中文头（老客户端/8BITMIME）按 UTF-8 解', () => {
  const rawHeader = Buffer.from('DSH 审批 <a@b.com>', 'utf8').toString('latin1')
  assert.equal(decodeWords(rawHeader), 'DSH 审批 <a@b.com>')
})
check('quoted-printable 还原成字节', () => {
  assert.equal(decodeTransfer('=E5=90=8C=E6=84=8F', 'quoted-printable').toString('utf8'), '同意')
})
check('buildMail → 拆分 → 解析，中文不丢', () => {
  const mail = buildMail({
    from: ADDRESS, fromName: 'DSH 审批', to: ADDRESS,
    subject: '[DSH 审批] #deadbeef 需要你批准：bash',
    text: '正文：同意 #deadbeef', messageId: '<x@163.com>',
  })
  const { headerText, body } = splitMessage(mail)
  const headers = parseHeaders(headerText)
  assert.equal(headers.decoded('subject'), '[DSH 审批] #deadbeef 需要你批准：bash')
  assert.equal(headers.get('message-id'), '<x@163.com>')
  assert.match(parseMessage(headerText, body), /同意 #deadbeef/)
})
check('HTML 转纯文本', () => {
  assert.match(htmlToText('<p>同意&nbsp;#abc</p><br><div>拒绝</div>'), /同意 #abc/)
})
check('extractNewText 砍掉引用原文（在…写道）', () => {
  const text = `同意 #abc123\n\n在 2026年11月5日，DSH 写道：\n> 批准：写「同意 #abc123」\n> 拒绝：写「拒绝 #abc123」`
  assert.equal(extractNewText(text), '同意 #abc123')
})
check('extractNewText 砍掉「发件人：」式引用', () => {
  const text = '拒绝 #abc123\n\n发件人：DSH\n批准：写「同意 #abc123」'
  assert.equal(extractNewText(text), '拒绝 #abc123')
})
check('相邻 RFC2047 编码词之间的空白要丢掉（163 实测会把长主题切两段）', () => {
  const half1 = encodeHeader('回复：[DSH 审批] #40c10f')
  const half2 = encodeHeader('69 需要你批准： probe-mail')
  assert.equal(decodeWords(`${half1} ${half2}`), '回复：[DSH 审批] #40c10f69 需要你批准： probe-mail')
})
check('编码词与后面的地址之间那个空格必须留着', () => {
  assert.equal(decodeWords(`${encodeHeader('审批人')} <approver@example.com>`), '审批人 <approver@example.com>')
})
check('extractNewText 砍掉 163 的「---- 回复的原邮件 ----」+ 管道表格', () => {
  const text = [
    '拒绝 #40c10f69',
    '',
    '---- 回复的原邮件 ----',
    '| 发件人 | DSH 审批<sender@example.com> |',
    '| 主题 | [DSH 审批] #40c10f69 需要你批准：probe-mail |',
    '',
    '批准 → 正文写「同意 #40c10f69」',
    '拒绝 → 正文写「拒绝 #40c10f69」',
  ].join('\n')
  assert.equal(extractNewText(text), '拒绝 #40c10f69')
})

// ---------------------------------------------------------------- 令牌

group('令牌')
check('令牌是 8 位小写十六进制', () => {
  assert.match(newToken(), /^[0-9a-f]{8}$/)
})
check('抽取令牌并去重、保序', () => {
  assert.deepEqual(extractTokens('#aaaa1111 和 #bbbb2222 再 #aaaa1111'), ['aaaa1111', 'bbbb2222'])
})

// ---------------------------------------------------------------- 判定

group('回复判定')
const goodHeader = replyMessage({ uid: 1, token: 'aaaa1111', decision: '同意' }).header
check('自己发的通知不算回复（X-DSH-Approval: notify）', () => {
  const own = `From: ${ADDRESS}\r\nSubject: =?UTF-8?B?${Buffer.from('[DSH 审批] #aaaa1111 需要你批准：bash', 'utf8').toString('base64')}?=\r\nX-DSH-Approval: notify\r\n\r\n`
  assert.equal(screenHeaders(own, { address: ADDRESS }), null)
})
check('发件人不对直接丢', () => {
  assert.equal(screenHeaders(goodHeader.replace(ADDRESS, 'someone@example.com'), { address: ADDRESS }), null)
})
check('不是回复（没有 In-Reply-To、主题也没 Re:）直接丢', () => {
  const notReply = `From: ${ADDRESS}\r\nSubject: 随便聊聊\r\n\r\n`
  assert.equal(screenHeaders(notReply, { address: ADDRESS }), null)
})
check('正常回复能过第一道筛子', () => {
  const envelope = screenHeaders(goodHeader, { address: ADDRESS })
  assert.equal(envelope.from, ADDRESS)
  assert.match(envelope.subject, /#aaaa1111/)
})
check('同意 → allow', () => {
  const message = replyMessage({ uid: 2, token: 'aaaa1111', decision: '同意' })
  const result = readDecision({ headerText: message.header, bodyText: message.body, tokens: ['aaaa1111'] })
  assert.equal(result.token, 'aaaa1111')
  assert.equal(result.decision, 'allow')
})
check('拒绝 → deny', () => {
  const message = replyMessage({ uid: 3, token: 'bbbb2222', decision: '拒绝' })
  const result = readDecision({ headerText: message.header, bodyText: message.body, tokens: ['bbbb2222'] })
  assert.equal(result.decision, 'deny')
})
check('「不同意」判成拒绝（不会被「同意」二字骗过去）', () => {
  const message = replyMessage({ uid: 4, token: 'cccc3333', decision: '不同意' })
  const result = readDecision({ headerText: message.header, bodyText: message.body, tokens: ['cccc3333'] })
  assert.equal(result.decision, 'deny')
})
check('只有引用原文（没新写内容）→ 不判定', () => {
  const message = replyMessage({ uid: 5, token: 'dddd4444', decision: '' , quote: true })
  const result = readDecision({ headerText: message.header, bodyText: message.body, tokens: ['dddd4444'] })
  assert.equal(result.decision, null)
})
check('令牌不在待办里 → 不判定', () => {
  const message = replyMessage({ uid: 6, token: 'eeee5555', decision: '同意' })
  const result = readDecision({ headerText: message.header, bodyText: message.body, tokens: ['ffff6666'] })
  assert.equal(result.token, null)
})
check('正文空着、只在主题里写了结论 → 认主题', () => {
  const message = replyMessage({ uid: 7, token: 'aaaa8888', decision: '同意', plainSubject: true, quote: false })
  const result = readDecision({ headerText: message.header, bodyText: message.body, tokens: ['aaaa8888'] })
  assert.equal(result.decision, 'allow')
})
check('通知模板里的「需要你批准」不会被当成你的意思', () => {
  const token = 'bbbb9999'
  // 正文与主题都只有模板措辞，用户其实什么都没说。
  const header = `From: ${ADDRESS}\r\nSubject: ${encodeHeader(`Re: [DSH 审批] #${token} 需要你批准：bash`)}\r\nIn-Reply-To: <x@163.com>\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n`
  const body = Buffer.from('（已收到）\n', 'utf8').toString('base64')
  const result = readDecision({ headerText: header, bodyText: body, tokens: [token] })
  assert.equal(result.decision, null)
})
check('正文里同时出现同意与拒绝 → 不判定（等你重发）', () => {
  const token = 'abcd7777'
  const header = `From: ${ADDRESS}\r\nSubject: ${encodeHeader(`Re: #${token}`)}\r\nIn-Reply-To: <x@163.com>\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n`
  const body = Buffer.from(`同意 #${token}\n不过也可以拒绝 #${token}\n`, 'utf8').toString('base64')
  const result = readDecision({ headerText: header, bodyText: body, tokens: [token] })
  assert.equal(result.decision, null)
  assert.match(result.note, /既有同意也有拒绝/)
})

// ---------------------------------------------------------------- 真实 163 回复格式（照抄 2026-11-05 收到的真邮件）

/** 拼一封与 163 实测完全同形的回复：中文发件人名（裸 8bit）、主题被切成两个编码词、
 *  「回复：」前缀、multipart/alternative、引用区是「---- 回复的原邮件 ----」+ 管道表格。 */
function real163Reply({ token, decision, uid = 900 }) {
  const subjectHalf1 = `回复：[DSH 审批] #${token.slice(0, 6)}`
  const subjectHalf2 = `${token.slice(6)} 需要你批准： probe-mail`
  const template = [
    'DSH 需要你批准一次操作。',
    '',
    `令牌：#${token}`,
    '',
    '| 工具 | probe-mail |',
    '| 原因 | 连通性测试（不是真的审批请求） |',
    '',
    '直接回复本邮件即可决定：',
    '',
    `批准 → 正文写「同意 #${token}」`,
    `拒绝 → 正文写「拒绝 #${token}」`,
  ].join('\n')
  const plain = [
    `${decision} #${token}`,
    '',
    '---- 回复的原邮件 ----',
    '| 发件人 | DSH 审批<sender@example.com> |',
    `| 主题 | [DSH 审批] #${token} 需要你批准：probe-mail |`,
    '',
    template,
  ].join('\n')
  const boundary = '----=_Part_2784412_721491841.1793865483897'
  const header = [
    `From: ${Buffer.from('审批人（Approver）', 'utf8').toString('latin1')} <approver@example.com>`,
    'To: sender <sender@example.com>',
    `Subject: ${encodeHeader(subjectHalf1)} ${encodeHeader(subjectHalf2)}`,
    `Message-ID: <reply-${uid}@163.com>`,
    `In-Reply-To: <dsh-approval-abc@163.com>`,
    `References: <dsh-approval-abc@163.com>`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative;  boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset="utf-8"',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(plain, 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n'),
    `--${boundary}`,
    'Content-Type: text/html; charset="utf-8"',
    'Content-Transfer-Encoding: quoted-printable',
    '',
    `<div>${decision} #${token}</div>`,
    `--${boundary}--`,
    '',
  ].join('\r\n')
  // 与 IMAP 一致：header 段与 body 段是分开取回来的。
  const { headerText, body: bodyText } = splitMessage(header)
  return { uid, headerText, bodyText }
}

group('真实 163 回复格式（照抄实测邮件）')
check('主题被切成两个编码词时，令牌仍能完整取出', () => {
  const message = real163Reply({ token: '40c10f69', decision: '同意' })
  const envelope = screenHeaders(message.headerText, { address: 'sender@example.com', allowFrom: ['approver@example.com'] })
  assert.equal(envelope.from, 'approver@example.com')
  assert.match(envelope.subject, /#40c10f69/, '主题里的令牌必须完整，不能被空格切开')
  assert.match(envelope.subject, /^回复：/, '「回复：」前缀要认得出这是回复')
})
check('同意 → allow（引用区里的模板不能被算作你的意思）', () => {
  const message = real163Reply({ token: '40c10f69', decision: '同意' })
  const result = readDecision({ headerText: message.headerText, bodyText: message.bodyText, tokens: ['40c10f69'] })
  assert.equal(result.token, '40c10f69')
  assert.equal(result.decision, 'allow')
})
check('拒绝 → deny（这是之前会被引用区里的「同意」污染成歧义的场景）', () => {
  const message = real163Reply({ token: '40c10f69', decision: '拒绝' })
  const result = readDecision({ headerText: message.headerText, bodyText: message.bodyText, tokens: ['40c10f69'] })
  assert.equal(result.decision, 'deny', `实测格式下拒绝必须判成 deny，实际 note=${result.note}`)
})

group('配置')
check('缺授权码要报错', () => {
  assert.throws(() => readSettings({ address: ADDRESS }), /授权码/)
})
check('地址不合法要报错', () => {
  assert.throws(() => readSettings({ address: 'not-an-address', authCode: 'x' }), /邮箱地址/)
})
check('163 默认值正确', () => {
  const settings = readSettings({ address: ADDRESS, authCode: 'x' })
  assert.equal(settings.smtp.host, 'smtp.163.com')
  assert.equal(settings.smtp.port, 465)
  assert.equal(settings.imap.host, 'imap.163.com')
  assert.equal(settings.imap.port, 993)
  assert.equal(settings.waitMs, 0)
})

// ---------------------------------------------------------------- 联调（假服务器）

const scratch = mkdtempSync(join(tmpdir(), 'dsh-approval-'))

await checkAsync('SMTP：整封邮件发得出去，主题/自定义头/正文都对', async () => {
  const smtp = await startFakeSmtp()
  try {
    const token = 'aa11bb22'
    const mail = buildMail({
      from: ADDRESS, fromName: 'DSH 审批', to: ADDRESS,
      subject: `[DSH 审批] #${token} 需要你批准：bash`,
      text: `批准：回复正文写「同意 #${token}」`,
      messageId: '<notify-1@163.com>',
      extraHeaders: { 'X-DSH-Approval': 'notify' },
    })
    await sendMail({
      host: '127.0.0.1', port: smtp.port, secure: false,
      user: ADDRESS, pass: 'auth-code', from: ADDRESS, fromName: 'DSH 审批', to: ADDRESS,
      subject: `[DSH 审批] #${token} 需要你批准：bash`,
      text: `批准：回复正文写「同意 #${token}」`,
      messageId: '<notify-1@163.com>',
      extraHeaders: { 'X-DSH-Approval': 'notify' },
    })
    assert.equal(smtp.messages.length, 1, '服务端应收到 1 封')
    assert.ok(smtp.commands.some((line) => /^AUTH LOGIN/i.test(line)), '应走 AUTH LOGIN')
    const { headerText, body } = splitMessage(smtp.messages[0])
    const headers = parseHeaders(headerText)
    assert.equal(headers.get('x-dsh-approval'), 'notify')
    assert.equal(headers.decoded('subject'), `[DSH 审批] #${token} 需要你批准：bash`)
    assert.match(parseMessage(headerText, body), new RegExp(`同意 #${token}`))
    assert.ok(mail.length > 0)
  } finally {
    await smtp.close()
  }
})

await checkAsync('IMAP：只认水位线之后的新邮件，无关邮件只读 header', async () => {
  const imap = await startFakeImap({ uidNext: 100 })
  imap.push(replyMessage({ uid: 100, token: 'aa11bb22', decision: '同意' }))
  imap.push({
    uid: 101,
    header: 'From: someone@example.com\r\nSubject: 广告\r\n\r\n',
    body: Buffer.from('买点什么', 'utf8').toString('base64'),
  })
  const watcher = new MailboxWatcher({ host: '127.0.0.1', port: imap.port, secure: false, user: ADDRESS, authCode: 'x', mailbox: 'INBOX', log: () => {} })
  try {
    const first = await watcher.poll({ filter: (headerText) => screenHeaders(headerText, { address: ADDRESS }) !== null })
    assert.equal(first.length, 1, '只有那封回复该被返回')
    assert.equal(first[0].uid, 100)
    assert.match(first[0].headerText, /In-Reply-To/)
    assert.equal(watcher.lastUid, 101, '水位线要推进到 101，避免下一轮重扫')
    const second = await watcher.poll()
    assert.equal(second.length, 0, '没有新邮件时不该重复返回')
    assert.ok(imap.seen.some((line) => /^ID \(/i.test(line)), '163 要求的 ID 命令必须发出去')
  } finally {
    await watcher.close()
    await imap.close()
  }
})

await checkAsync('IMAP：服务端不给 UIDNEXT（163 实测如此）时，水位线取现有最大 UID', async () => {
  const imap = await startFakeImap({
    uidNext: 100,
    omitUidNext: true, // SELECT 与 STATUS 都不给 UIDNEXT，只能 UID SEARCH ALL
    messages: [
      { uid: 100, header: 'From: old@example.com\r\nSubject: 旧邮件\r\n\r\n', body: '' },
      { uid: 101, header: 'From: old@example.com\r\nSubject: 旧邮件2\r\n\r\n', body: '' },
    ],
  })
  const watcher = new MailboxWatcher({ host: '127.0.0.1', port: imap.port, secure: false, user: ADDRESS, authCode: 'x', mailbox: 'INBOX', log: () => {} })
  try {
    const before = await watcher.poll()
    assert.equal(before.length, 0, '历史邮件不该被当成新邮件')
    assert.equal(watcher.lastUid, 101, '水位线应等于现有最大 UID')
    imap.push(replyMessage({ uid: 102, token: 'aa11cc22', decision: '同意' }))
    const after = await watcher.poll({ filter: (headerText) => screenHeaders(headerText, { address: ADDRESS }) !== null })
    assert.equal(after.length, 1)
    assert.equal(after[0].uid, 102, '只该返回新到的那一封')
  } finally {
    await watcher.close()
    await imap.close()
  }
})

await checkAsync('端到端：邮件回复先到 → allowed-once', async () => {
  const smtp = await startFakeSmtp()
  const imap = await startFakeImap({ uidNext: 100 })
  const settings = readSettings({
    address: ADDRESS, authCode: 'x',
    smtp: { host: '127.0.0.1', port: smtp.port, secure: false },
    imap: { host: '127.0.0.1', port: imap.port, secure: false },
    pollIntervalMs: 30,
    auditFile: join(scratch, 'audit.jsonl'),
  })
  const answerer = createAnswerer({
    settings,
    deps: { sendMail, createWatcher: (options) => new MailboxWatcher(options), log: () => {}, auditFile: join(scratch, 'audit.jsonl') },
  })
  try {
    const answer = answerer.handle(
      { toolName: 'bash', reason: 'grantWrite(P:\\tmp)', callId: 'call_1', agent: { id: 'agent_1', session: { id: 'session_1' } } },
      () => new Promise(() => {}), // 界面那条路永远不回：只能靠邮件
    )
    await waitFor(() => smtp.messages.length === 1, { what: '通知邮件发出' })
    const { headerText } = splitMessage(smtp.messages[0])
    const token = extractTokens(parseHeaders(headerText).decoded('subject'))[0]
    assert.match(token, /^[0-9a-f]{8}$/)
    imap.push(replyMessage({ uid: 100, token, decision: '同意' }))
    const outcome = await Promise.race([
      answer,
      new Promise((resolve) => setTimeout(() => resolve('TIMEOUT'), 6000)),
    ])
    assert.equal(outcome, 'allowed-once')
    assert.equal(answerer.pendingCount(), 0, '结论落地后待办要清空')
    const auditFile = join(scratch, 'audit.jsonl')
    await waitFor(
      () => existsSync(auditFile) && readFileSync(auditFile, 'utf8').includes('"kind":"decided"'),
      { what: '审计里出现 decided 记录' },
    )
  } finally {
    await answerer.stop()
    await smtp.close()
    await imap.close()
  }
})

await checkAsync('端到端：界面先点 → 界面结论说了算，待办清空', async () => {
  const smtp = await startFakeSmtp()
  const imap = await startFakeImap({ uidNext: 100 })
  const settings = readSettings({
    address: ADDRESS, authCode: 'x',
    smtp: { host: '127.0.0.1', port: smtp.port, secure: false },
    imap: { host: '127.0.0.1', port: imap.port, secure: false },
    pollIntervalMs: 30,
    auditFile: join(scratch, 'audit2.jsonl'),
  })
  const answerer = createAnswerer({
    settings,
    deps: { sendMail, createWatcher: (options) => new MailboxWatcher(options), log: () => {}, auditFile: join(scratch, 'audit2.jsonl') },
  })
  try {
    const outcome = await answerer.handle(
      { toolName: 'bash', reason: '测试', agent: { id: 'a', session: { id: 's' } } },
      () => Promise.resolve('rejected'),
    )
    assert.equal(outcome, 'rejected')
    assert.equal(answerer.pendingCount(), 0)
  } finally {
    await answerer.stop()
    await smtp.close()
    await imap.close()
  }
})

await checkAsync('邮件发不出去时不能误放行：结论仍来自界面', async () => {
  const settings = readSettings({
    address: ADDRESS, authCode: 'x',
    smtp: { host: '127.0.0.1', port: 1, secure: false },   // 打不通的端口
    imap: { host: '127.0.0.1', port: 1, secure: false },
    pollIntervalMs: 30,
    auditFile: join(scratch, 'audit3.jsonl'),
  })
  const answerer = createAnswerer({
    settings,
    deps: { sendMail, createWatcher: (options) => new MailboxWatcher(options), log: () => {}, auditFile: join(scratch, 'audit3.jsonl') },
  })
  try {
    const outcome = await Promise.race([
      answerer.handle({ toolName: 'bash', agent: { session: { id: 's' } } }, () => Promise.resolve('allowed-once')),
      new Promise((resolve) => setTimeout(() => resolve('TIMEOUT'), 6000)),
    ])
    assert.equal(outcome, 'allowed-once')
  } finally {
    await answerer.stop()
  }
})

await checkAsync('仅通知模式：只发信，不参与放行', async () => {
  const smtp = await startFakeSmtp()
  const settings = readSettings({
    address: ADDRESS, authCode: 'x',
    smtp: { host: '127.0.0.1', port: smtp.port, secure: false },
    imap: { host: '127.0.0.1', port: 1, secure: false },
    notifyOnly: true,
    auditFile: join(scratch, 'audit4.jsonl'),
  })
  const answerer = createAnswerer({
    settings,
    deps: { sendMail, createWatcher: (options) => new MailboxWatcher(options), log: () => {}, auditFile: join(scratch, 'audit4.jsonl') },
  })
  try {
    const outcome = await answerer.handle({ toolName: 'bash', agent: { session: { id: 's' } } }, () => Promise.resolve('rejected'))
    assert.equal(outcome, 'rejected')
    await waitFor(() => smtp.messages.length === 1, { what: '通知邮件发出' })
    assert.equal(answerer.pendingCount(), 0)
  } finally {
    await answerer.stop()
    await smtp.close()
  }
})

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`)
if (fail > 0) process.exitCode = 1
else console.log('全部通过')
