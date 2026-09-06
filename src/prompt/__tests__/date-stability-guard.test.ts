import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { dateStabilityProbe } from '../date-guard.js'

/**
 * P4 日期稳定性守卫：系统提示不得含日期/时间戳。
 * 防未来接入「日期接地」时重演 currentDate@msg[0] 跨天打穿前缀缓存的事故。
 */
describe('date-stability guard（前缀缓存跨天保护）', () => {
  it('系统提示不含日期/时间戳', () => {
    const probe = dateStabilityProbe()
    assert.deepEqual(probe.hits, [], `命中日期模式: ${probe.hits.join(', ')}`)
    assert.equal(probe.stable, true)
  })
})
