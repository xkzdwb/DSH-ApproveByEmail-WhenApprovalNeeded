// 配置读取：把 profile patch 里的 config（可能是 cordis 的即时引用）拍成普通对象，
// 再叠加 secrets 文件（授权码不进 yml，日志里也永不出现）。
import { readFileSync } from 'node:fs'

/** 163 邮箱的默认服务器参数（本插件就是为它写的，别的邮箱改这几项即可）。 */
const DEFAULT_SMTP = { host: 'smtp.163.com', port: 465, secure: true, starttls: false }
const DEFAULT_IMAP = { host: 'imap.163.com', port: 993, secure: true, mailbox: 'INBOX' }

export const DEFAULTS = {
  address: '',                 // 发信/收信的邮箱账号（自收自发时也就是收件人）
  to: '',                      // 收件人；留空 = 发给 address（想「用 A 发给 B」就在这里写 B）
  displayName: 'DSH 审批',
  subjectPrefix: '[DSH 审批]',
  secretsFile: '',             // 放授权码的 JSON 文件；也可直接在 config 里写 authCode
  authCode: '',
  smtp: DEFAULT_SMTP,
  imap: DEFAULT_IMAP,
  pollIntervalMs: 5000,        // 收信箱轮询间隔
  waitMs: 0,                   // 0 = 永不超时（按你的要求：持续等待）
  notifyOnly: false,           // true = 只发通知，回复不作为放行依据
  confirmByEmail: false,       // true = 结论落地后再回一封「已处理」
  allowFrom: [],               // 额外允许的发件人（默认只认 address）
  auditFile: '',               // 审计 JSONL；留空则放在插件目录 audit/audit.jsonl
  language: 'zh',
  timeZone: 'Asia/Shanghai',   // 邮件里展示时间用的时区
}

/** cordis 的 Config 字段可能是即时引用（.get()），也可能已是纯值。 */
function value(input, fallback) {
  const raw = input !== null && typeof input === 'object' && typeof input.get === 'function' ? input.get() : input
  return raw === undefined || raw === null ? fallback : raw
}

/** 把可能来自 yml 的对象拍平成正对象。 */
function plain(input) {
  const raw = value(input, undefined)
  if (raw === null || typeof raw !== 'object') return {}
  const out = {}
  for (const key of Object.keys(raw)) out[key] = value(raw[key], undefined)
  return out
}

function numberOr(input, fallback) {
  const raw = Number(value(input, fallback))
  return Number.isFinite(raw) && raw >= 0 ? raw : fallback
}

/**
 * 读取有效配置。
 * @param rawConfig - cordis 传入的 config。
 * @returns 归一化后的配置对象（含从 secrets 文件读到的授权码）。
 * @throws 配置非法时抛错；apply() 会兜住并在 HOST 日志里说明原因。
 */
export function readSettings(rawConfig) {
  const input = rawConfig ?? {}
  const address = String(value(input.address, DEFAULTS.address)).trim()
  const smtp = { ...DEFAULT_SMTP, ...plain(input.smtp) }
  const imap = { ...DEFAULT_IMAP, ...plain(input.imap) }

  const secretsFile = String(value(input.secretsFile, DEFAULTS.secretsFile)).trim()
  let secrets = {}
  if (secretsFile !== '') {
    try {
      secrets = JSON.parse(readFileSync(secretsFile, 'utf8'))
    } catch (error) {
      throw new Error(`读取 secretsFile 失败（${secretsFile}）：${error?.message ?? error}`)
    }
  }

  const authCode = String(value(input.authCode, secrets.authCode ?? DEFAULTS.authCode)).trim()
  if (authCode === '') throw new Error('缺少邮箱授权码：在 config.authCode 或 secretsFile.authCode 里给一个')
  if (address === '' || !/^[^\s@]+@[^\s@]+$/.test(address)) {
    throw new Error(`config.address 必须是完整的邮箱地址，现在是 ${JSON.stringify(address)}`)
  }

  const user = String(value(input.user, secrets.user ?? address)).trim()

  // 收件人：可以不是账号本身（用 A 账号发给 B 邮箱，B 回信回到 A 的收件箱）。
  const to = String(value(input.to, DEFAULTS.to)).trim() || address
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
    throw new Error(`config.to 必须是完整的邮箱地址，现在是 ${JSON.stringify(to)}`)
  }

  return {
    address,
    to,
    user,
    authCode,
    displayName: String(value(input.displayName, DEFAULTS.displayName)),
    subjectPrefix: String(value(input.subjectPrefix, DEFAULTS.subjectPrefix)),
    smtp: {
      host: String(smtp.host),
      port: Number(smtp.port),
      secure: smtp.secure !== false,
      starttls: smtp.starttls === true,
    },
    imap: {
      host: String(imap.host),
      port: Number(imap.port),
      secure: imap.secure !== false,
      mailbox: String(imap.mailbox ?? DEFAULTS.imap.mailbox),
    },
    pollIntervalMs: numberOr(input.pollIntervalMs, DEFAULTS.pollIntervalMs),
    waitMs: numberOr(input.waitMs, DEFAULTS.waitMs),
    notifyOnly: value(input.notifyOnly, DEFAULTS.notifyOnly) === true,
    confirmByEmail: value(input.confirmByEmail, DEFAULTS.confirmByEmail) === true,
    allowFrom: (value(input.allowFrom, DEFAULTS.allowFrom) ?? []).map((item) => String(item).trim().toLowerCase()),
    auditFile: String(value(input.auditFile, DEFAULTS.auditFile)),
    language: String(value(input.language, DEFAULTS.language)),
    timeZone: String(value(input.timeZone, DEFAULTS.timeZone)),
  }
}
