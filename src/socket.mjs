// 极简 TCP/TLS 行读取器：SMTP 与 IMAP 共用。
// 统一按 latin1 读——每个字符恰好等于一个字节，二进制字面量（IMAP literal）不会在解码时损坏；
// 需要真正解码时再由调用方转成 Buffer 按 charset 处理。
import net from 'node:net'
import tls from 'node:tls'

/**
 * 建立连接。
 * @param options - { host, port, secure, servername, timeoutMs }
 * @returns 已连接的 socket（latin1 编码）。
 */
export function connectSocket({ host, port, secure, servername, timeoutMs = 30_000 }) {
  return new Promise((resolve, reject) => {
    const socket = secure
      ? tls.connect({ host, port, servername: servername ?? host })
      : net.connect({ host, port })
    const fail = (error) => {
      socket.destroy()
      reject(error instanceof Error ? error : new Error(String(error)))
    }
    const timer = setTimeout(() => fail(new Error(`连接 ${host}:${port} 超时（${timeoutMs}ms）`)), timeoutMs)
    socket.once('error', (error) => {
      clearTimeout(timer)
      fail(error)
    })
    socket.once(secure ? 'secureConnect' : 'connect', () => {
      clearTimeout(timer)
      socket.setNoDelay(true)
      resolve(socket)
    })
  })
}

/**
 * 把 socket 包装成「按行/按字节读」的读取器，带失败传播与超时。
 * @param socket - 已连接 socket。
 * @param label - 错误信息里用的名字。
 * @returns { readLine, readBytes, detach }
 */
export function createReader(socket, label = 'socket') {
  socket.setEncoding('latin1')
  let buffer = ''
  let failure = null
  let wake = null

  const tick = () => {
    const resolve = wake
    wake = null
    resolve?.()
  }
  socket.on('data', (chunk) => {
    buffer += chunk
    tick()
  })
  socket.on('error', (error) => {
    failure = failure ?? error
    tick()
  })
  socket.on('close', () => {
    failure = failure ?? new Error(`${label} 连接已被对端关闭`)
    tick()
  })

  /** 等到有数据、出错，或过了 250ms（心跳，让超时与失败能被发现）。 */
  function waitTick() {
    return new Promise((resolve) => {
      wake = resolve
      setTimeout(() => {
        if (wake === resolve) tick()
      }, 250)
    })
  }

  async function pull(what, ready, timeoutMs) {
    const deadline = timeoutMs > 0 ? Date.now() + timeoutMs : 0
    for (;;) {
      if (failure) throw new Error(`${label} ${what} 失败：${failure.message}`)
      const value = ready()
      if (value !== undefined) return value
      if (deadline > 0 && Date.now() > deadline) throw new Error(`${label} 等待${what}超时（${timeoutMs}ms）`)
      await waitTick()
    }
  }

  return {
    /** 读一行（不含行尾）。 */
    readLine(timeoutMs = 30_000) {
      return pull('响应', () => {
        const index = buffer.indexOf('\n')
        if (index < 0) return undefined
        const line = buffer.slice(0, index)
        buffer = buffer.slice(index + 1)
        return line.endsWith('\r') ? line.slice(0, -1) : line
      }, timeoutMs)
    },
    /** 读 n 个字节（latin1 字符串，字符数 = 字节数）。 */
    readBytes(n, timeoutMs = 30_000) {
      return pull(`${n} 字节字面量`, () => {
        if (buffer.length < n) return undefined
        const text = buffer.slice(0, n)
        buffer = buffer.slice(n)
        return text
      }, timeoutMs)
    },
    detach() {
      socket.removeAllListeners('data')
      socket.removeAllListeners('error')
      socket.removeAllListeners('close')
    },
  }
}

/**
 * 写入一段协议文本（调用方自己带 CRLF）。
 * @param socket - 目标 socket。
 * @param text - 内容，按 latin1 逐字节写出。
 */
export function writeRaw(socket, text) {
  socket.write(Buffer.from(text, 'latin1'))
}
