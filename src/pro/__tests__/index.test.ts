/**
 * clean-room pro 模块（src/pro/index.ts）单元测试。
 *
 * 这里把 docs/pro-spark-byte-alignment.md 里「clean-room 预测」列的可判断言落地成
 * 可执行测试——闭源二进制（被测物 A）不可得，故不比对 A/B，只验证 clean-room 实现
 * 对同一确定性输入产出的行为与其规格预测一致（K1/K3、F2、F4/F5、F8–F11、P1/P2、
 * K7 capability 预检）。这些断言 = 能力还原的回归护栏。
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  estimateTokens,
  tailCutIndex,
  wireTransform,
  extractAnchors,
  extractGoal,
  wireContextDefaults,
  sparkPreset,
  register,
} from '../index.js'
import type { OaiAssistantMessage, OaiMessage } from '../../api/oai-types.js'

const FLASH_CTX = { truncateN: { flash: 4000, pro: 8000 } }

describe('token 估计器（与 src/compact/micro.ts 文本分段一致）', () => {
  it('ASCII ÷4、CJK ÷1.2', () => {
    assert.equal(estimateTokens('a'.repeat(4000)), 1000)
    assert.equal(estimateTokens('a'.repeat(4001)), 1001)
    assert.equal(estimateTokens('甲'.repeat(120)), 100)
    assert.equal(estimateTokens('甲'.repeat(121)), 101)
    // 混合：ascii 与 cjk 各自向上取整后相加
    assert.equal(estimateTokens('a甲'), 2)
  })
})

describe('tailCutIndex（P1/F3 截断边界）', () => {
  it('ASCII：4N 不截断、4N+1 截到 4N', () => {
    const n = 100
    assert.equal(tailCutIndex('a'.repeat(4 * n), n), 0)
    assert.equal(tailCutIndex('a'.repeat(4 * n + 1), n), 1)
  })

  it('CJK：floor(1.2N) 不截断、+1 截到 floor(1.2N)', () => {
    const n = 100 // 1.2N = 120
    assert.equal(tailCutIndex('甲'.repeat(120), n), 0)
    assert.equal(tailCutIndex('甲'.repeat(121), n), 1)
  })

  it('空串 / 恰好预算内 → 切点 0', () => {
    assert.equal(tailCutIndex('', 10), 0)
    assert.equal(tailCutIndex('a'.repeat(4), 1), 0)
  })
})

describe('wireTransform（K1 截断 / F2 直通 / K3 剥离侧）', () => {
  it('K1：超长 ASCII 推理保留尾部 N token（flash 档）', () => {
    const m: OaiAssistantMessage = { role: 'assistant', content: null, reasoning_content: 'a'.repeat(4 * 4000 + 500) }
    const out = wireTransform(m, 'deepseek-v4-flash', FLASH_CTX) as OaiAssistantMessage
    assert.equal(out.reasoning_content, 'a'.repeat(4 * 4000))
  })

  it('pro 档位使用 pro 的 N', () => {
    const m: OaiAssistantMessage = { role: 'assistant', content: null, reasoning_content: 'a'.repeat(4 * 8000 + 1) }
    const out = wireTransform(m, 'deepseek-v4-pro', FLASH_CTX) as OaiAssistantMessage
    assert.equal(out.reasoning_content, 'a'.repeat(4 * 8000))
  })

  it('F2：预算内不截断，且不分配新对象（copy-on-write）', () => {
    const m: OaiMessage = { role: 'assistant', content: null, reasoning_content: 'a'.repeat(100) }
    assert.equal(wireTransform(m, 'deepseek-v4-flash', FLASH_CTX), m)
  })

  it('非 assistant / 无 reasoning_content 原样返回', () => {
    const sys: OaiMessage = { role: 'system', content: 'x' }
    assert.equal(wireTransform(sys, 'deepseek-v4-flash', FLASH_CTX), sys)
    const txt: OaiMessage = { role: 'assistant', content: 'hello' }
    assert.equal(wireTransform(txt, 'deepseek-v4-flash', FLASH_CTX), txt)
  })
})

describe('extractAnchors（F4/F5 锚点域）', () => {
  const marker1 = '排除：候选路径001已被验证不可达。'
  const marker2 = '不可行：候选路径002已被验证不可达。'

  it('F4：dropped 前段的标记句成为锚点，顺序保持', () => {
    const front = marker1 + marker2
    const kept = 'b'.repeat(4 * 4000) // 恰好 4000 token 的干净尾段
    const anchors = extractAnchors(front + kept, 'deepseek-v4-flash', FLASH_CTX)
    assert.deepEqual(anchors, [marker1, marker2])
  })

  it('F5：标记句只在保留尾段（截断点之后）→ 不产生锚点', () => {
    const mkTokens = estimateTokens(marker1)
    const kept = marker1 + 'b'.repeat((4000 - mkTokens) * 4) // kept 总 token = 4000
    const front = 'a'.repeat(100) // 干净前段，被丢弃
    const anchors = extractAnchors(front + kept, 'deepseek-v4-flash', FLASH_CTX)
    assert.deepEqual(anchors, [])
  })

  it('无截断（i=0）时即使含标记也不产生锚点', () => {
    const anchors = extractAnchors(marker1 + 'a'.repeat(50), 'deepseek-v4-flash', FLASH_CTX)
    assert.deepEqual(anchors, [])
  })
})

describe('extractGoal（F8–F11 目标锚）', () => {
  it('F8：纯 system-reminder → null', () => {
    const msgs: OaiMessage[] = [{ role: 'user', content: '<system-reminder>foo</system-reminder>' }]
    assert.equal(extractGoal(msgs), null)
  })

  it('F9：尾随 system-reminder 被剥离，取实质指令首句', () => {
    const msgs: OaiMessage[] = [{ role: 'user', content: '修复登录页面的崩溃问题 <system-reminder>注意 x</system-reminder>' }]
    assert.equal(extractGoal(msgs), '修复登录页面的崩溃问题')
  })

  it('F10：延续语 / 确认语 → null（目标不切换）', () => {
    for (const text of ['ok', '好的', 'go on', 'continue', '继续']) {
      assert.equal(extractGoal([{ role: 'user', content: text }]), null, `"${text}" 应无目标`)
    }
  })

  it('F11：目标切换取最后一条实质 user 消息', () => {
    const msgs: OaiMessage[] = [
      { role: 'user', content: '重构数据库连接池' },
      { role: 'user', content: '升级鉴权模块' },
    ]
    assert.equal(extractGoal(msgs), '升级鉴权模块')
  })

  it('取首句 / 去前导冒号 / cap 80', () => {
    assert.equal(extractGoal([{ role: 'user', content: '：修复 X' }]), '修复 X')
    assert.equal(extractGoal([{ role: 'user', content: '第一句。第二句' }]), '第一句')
    const long = '长'.repeat(100)
    assert.equal(extractGoal([{ role: 'user', content: long }]), long.slice(0, 80))
  })
})

describe('wireContextDefaults（P1/P2 env 与冻结默认值）', () => {
  it('P1：无 env 时默认 flash 4000 / pro 8000', () => {
    assert.deepEqual(wireContextDefaults(), { truncateN: { flash: 4000, pro: 8000 } })
  })

  it('P2：env 覆盖生效', () => {
    const prev = process.env.SPARK_TRUNCATE_N_PRO
    process.env.SPARK_TRUNCATE_N_PRO = '1234'
    try {
      assert.equal(wireContextDefaults().truncateN?.pro, 1234)
    } finally {
      if (prev === undefined) delete process.env.SPARK_TRUNCATE_N_PRO
      else process.env.SPARK_TRUNCATE_N_PRO = prev
    }
  })

  it('非法 env 回退默认', () => {
    const prev = process.env.SPARK_TRUNCATE_N_PRO
    process.env.SPARK_TRUNCATE_N_PRO = 'not-a-number'
    try {
      assert.equal(wireContextDefaults().truncateN?.pro, 8000)
    } finally {
      if (prev === undefined) delete process.env.SPARK_TRUNCATE_N_PRO
      else process.env.SPARK_TRUNCATE_N_PRO = prev
    }
  })
})

describe('sparkPreset（K7 capability 预检）', () => {
  it('关键 capability 使 reasoning-echo 与 wire 截断路径生效', () => {
    const p = sparkPreset()
    assert.equal(p.name, 'deepseek-spark')
    assert.equal(p.baseUrl, 'https://api.deepseek.com/v1')
    assert.equal(p.capabilities.preservedThinkingProtocol, true)
    assert.equal(p.models.length, 2)
    assert.equal(p.models[0]!.id, 'deepseek-v4-flash')
    assert.equal(p.models[1]!.id, 'deepseek-v4-pro')
  })
})

describe('register 入口（五能力全部注册）', () => {
  it('注册 preset / wire / anchor / goal / defaults 各一次', () => {
    const calls: string[] = []
    const fake = {
      registerPreset: () => calls.push('preset'),
      registerWireTransform: () => calls.push('wire'),
      registerAnchorExtractor: () => calls.push('anchor'),
      registerGoalExtractor: () => calls.push('goal'),
      registerWireContextDefaults: () => calls.push('defaults'),
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    register(fake as any)
    assert.deepEqual([...calls].sort(), ['anchor', 'defaults', 'goal', 'preset', 'wire'])
  })
})
