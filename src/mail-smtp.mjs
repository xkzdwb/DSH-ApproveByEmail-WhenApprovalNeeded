// 零依赖 SMTP 客户端：EHLO → (可选 STARTTLS) → AUTH LOGIN/PLAIN → MAIL/RCPT/DATA → QUIT。
// 163 用 465 隐式 TLS，所以默认 secure: true；STARTTLS 分支留给别的邮箱。
import { once } from 'node:events'
import tls from 'node:tls'
import { hostname } from 'node:os'
import { connectSocket, createReader, writeRaw } from './socket.mjs'
import { buildMail } from './mime.mjs'

/** 读一条（可能多行的）SMTP 应答；4xx/5xx 直接抛错。 */
async function readResponse(reader, label) {
  const lines = []
  for (;;) {
    const line = await reader.readLine()
    lines.push(line)
    if (/^\d{3}(?:[ ]|$)/.test(line)) {
      const code = Number(line.slice(0, 3))
      if (code >= 400) {
        const error = new Error(`${label} 被服务器拒绝（${code}）：${lines.join(' | ').slice(0, 500)}`)
        error.code = code
        throw error
      }
      return { code, lines }
    }
  }
}

/** 发一条命令并读回应答。 */
async function command(socket, reader, label, line) {
  writeRaw(socket, `${line}\r\n`)
  return readResponse(reader, label)
}

const base64 = (text) => Buffer.from(text, 'utf8').toString('base64')

/**
 * 发一封邮件。
 * @param options - 连接与内容参数（字段见 README 配置表）。
 * @returns { messageId }
 */
export async function sendMail({
  host, port, secure = true, starttls = false,
  user, pass, from, fromName, to, subject, text, html,
  messageId, extraHeaders = {}, log = () => {},
}) {
  let socket = await connectSocket({ host, port, secure })
  let reader = createReader(socket, 'smtp')
  const label = 'SMTP'
  const ehloName = hostname() || 'dsh.local'

  try {
    await readResponse(reader, `${label} 问候`)
    const ehlo = await command(socket, reader, `${label} EHLO`, `EHLO ${ehloName}`)
    let capabilities = ehlo.lines.join(' ')

    if (!secure && starttls) {
      if (!/STARTTLS/i.test(capabilities)) throw new Error('服务器未声明 STARTTLS，无法加密发信')
      await command(socket, reader, `${label} STARTTLS`, 'STARTTLS')
      reader.detach()
      socket = tls.connect({ socket, servername: host })
      await once(socket, 'secureConnect')
      reader = createReader(socket, 'smtp')
      const again = await command(socket, reader, `${label} EHLO(TLS)`, `EHLO ${ehloName}`)
      capabilities = again.lines.join(' ')
    }

    // AUTH：163 认 LOGIN；失败时退回 PLAIN（有的邮箱只开 PLAIN）。
    try {
      await command(socket, reader, `${label} AUTH LOGIN`, 'AUTH LOGIN')
      await command(socket, reader, `${label} 用户名`, base64(user))
      await command(socket, reader, `${label} 授权码`, base64(pass))
    } catch (error) {
      log(`${label} AUTH LOGIN 失败（${error.code ?? '?'}），改用 AUTH PLAIN 重试`)
      await command(socket, reader, `${label} AUTH PLAIN`, `AUTH PLAIN ${base64(`\u0000${user}\u0000${pass}`)}`)
    }
    if (!/AUTH/i.test(capabilities)) log(`${label} 服务器未声明 AUTH，仍按 163 的默认走 LOGIN`)

    await command(socket, reader, `${label} MAIL FROM`, `MAIL FROM:<${from}>`)
    await command(socket, reader, `${label} RCPT TO`, `RCPT TO:<${to}>`)
    await command(socket, reader, `${label} DATA`, 'DATA')

    const mail = buildMail({ from, fromName, to, subject, text, html, messageId, extraHeaders })
    // 行首的 `.` 要转义（base64 正文里不会出现，但正文换行处仍按规范处理）。
    const stuffed = mail.replace(/\r?\n\./g, '\r\n..')
    const terminator = stuffed.endsWith('\r\n') ? '' : '\r\n'
    writeRaw(socket, `${stuffed}${terminator}.\r\n`)
    await readResponse(reader, `${label} 投递结果`)

    try {
      await command(socket, reader, `${label} QUIT`, 'QUIT')
    } catch {
      /* QUIT 失败无所谓，信已经被收下 */
    }
    return { messageId }
  } finally {
    reader.detach()
    socket.destroy()
  }
}
