// 离线替身：假 SMTP 服务端 + 假 IMAP 服务端。
// 只在测试里用，不联网、不登录，用来把「发信 / 收信 / 认令牌」整条链路跑通。
import net from 'node:net'

/** 一律按 latin1 逐字节写出：声明 {n} 字面量长度时才能与实际字节数一致（真实服务器就是这么做的）。 */
function send(socket, text) {
  socket.write(Buffer.from(text, 'latin1'))
}

function raw(socket, buffer) {
  socket.write(buffer)
}

/** 假 SMTP：按最小 RFC5321 对话，把 DATA 内容存起来。 */
export async function startFakeSmtp({ log = () => {} } = {}) {
  const messages = []
  const commands = []
  const server = net.createServer((socket) => {
    socket.setEncoding('latin1')
    let buffer = ''
    let inData = false
    let current = ''
    socket.write('220 fake ESMTP\r\n')
    socket.on('data', (chunk) => {
      buffer += chunk
      for (;;) {
        const index = buffer.indexOf('\r\n')
        if (index < 0) break
        const line = buffer.slice(0, index)
        buffer = buffer.slice(index + 2)
        if (inData) {
          if (line === '.') {
            inData = false
            messages.push(current.replace(/\r\n\.\./g, '\r\n.'))
            current = ''
            socket.write('250 OK queued\r\n')
          } else {
            current += `${line}\r\n`
          }
          continue
        }
        commands.push(line)
        const upper = line.toUpperCase()
        if (upper.startsWith('EHLO') || upper.startsWith('HELO')) socket.write('250-fake\r\n250-AUTH LOGIN PLAIN\r\n250 OK\r\n')
        else if (upper.startsWith('AUTH LOGIN')) socket.write('334 VXNlcm5hbWU6\r\n')
        else if (upper.startsWith('AUTH PLAIN')) socket.write('235 OK\r\n')
        else if (upper === 'DATA') {
          inData = true
          socket.write('354 开始\r\n')
        } else if (upper.startsWith('QUIT')) {
          socket.write('221 bye\r\n')
          socket.end()
        } else if (/^(MAIL FROM|RCPT TO)/.test(upper)) socket.write('250 OK\r\n')
        else if (/^[A-Za-z0-9+/=]+$/.test(line)) socket.write('235 OK\r\n')
        else socket.write('250 OK\r\n')
      }
    })
    socket.on('error', () => {})
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    port: server.address().port,
    messages,
    commands,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

/**
 * 假 IMAP：认得 LOGIN / ID / SELECT / UID SEARCH / UID FETCH / NOOP / LOGOUT。
 * @param options.messages - 初始邮件 [{ uid, header, body }]；header/body 都是原始（latin1）文本。
 * @param options.uidNext - SELECT 里报的 UIDNEXT。
 */
export async function startFakeImap({ messages = [], uidNext = 100, omitUidNext = false } = {}) {
  const store = [...messages]
  const seen = []
  const server = net.createServer((socket) => {
    socket.setEncoding('latin1')
    let buffer = ''
    socket.write('* OK [CAPABILITY IMAP4rev1 ID] fake ready\r\n')
    socket.on('data', (chunk) => {
      buffer += chunk
      for (;;) {
        const index = buffer.indexOf('\r\n')
        if (index < 0) break
        const line = buffer.slice(0, index)
        buffer = buffer.slice(index + 2)
        const [, tag, rest] = /^(\S+)\s+([\s\S]*)$/.exec(line) ?? []
        if (tag === undefined) continue
        seen.push(rest)
        const upper = rest.toUpperCase()
        if (upper.startsWith('LOGIN')) socket.write(`${tag} OK LOGIN completed\r\n`)
        else if (upper.startsWith('ID')) socket.write(`* ID ("name" "fake" "version" "1")\r\n${tag} OK ID completed\r\n`)
        else if (upper.startsWith('SELECT')) {
          socket.write(`* ${store.length} EXISTS\r\n`)
          socket.write('* OK [UIDVALIDITY 1] UIDs valid\r\n')
          // 163 就是这样：SELECT 里根本没有 UIDNEXT。
          if (!omitUidNext) socket.write(`* OK [UIDNEXT ${uidNext}] Predicted next UID\r\n`)
          socket.write(`${tag} OK [READ-WRITE] SELECT completed\r\n`)
        } else if (upper.startsWith('STATUS')) {
          // 163 的 STATUS 只回 MESSAGES，不回 UIDNEXT。
          const extra = omitUidNext ? '' : ` UIDNEXT ${uidNext}`
          socket.write(`* STATUS "INBOX" (MESSAGES ${store.length}${extra})\r\n`)
          socket.write(`${tag} OK STATUS completed\r\n`)
        } else if (upper.startsWith('UID SEARCH ALL')) {
          const uids = store.map((item) => item.uid)
          socket.write(`* SEARCH${uids.length === 0 ? '' : ` ${uids.join(' ')}`}\r\n`)
          socket.write(`${tag} OK SEARCH completed\r\n`)
        } else if (upper.startsWith('UID SEARCH')) {
          const from = Number((/UID\s+(\d+):\*/.exec(upper) ?? [])[1] ?? 1)
          const uids = store.filter((item) => item.uid >= from).map((item) => item.uid)
          socket.write(`* SEARCH${uids.length === 0 ? '' : ` ${uids.join(' ')}`}\r\n`)
          socket.write(`${tag} OK SEARCH completed\r\n`)
        } else if (upper.startsWith('UID FETCH')) {
          const uid = Number((/UID FETCH (\d+)/i.exec(rest) ?? [])[1])
          const item = store.find((entry) => entry.uid === uid)
          const section = /BODY\.PEEK\[(\w+)\]/i.exec(rest)?.[1]?.toUpperCase()
          const payload = item === undefined ? '' : section === 'TEXT' ? item.body : item.header
          const bytes = Buffer.from(payload, 'latin1')
          send(socket, `* 1 FETCH (UID ${uid} BODY[${section}] {${bytes.length}}\r\n`)
          raw(socket, bytes)
          send(socket, ')\r\n')
          send(socket, `${tag} OK FETCH completed\r\n`)
        } else if (upper.startsWith('NOOP')) socket.write(`${tag} OK NOOP completed\r\n`)
        else if (upper.startsWith('LOGOUT')) {
          socket.write(`* BYE\r\n${tag} OK LOGOUT completed\r\n`)
          socket.end()
        } else socket.write(`${tag} BAD unknown\r\n`)
      }
    })
    socket.on('error', () => {})
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    port: server.address().port,
    seen,
    /** 模拟「新邮件到达」。 */
    push(message) {
      store.push(message)
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}
