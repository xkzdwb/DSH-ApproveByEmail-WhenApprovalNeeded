// 本地审计：每次「请求 → 结论」落一行 JSONL。
// 邮箱那边是给你看的，这里是你事后查「到底谁批了什么」的账本。
import { appendFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'

/** 串行化写入，避免并发请求把 JSONL 写成半行。 */
let queue = Promise.resolve()

/**
 * 追加一条审计记录；写失败只告警，绝不影响审批本身。
 * @param file - JSONL 文件路径。
 * @param record - 可 JSON 序列化的记录。
 * @param log - 告警输出函数。
 */
export function appendAudit(file, record, log = console.warn) {
  const line = `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`
  queue = queue.then(async () => {
    try {
      await mkdir(dirname(file), { recursive: true })
      await appendFile(file, line, 'utf8')
    } catch (error) {
      log(`[approval-email] 审计写入失败（忽略）：${error?.message ?? error}`)
    }
  })
  return queue
}
