/**
 * 日期稳定性探针（P4 守卫）。
 *
 * DeepSeek 隐式前缀缓存从 byte 0 逐字节匹配；若系统提示里出现日期/时间戳，
 * 跨天或跨请求即打穿前缀缓存（本库 2026-06-13 事故的 currentDate@msg[0] 教训）。
 * 本探针扫描系统提示，命中日期模式即报不稳定，供测试与 /cache/doctor 端点消费。
 * 零运行时开销：仅在测试与显式 doctor 调用时执行。
 */

import { buildSystemPrompt } from './static.js'

/** 日期/时间戳模式——命中任一即视为前缀不稳定。 */
const DATE_PATTERNS: RegExp[] = [
  /currentDate/i,
  /Today's date/i,
  /Today is/i,
  /toISOString/,
  /Date\.now\(/,
  /new Date\(/,
  /\b\d{4}[-/]\d{1,2}[-/]\d{1,2}\b/,
]

export interface DateProbe {
  stable: boolean
  hits: string[]
}

/** 探针：系统提示是否含日期/时间戳。 */
export function dateStabilityProbe(): DateProbe {
  const system = buildSystemPrompt({} as never)
  const hits: string[] = []
  for (const re of DATE_PATTERNS) {
    if (re.test(system)) hits.push(re.source)
  }
  return { stable: hits.length === 0, hits }
}
