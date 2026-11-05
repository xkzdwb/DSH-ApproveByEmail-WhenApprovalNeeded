// 审批令牌：一次性、随机、短、能塞进邮件主题。
// 只做生成与规范化——「哪个令牌对应哪个请求」由 answerer.mjs 的待办表负责。
import { randomBytes } from 'node:crypto'

/** 令牌允许的字符集：小写十六进制，避免大小写与易混字符的歧义。 */
export const TOKEN_RE = /#([0-9a-f]{8})/g

/**
 * 生成一个新令牌（8 位十六进制，32 位熵）。
 * 同一时刻待办请求通常只有 1~2 个，碰撞概率可忽略；answerer 仍会做去重。
 * @returns 形如 `a1b2c3d4` 的令牌（不带 `#`）。
 */
export function newToken() {
  return randomBytes(4).toString('hex')
}

/**
 * 从一段文本里抽出所有 `#xxxxxxxx` 形式的令牌。
 * @param text - 主题或正文（任意来源，可能是恶意内容）。
 * @returns 去重后的令牌数组，按出现顺序。
 */
export function extractTokens(text) {
  if (typeof text !== 'string' || text.length === 0) return []
  const found = []
  TOKEN_RE.lastIndex = 0
  for (const match of text.matchAll(TOKEN_RE)) {
    if (!found.includes(match[1])) found.push(match[1])
  }
  return found
}
