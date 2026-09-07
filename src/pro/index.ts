/**
 * Clean-room "pro" extension module — 独立重实现。
 *
 * 这个文件按公开扩展点契约（src/api/pro-registry.ts 定义的 ProRegistry 接口）注册
 * 一套与 DeepSeek 前缀缓存工程等价的功能，属于基于公开接口与公开文档的二次开发：
 *   - DeepSeek Spark provider preset（独立 DEEPSEEK_SPARK_API_KEY）
 *   - wire 层 reasoning 尾部截断（保留尾部 N token，丢弃前段）
 *   - 推理锚点补偿（从被截断丢弃的前段提取「已排除路径」锚点句）
 *   - 目标锚提取（从 user 消息提取「当前目标」陈述）
 *   - wire 上下文默认值（会话级冻结的截断 N，防 env 漂移打穿前缀缓存）
 *
 * 闭源边界：不触碰 config.pro.enabled / license 文件 / RIVET_PRO 验签；不注册自定义
 * client 工厂（deepseek-spark 是 OpenAI 兼容协议，走默认 OpenAIClient 路径）。所有
 * 持久化由消费方（bootstrap/serve-agent）经 persist.updateMetadata 完成，本模块只返回
 * 纯值。变换函数必须是无状态、copy-on-write 的纯函数（同一 frozen ctx → 字节一致）。
 *
 * 设计要点（对齐公开注释与调用点）：
 *   - 截断与锚点提取必须共用同一个 token 估计器与同一个 cutIndex，保证
 *     「提取域 = 截断丢失域」精确互补（pro-registry.ts 的 N 失配即重复注入/漏补偿）。
 *   - 该模块仅在 provider.name === 'deepseek-spark' 的会话生效；其余会话注册表恒空、
 *     行为字节级不变。
 */

import type { ProRegistry, WireTransformContext } from '../api/pro-registry.js'
import { oaiMessageText } from '../api/oai-types.js'
import type { OaiMessage } from '../api/oai-types.js'
import type { ProviderConfig } from '../config/schema.js'
import { isSystemReminder } from '../prompt/system-reminder.js'

const SPARK_PROVIDER = 'deepseek-spark'

// ---------------------------------------------------------------------------
// 共享 token 估计器（与 src/compact/micro.ts 的 estimateOaiMessageTokens 的
// 文本分段逻辑一致：CJK 类字符 ceil(n/1.2)，其余 ceil(n/4)）。
// 截断与锚点提取共用此函数，保证切点一致。
// ---------------------------------------------------------------------------

function isCjkCodePoint(code: number): boolean {
  return (
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x20000 && code <= 0x2a6df) ||
    (code >= 0x3040 && code <= 0x309f) ||
    (code >= 0x30a0 && code <= 0x30ff) ||
    (code >= 0xac00 && code <= 0xd7af)
  )
}

export function estimateTokens(text: string): number {
  let ascii = 0
  let cjk = 0
  for (const ch of text) {
    if (isCjkCodePoint(ch.codePointAt(0) ?? 0)) cjk++
    else ascii++
  }
  return Math.ceil(ascii / 4) + Math.ceil(cjk / 1.2)
}

/** 保留尾部 <=N token 时的切点：返回 text.slice(i) 的起始下标（最长满足预算的后缀）。
 *  单次后向扫描累计字符类计数，O(len)，避免逐切片重估的 O(len²)。
 *  按 UTF-16 code unit 遍历（对齐 slice 语义）；astral 字符（代理对）的低代理项跳过、
 *  高代理项计为 ascii，与 micro.ts 的 code-point 计法仅在此罕见情形有可忽略差异。 */
export function tailCutIndex(text: string, n: number): number {
  const len = text.length
  if (len === 0) return 0
  if (estimateTokens(text) <= n) return 0 // 整体已达标，无需截断
  let ascii = 0
  let cjk = 0
  let cut = len // 兜底：预算不足时保留空后缀
  for (let i = len - 1; i >= 0; i--) {
    const code = text.charCodeAt(i)
    if (code >= 0xdc00 && code <= 0xdfff) continue // 低代理项，随高代理项一起计
    if (isCjkCodePoint(code)) cjk++
    else ascii++
    if (Math.ceil(ascii / 4) + Math.ceil(cjk / 1.2) <= n) {
      cut = i // 该后缀仍在预算内，记录为当前最优切点
    } else {
      break // 后缀已超预算，更大的后缀也超
    }
  }
  return cut
}

// ---------------------------------------------------------------------------
// 档位判定：按 model 字符串确定性区分 pro/flash（wire id 或 alias 含 'pro' 视为 pro）。
// ---------------------------------------------------------------------------

function isProModel(model: string | undefined): boolean {
  if (!model) return false
  return /pro/i.test(model)
}

/** 从 ctx 取当前档位的截断 N；ctx 缺席时回退 env（会话首启语义）。 */
function truncateNFor(ctx: WireTransformContext | undefined, model: string | undefined): number {
  const pro = isProModel(model)
  const n = ctx?.truncateN
  if (n) {
    const v = pro ? n.pro : n.flash
    // 冻结 ctx 缺失/非法时逐键回退 env 默认，绝不产生 n=undefined 导致 reasoning 被抹空。
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v
  }
  return pro ? defaultProN() : defaultFlashN()
}

function parseIntEnv(name: string, fallback: number, min = 1): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const v = Number.parseInt(raw, 10)
  if (!Number.isFinite(v) || v < min) return fallback
  return v
}

function defaultFlashN(): number {
  return parseIntEnv('SPARK_TRUNCATE_N_FLASH', 4000)
}

function defaultProN(): number {
  return parseIntEnv('SPARK_TRUNCATE_N_PRO', 8000)
}

// ---------------------------------------------------------------------------
// 1. Spark provider preset
// ---------------------------------------------------------------------------

export function sparkPreset(): ProviderConfig {
  return {
    name: SPARK_PROVIDER,
    apiKeyEnv: 'DEEPSEEK_SPARK_API_KEY',
    baseUrl: 'https://api.deepseek.com/v1',
    protocol: 'openai',
    capabilities: {
      // DeepSeek 同族：透明服务端缓存（无 cache_control 标记）、tool JSON 入 text bug、
      // exact-prefix 缓存策略 + Beta 前缀续写。
      cacheControl: false,
      stripParams: [],
      toolJsonBug: true,
      prefixCache: 'deepseek-native',
      prefixCompletion: true,
      // 关键：声明 preserved-thinking 协议族，使 openai-client 的 reasoning-echo 与
      // wire-transform 路径生效（factory.ts 以 capabilities.preservedThinkingProtocol 判定）。
      preservedThinkingProtocol: true,
      thinkingBlock: 'enabled',
      effortFormat: 'reasoning_effort',
    },
    thinking: 'enabled',
    maxTokens: 384_000,
    models: [
      {
        id: 'deepseek-v4-flash',
        description: 'Spark 快档：轻量推理 + 锚点缓存通道',
        alias: 'spark-flash',
        contextWindow: 1_000_000,
        maxTokens: 384_000,
        reasoningEffort: 'medium',
        tier: 'cheap',
        pricing: { input: 1, output: 2, cacheRead: 0.02, cacheWrite: 1 },
      },
      {
        id: 'deepseek-v4-pro',
        description: 'Spark 旗舰档：深度推理 + 锚点缓存通道',
        alias: 'spark-pro',
        contextWindow: 1_000_000,
        maxTokens: 384_000,
        reasoningEffort: 'high',
        tier: 'strong',
        pricing: { input: 3, output: 6, cacheRead: 0.025, cacheWrite: 3 },
      },
    ],
    unsupported: [],
  }
}

// ---------------------------------------------------------------------------
// 2. WireTransform：reasoning 尾部截断（保留尾部 N token，丢弃前段）
// ---------------------------------------------------------------------------

export function wireTransform(m: OaiMessage, model: string | undefined, ctx?: WireTransformContext): OaiMessage {
  if (m.role !== 'assistant' || typeof m.reasoning_content !== 'string') return m
  const text = m.reasoning_content
  const n = truncateNFor(ctx, model)
  const i = tailCutIndex(text, n)
  if (i <= 0) return m // 已在预算内，无需变换（不分配新对象）
  return { ...m, reasoning_content: text.slice(i) }
}

// ---------------------------------------------------------------------------
// 3. ReasoningAnchorExtractor：从被截断丢弃的前段提取「已排除路径」锚点句
// ---------------------------------------------------------------------------

// 仅中文标记：系统后缀强制中文推理，英文 pass/skip/reject 会误命中代码里的
// 英文标识符/路径，故去掉（clean-room 默认，未与闭源实现黑盒对齐）。
const EXCLUDE_MARKERS = [
  '排除', '不采用', '不是最优', '不可行', '此路不通', '行不通',
  '放弃', '不要尝试', '不适合', '否决',
]

export function extractAnchors(reasoning: string, model: string | undefined, ctx?: WireTransformContext): string[] {
  const n = truncateNFor(ctx, model)
  const i = tailCutIndex(reasoning, n)
  if (i <= 0) return []
  const dropped = reasoning.slice(0, i)

  const sentences = dropped
    .split(/(?<=[。！？!?；;\n])|(?<=\.\s)/)
    .map(s => s.trim())
    .filter(s => s.length > 0)

  const anchors: string[] = []
  const seen = new Set<string>()
  for (const s of sentences) {
    if (!EXCLUDE_MARKERS.some(mk => s.includes(mk))) continue
    const anchor = normalizeAnchor(s)
    if (!anchor || seen.has(anchor)) continue
    seen.add(anchor)
    anchors.push(anchor)
  }
  return anchors
}

function normalizeAnchor(sentence: string): string | null {
  // 去噪、截长，产出稳定的短锚点句。
  let s = sentence.replace(/\s+/g, ' ').trim()
  s = s.replace(/^[-*•·#]+/, '').trim()
  if (s.length === 0) return null
  if (s.length > 120) s = s.slice(0, 120)
  return s
}

// ---------------------------------------------------------------------------
// 4. GoalExtractor：从 user 消息提取「当前目标」陈述
// ---------------------------------------------------------------------------

const CONTINUATION_PATTERNS = [
  /^\/\w+/, // slash 命令
  /^(继续|接着|如上|如上所述|请继续|继续吧|go on|continue)\b/i,
  /^(ok|好的|嗯|明白|收到|知道了)[\s。．.，,]*$/i,
]

export function extractGoal(messages: OaiMessage[]): string | null {
  // 跳过纯系统提醒注入（role:user 但内容是 <system-reminder> 包裹的注入指引）。
  const userMsgs = messages.filter(m => m.role === 'user' && !isSystemReminder(m.content))
  if (userMsgs.length === 0) return null
  const last = userMsgs[userMsgs.length - 1]!
  let text = oaiMessageText(last).trim()
  // 系统提醒可能以尾随片段合并到真实 user 消息上：剥离后若无实质内容则返回 null。
  text = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, ' ').trim()
  if (text.length === 0) return null

  // 延续指令/确认语无实质目标 → 返回 null（不触发目标变更）。
  if (CONTINUATION_PATTERNS.some(re => re.test(text))) return null
  // 过短的确认性消息视为无目标。
  if (text.length <= 4) return null

  // 取首个指令句/主句，去尾随标点，产出稳定的祈使式目标陈述。
  const first = text.split(/[。！？!?\n]|(?<=\.)\s/)[0]?.trim() ?? text
  let goal = first.replace(/^[：:]\s*/, '').trim()
  goal = goal.replace(/[。．.，,、；;：:！!？?]+$/, '').trim()
  if (goal.length === 0) return null
  if (goal.length > 80) goal = goal.slice(0, 80)
  return goal
}

// ---------------------------------------------------------------------------
// 5. WireContextDefaults：会话级冻结的截断 N
// ---------------------------------------------------------------------------

export function wireContextDefaults(): WireTransformContext {
  // 每次调用返回新对象；env 解析只在会话首启发生，此后冻结进 meta。
  return { truncateN: { flash: defaultFlashN(), pro: defaultProN() } }
}

// ---------------------------------------------------------------------------
// 注册入口（loadProModule 动态 import 后调用 register(proRegistry)）
// ---------------------------------------------------------------------------

export function register(registry: ProRegistry): void {
  registry.registerPreset({
    key: SPARK_PROVIDER,
    label: 'DeepSeek Spark',
    description: 'DeepSeek 极速通道：官方端点 + 推理尾截断锚点缓存',
    apiKeyEnv: 'DEEPSEEK_SPARK_API_KEY',
    defaultModelId: 'deepseek-v4-flash',
    provider: sparkPreset(),
  })
  registry.registerWireTransform(SPARK_PROVIDER, wireTransform)
  registry.registerAnchorExtractor(SPARK_PROVIDER, extractAnchors)
  registry.registerGoalExtractor(SPARK_PROVIDER, extractGoal)
  registry.registerWireContextDefaults(SPARK_PROVIDER, wireContextDefaults)
}
