// 零依赖 IMAP 客户端 + 收件箱观察者。
// 只用到四件事：登录（163 登录后必须发 ID，否则后续命令报 Unsafe Login）、
// SELECT 拿 UIDNEXT、UID SEARCH 找新邮件、UID FETCH 取 header/text。
// 统一用 BODY.PEEK，不把你在邮箱里的邮件标成已读。
import { connectSocket, createReader, writeRaw } from './socket.mjs'

const quote = (text) => `"${String(text).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`

/** 从 `* SEARCH 1 2 3` 里取出 UID 列表（去重升序）。 */
function parseSearchUids(lines) {
  const uids = []
  for (const line of lines) {
    const match = /^\*\s+SEARCH\s*(.*)$/i.exec(line)
    if (match === null) continue
    for (const piece of match[1].trim().split(/\s+/)) {
      const uid = Number(piece)
      if (Number.isFinite(uid) && uid > 0) uids.push(uid)
    }
  }
  return [...new Set(uids)].sort((a, b) => a - b)
}

export class ImapClient {
  #socket
  #reader
  #seq = 0

  constructor(socket, reader) {
    this.#socket = socket
    this.#reader = reader
  }

  /**
   * 建立 TCP/TLS 连接并读掉服务端问候。
   * @param options - { host, port, secure }
   */
  static async connect({ host, port, secure = true }) {
    const socket = await connectSocket({ host, port, secure })
    const reader = createReader(socket, 'IMAP')
    const client = new ImapClient(socket, reader)
    const greeting = await reader.readLine()
    if (!/^\*\s+(OK|PREAUTH)/i.test(greeting)) {
      client.close()
      throw new Error(`IMAP 问候异常：${greeting.slice(0, 200)}`)
    }
    return client
  }

  /** 读一条完整的命令应答，处理 `{n}` 字面量（把二进制按占位符留在行里）。 */
  async #readUntil(tag) {
    const lines = []
    const literals = []
    const done = new RegExp(`^${tag}\\s+(OK|NO|BAD)`, 'i')
    for (;;) {
      let line = await this.#reader.readLine()
      let literal = /\{(\d+)\}$/.exec(line)
      while (literal !== null) {
        const bytes = await this.#reader.readBytes(Number(literal[1]))
        literals.push(bytes)
        line += `\u0000${literals.length - 1}\u0000`
        const rest = await this.#reader.readLine()
        line += rest
        literal = /\{(\d+)\}$/.exec(rest)
      }
      lines.push(line)
      const done_ = done.exec(line)
      if (done_ !== null) {
        return { status: done_[1].toUpperCase(), lines, literals, text: lines.join('\n') }
      }
    }
  }

  /** 发一条命令；服务器回 NO/BAD 就抛错（错误里带服务器原话）。 */
  async command(text) {
    const tag = `a${++this.#seq}`
    writeRaw(this.#socket, `${tag} ${text}\r\n`)
    const response = await this.#readUntil(tag)
    if (response.status !== 'OK') {
      const error = new Error(`IMAP ${text.split(' ')[0]} 失败（${response.status}）：${response.lines.join(' | ').slice(0, 500)}`)
      error.status = response.status
      throw error
    }
    return response
  }

  async login(user, pass) {
    return this.command(`LOGIN ${quote(user)} ${quote(pass)}`)
  }

  /**
   * 163/126 的硬性要求：登录后发一条 ID，声明客户端身份；不发就报 Unsafe Login。
   * 不支持 ID 的服务器会回 BAD，这里吞掉。
   */
  async identify(name = 'dsh-email-approval', version = '1.0.0') {
    try {
      await this.command(`ID ("name" ${quote(name)} "version" ${quote(version)} "vendor" "deepseek-harness")`)
      return true
    } catch {
      return false
    }
  }

  /** 选中邮箱，返回 { exists, uidNext, uidValidity }。 */
  async select(mailbox = 'INBOX') {
    const response = await this.command(`SELECT ${quote(mailbox)}`)
    const text = response.text
    const exists = Number((/\*\s+(\d+)\s+EXISTS/i.exec(text) ?? [])[1] ?? 0)
    const uidNext = Number((/\[UIDNEXT\s+(\d+)\]/i.exec(text) ?? [])[1] ?? 0)
    const uidValidity = Number((/\[UIDVALIDITY\s+(\d+)\]/i.exec(text) ?? [])[1] ?? 0)
    return { exists, uidNext, uidValidity }
  }

  /** 找 UID >= fromUid 的邮件（升序）。 */
  async searchFromUid(fromUid) {
    const response = await this.command(`UID SEARCH UID ${Math.max(1, Math.floor(fromUid))}:*`)
    return parseSearchUids(response.lines)
  }

  /** 列出邮箱里现有的全部 UID（升序）。163 不给 UIDNEXT 时靠它取水位线。 */
  async searchAll() {
    const response = await this.command('UID SEARCH ALL')
    return parseSearchUids(response.lines)
  }

  /**
   * 问服务端要 UIDNEXT。
   * 注意：163 的 STATUS 只回 MESSAGES，不给 UIDNEXT，所以拿不到就返回 0，由调用方兜底。
   */
  async statusUidNext(mailbox = 'INBOX') {
    const response = await this.command(`STATUS ${quote(mailbox)} (UIDNEXT MESSAGES)`)
    const uidNext = Number((/UIDNEXT\s+(\d+)/i.exec(response.text) ?? [])[1] ?? 0)
    return Number.isFinite(uidNext) ? uidNext : 0
  }

  /** 取某个段（HEADER / TEXT）的原始字节（latin1 字符串）。 */
  async fetchSection(uid, section) {
    const response = await this.command(`UID FETCH ${uid} (BODY.PEEK[${section}])`)
    const headerLine = response.lines.find((line) => /\u0000\d+\u0000/.test(line) || /BODY\[/i.test(line))
    const index = headerLine === undefined ? -1 : Number((/\u0000(\d+)\u0000/.exec(headerLine) ?? [])[1] ?? -1)
    if (index >= 0) return response.literals[index] ?? ''
    // 没有字面量：可能是空正文，或服务器把内容塞在引号里。
    const inline = headerLine === undefined ? undefined : /BODY\[[^\]]*\]\s+"([\s\S]*)"/i.exec(headerLine)
    return inline === null || inline === undefined ? response.literals[0] ?? '' : inline[1]
  }

  async noop() {
    return this.command('NOOP')
  }

  async logout() {
    try {
      await this.command('LOGOUT')
    } catch {
      /* 已经断了就算了 */
    }
    this.close()
  }

  close() {
    this.#reader?.detach()
    this.#socket?.destroy()
  }
}

/**
 * 收件箱观察者：保持一条长连接，按 UID 水位线增量拉新邮件。
 * 断线自动重连，水位线不丢（不会重复处理旧邮件）。
 */
export class MailboxWatcher {
  #settings
  #client = null
  #lastUid = -1
  #uidValidity = 0

  constructor(settings) {
    this.#settings = settings
  }

  get lastUid() {
    return this.#lastUid
  }

  /**
   * 取「从现在开始」的水位线：只关心之后到达的新邮件，历史邮件一概不碰。
   * 163 的 SELECT 不返回 UIDNEXT、STATUS 也只回 MESSAGES，所以三级兜底：
   * SELECT 的 UIDNEXT → STATUS 的 UIDNEXT → 直接问现有邮件的最大 UID。
   * @param client - 已登录并选中邮箱的连接。
   * @param state - select() 的结果。
   * @returns 水位线 UID（没有邮件时为 0）。
   */
  async #baseline(client, state) {
    if (state.uidNext > 0) return state.uidNext - 1
    try {
      const fromStatus = await client.statusUidNext(this.#settings.mailbox)
      if (fromStatus > 0) {
        this.#settings.log('（服务端不给 SELECT 的 UIDNEXT，改用 STATUS）')
        return fromStatus - 1
      }
    } catch {
      /* STATUS 不可用就继续往下兜底 */
    }
    const uids = await client.searchAll()
    const highest = uids.length === 0 ? 0 : uids[uids.length - 1]
    this.#settings.log(`（服务端不给 UIDNEXT，改用现有最大 UID ${highest} 作水位线，共 ${uids.length} 封历史邮件）`)
    return highest
  }

  async #connect() {
    const { host, port, secure, user, authCode, mailbox, log } = this.#settings
    const client = await ImapClient.connect({ host, port, secure })
    try {
      await client.login(user, authCode)
      await client.identify()
      const state = await client.select(mailbox)
      if (this.#lastUid < 0) {
        this.#lastUid = await this.#baseline(client, state)
        this.#uidValidity = state.uidValidity
        log(`IMAP 已就绪（${mailbox}，现 ${state.exists} 封，水位线 UID ${this.#lastUid}）`)
      } else if (this.#uidValidity !== 0 && state.uidValidity !== 0 && this.#uidValidity !== state.uidValidity) {
        // UID 失效（邮箱被重建）：只能重新取水位线，避免把整个邮箱重扫一遍。
        log(`IMAP UIDVALIDITY 变化（${this.#uidValidity} → ${state.uidValidity}），水位线重置`)
        this.#lastUid = await this.#baseline(client, state)
        this.#uidValidity = state.uidValidity
      }
      this.#client = client
      return client
    } catch (error) {
      client.close()
      throw error
    }
  }

  /**
   * 拉一次新邮件。
   * @param options.filter - (headerText) => boolean，只有通过的消息才下载正文。
   * @returns 新消息数组 [{ uid, headerText, bodyText }]（升序）。
   */
  async poll({ filter = () => true } = {}) {
    let client = this.#client
    if (client === null) client = await this.#connect()

    const messages = []
    try {
      const uids = (await client.searchFromUid(this.#lastUid + 1)).filter((uid) => uid > this.#lastUid)
      for (const uid of uids) {
        const headerText = await client.fetchSection(uid, 'HEADER')
        if (filter(headerText)) {
          const bodyText = await client.fetchSection(uid, 'TEXT')
          messages.push({ uid, headerText, bodyText })
        }
        this.#lastUid = Math.max(this.#lastUid, uid)
      }
      await client.noop()
      return messages
    } catch (error) {
      // 连接坏了：关掉，下一轮重建；水位线保留。
      client.close()
      this.#client = null
      throw error
    }
  }

  async close() {
    const client = this.#client
    this.#client = null
    if (client !== null) await client.logout()
  }
}
