# Pro 模块黑盒字节对齐验证方案（DeepSeek Spark clean-room ↔ 闭源二进制）

> 范围：`src/pro/index.ts`（clean-room 重实现）与真实闭源 Pro 二进制之间，验证 DeepSeek Spark
> 会话对外发出的 **HTTP 请求体 `messages` 字节一致**。纯黑盒——不接触闭源码，只看两侧对同一
> 确定性输入的表现。
>
> 关联文档：`docs/deepseek-wire-probe-playbook.md`（同为"线上行为实测留档"方法论，缓存/usage 部分复用其判读思路）；
> `docs/plans/` 下 spark 截断锚点相关规格；`docs/user-guide-provider-config.md`（provider 配置写法）。
> 涉及源码锚点（均为开源侧调用点，闭源模块只注册纯值/纯函数）：
> `src/api/openai-client.ts:427-453`（reasoning 保留/剥离/变换）、`:559-566`（系统后缀）、
> `src/bootstrap.ts:901-908`（wireContext 会话冻结）、`src/prompt/engine.ts:1033-1048`（锚点追加+cap20 / 目标覆盖）、
> `src/prompt/volatile.ts:663-677`（`<excluded-paths>` / `<current-goal>` 渲染）、
> `src/agent/reasoning-anchors.ts`（内存态全量推理→提取器接线）、`src/compact/micro.ts`（token 估计器参考实现）。

---

## 一、目标与非目标

### 1.1 目标

在**确定性会话输入**下，令两套被测物各自完整跑一遍真实请求管线，比对它们发往上游的
HTTP 请求体（`POST /chat/completions` 的 JSON）中 **`messages` 数组的字节**：

- **被测物 A：Pro 闭源二进制**（内含真闭源 pro 模块，未开源）。
- **被测物 B：clean-room 构建**（同一开源基座 + `src/pro/index.ts`）。

字节对齐定义：

1. 对**同一确定性会话**（同一 `cwd`、同一初始提示、同一上游回放流、同一 env、同一全新 session
   目录），逐请求记录 A、B 实际写到 socket 的原始请求体。
2. 逐请求比较 `messages` 数组。判定标准分两级：
   - **原始字节全等**（primary）：socket 层捕获的 body 字符串逐字节相等。两侧共享同一份
     `openai-client.ts` 构造逻辑，结构相等 ⇒ 键序/数字格式相等，原始字节应当全等。
   - **规范化全等**（secondary，仅用于定位）：`JSON.parse` 后按稳定键序重排再比。若原始不等而
     规范化等 → 记录为"序列化层差异"（不应发生，发生了要查基座 commit 是否一致）。

### 1.2 为什么黑盒可比

闭源 Pro 模块只通过公开扩展点（`src/api/pro-registry.ts` 定义的 `ProRegistry`）注册五样东西：
provider preset、`WireTransform`、`ReasoningAnchorExtractor`、`GoalExtractor`、`WireContextDefaults`。
**两套被测物共享除这五样外的全部开源代码**（`openai-client` / `prompt engine` / `bootstrap`
冻结逻辑 / `reasoning-anchors` 接线 / `micro` 估计器参考）。因此：

> 两侧 wire 字节的**任何差异**都必然可归因于这五个注册点（或其预设 capability 字段）。
> 黑盒差异即证据，不需要读闭源码。

### 1.3 非目标

- **不**反编译、不静态分析、不插桩读取闭源二进制内部状态；**不**尝试"提取"闭源实现。
- **不**追求 provider preset 的展示字段/价格/别名一致（见 §二）。
- **不**验证算法逐行等价；只验证"对同一输入产出的 wire 字节等价"。
- **不**对两侧做性能/成本/并发评估。

---

## 二、必须一致 vs 允许不同

### 2.1 字节关键（必须逐字节一致）

出现在请求体 `messages` 中的一切，且由 pro 模块直接或经共享开关间接决定的内容：

| # | 内容 | 产生位置 | 判定 |
|---|---|---|---|
| K1 | assistant **工具轮** `reasoning_content` 的**截断结果**（保留尾部 N、丢弃前段） | `openai-client.ts:442-443` 调 `WireTransform` | 逐字节 |
| K2 | `reasoning_content` **缺失但工具轮**时的补 `''` 回显（`reasoning_content` 键存在且空串） | `openai-client.ts:434-436` | 逐字节（**键存在性**也是字节） |
| K3 | 纯文本 assistant 轮的 `reasoning_content` 剥离后 `content` 补位 | `openai-client.ts:446-452` | 逐字节 |
| K4 | system 消息尾部追加的中文思考后缀（copy-on-write、幂等） | `openai-client.ts:559-566` | 逐字节 |
| K5 | 动态附录里的 `<excluded-paths note="推理截断补偿…">…</excluded-paths>`：内容、顺序、条数、XML 转义 | `volatile.ts:666-669`，内容源 `engine.ts:1033-1041` | 逐字节 |
| K6 | 动态附录里的 `<current-goal note="…">…</current-goal>`：存在性、内容、位置（只应在尾部、单实例） | `volatile.ts:675-677`，覆盖语义 `engine.ts:1046-1048` | 逐字节 |
| K7 | 请求体中受 capability **驱动分支**的字段：`thinking`/`preservedThinkingProtocol` 是否开启决定 K1-K3 走哪条路；`reasoning_effort`、`max_tokens` 等若进入 body | `openai-client.ts` 各分支 | 逐字节 |

K7 是容易漏的预检项：capability 也由 pro 模块的 preset 提供。若闭源 preset 的
`preservedThinkingProtocol`/`thinking` 与 clean-room 不同，截断路径可能根本不触发，
整体字节必然不同。**开始字节比较前，先用 §四 F0 探明两侧 capability 驱动行为一致。**

### 2.2 允许不同（不进 wire 或不影响 wire）

- preset 的 `label`/`description`/`apiKeyEnv` 名称（只要夹具里注入的 key 对应一致）、
  `pricing` 数字、`tier`、`contextWindow` 展示值、`models` 表里不进请求体的展示字段。
- 内部日志、`cache-log`、usage 侧路记账、`recordWireDivergence` 指纹输出。
- 进程内对象同一性（如 `i<=0` 时不分配新对象）——这影响内存不影响字节。

> **注意**：`models[].maxTokens`/`reasoningEffort` 可能经 client 进入 body（`max_tokens`、
> `reasoning_effort`）。这不属于"允许不同"——夹具必须把两侧的 model 配置钉成同一份
> （或驱动层显式传 `max_tokens`/effort），否则请求体在非 pro 字段上就不等，污染归因。

---

## 三、如何从 Pro 二进制抓取 wire 字节

### 3.1 主推：baseUrl 改写 → 本地 MITM/捕获代理

把配置里 `deepseek-spark` 的 `baseUrl` 指到本地捕获代理，代理记录请求体并把请求转发到真实
`https://api.deepseek.com/v1`（上游真 key 在代理侧注入即可，被测进程可放任意占位 key）。
该方案**对闭源二进制零侵入**，且天然支持两种用途：①透传真上游抓真实行为；②后续用 fixture
回放换取确定性（见 3.5）。

配置写法（provider config 详参 `docs/user-guide-provider-config.md`）：

```jsonc
// ~/.rivet/config.json（或项目 config），仅深拷贝 A/B 各自用
{
  "provider": {
    "providers": {
      "deepseek-spark": {
        "name": "deepseek-spark",
        "baseUrl": "http://127.0.0.1:8790/v1",   // 指向本地捕获代理
        "apiKeyEnv": "DEEPSEEK_SPARK_API_KEY"
      }
    }
  }
}
```

捕获代理骨架（Node，零依赖，仅示意；生产版需处理分块/重试/流式透传）：

```js
// capture-proxy.mjs  ——  http.createServer 接收本地请求，透传给真上游，同时落盘
import http from 'node:http'
import https from 'node:https'
import fs from 'node:fs'

const UPSTREAM_HOST = 'api.deepseek.com'
const UPSTREAM_KEY = process.env.UPSTREAM_DEEPSEEK_KEY // 真 key 只在代理侧
const OUT = fs.createWriteStream(process.env.CAPTURE_FILE ?? './capture.ndjson', { flags: 'a' })

http.createServer((req, res) => {
  let raw = ''
  req.on('data', c => (raw += c))
  req.on('end', () => {
    const body = JSON.parse(raw)
    OUT.write(JSON.stringify({ kind: 'request', t: Date.now(), method: req.method, path: req.url, body }) + '\n')
    // 注入真 key 并转发
    const upstream = https.request({
      host: UPSTREAM_HOST, path: req.url, method: req.method,
      headers: { ...req.headers, host: UPSTREAM_HOST, authorization: `Bearer ${UPSTREAM_KEY}` },
    }, upRes => {
      let upRaw = ''
      upRes.on('data', c => { upRaw += c; res.write(c) })   // 流式原样回传
      upRes.on('end', () => {
        OUT.write(JSON.stringify({ kind: 'response', t: Date.now(), status: upRes.statusCode, raw: upRaw }) + '\n')
        res.end()
      })
    })
    upstream.on('error', e => { console.error(e); res.writeHead(502); res.end() })
    upstream.write(raw); upstream.end()
  })
}).listen(8790, () => console.log('capture proxy on 8790'))
```

每条记录建议含：`session_id`、`seq`（进程内请求序号）、`model`、`body.messages` 的**规范摘要**
（角色序列 + 各条长度 + 全文 JSON，供后处理）、上游响应原始 SSE（确定性回放用）。

### 3.2 备选 b：内建日志 / `--stream-json`

- `rivet -p "<prompt>" --stream-json` 输出 NDJSON 事件（`docs/headless-stream-json.md`），但它只到
  `text_delta`/`tool_use`/`tool_result`/`turn_complete` 粒度，**不含原始请求体**。用途限于：
  判断两侧回合结构是否一致（回合数、工具调用序列），作为字节比较的旁证与对齐依据。
- 开源侧 `recordWireDivergence`（`openai-client.ts:594-614`，`request.prefixProbe` 开启时）会对最终
  wire `messages` 逐条打 `wireHash`。若闭源二进制保留了该日志，可用于**快速定位**差异发生在第几条
  消息，但仍不是原始字节，不能替代 3.1。
- 配置里若已有请求级日志开关（`debug`/`RIVET_*`），优先按 3.1 为准，日志只做辅助。

### 3.3 备选 c：`NODE_DEBUG`/注入式 hook

`NODE_OPTIONS=--require <hook>` 钩住 `https.request`/`fetch` 可拿到出站明文。但闭源二进制可能：
打包后无 Node 源码可注入、`RIVET_PRO` 验签对加载器敏感、或生产构建关闭 `NODE_OPTIONS`。
**仅作 fallback**，若验证发现 hook 注入改变行为（验签/自检失败）立即放弃，回到 3.1。

### 3.4 捕获目录约定

```
probe-run/<ISO时间戳>/
  pro/          # 被测物 A（闭源 Pro 二进制）的 capture.ndjson + 会话目录
  clean/        # 被测物 B（clean-room 构建）的 capture.ndjson + 会话目录
  fixtures/     # 从 pro 捕获中提取的上游 SSE 回放文件（见 3.5）
```

会话目录（`~/.rivet/sessions/...` 或指定 `--session-dir`）每次实验前**全新删除**，保证
`bootstrap.ts:901-908` 的 meta 冻结从空开始（详见 §五 P2 的冻结实验）。

### 3.5 确定性关键：上游回放

字节对齐要求**两侧拿到的模型原始输出一致**（变换的输入一致），否则 LLM 采样噪声会把差异
淹没。因此夹具驱动一律走**回放模式**：

1. 用 3.1 代理先跑一次 A（或直接手工构造），把上游 SSE 存成 fixture（`fixtures/<case>/turn-N.sse`）。
2. 让代理处于 **replay 模式**：按 `body.messages` 的轮次/哈希查找 fixture 文件，返回其中保存的
   完整 SSE（`choices[0].delta.reasoning_content` + `delta.tool_calls` + `finish_reason` 等原样重放）。
3. A 与 B 各自对**同一组 fixture** 跑同一剧本 → 变换函数输入完全一致，唯一差异源就是 pro 模块。

> 回放模式下模型输出是我们构造的，因此 `reasoning_content` 的内容/长度**完全可控**，这是 §四/§五
> 所有长度与标记实验的前提。reasoning 属"输入"而非"被测输出"——回放它不违反黑盒原则。

---

## 四、确定性测试夹具（fixtures）

### 4.0 通用夹具环境（所有用例默认）

- 全新空会话目录；固定空 `cwd`（如 `fixtures/workdir`，git 干净、无状态文件）。
- 固定初始 system/提示文本（每个用例给常量）；`DEEPSEEK_SPARK_API_KEY` 占位即可（代理注入真 key）。
- **钉死会进 body 的非 pro 字段**：两侧用同一 `max_tokens`/`reasoning_effort`（驱动层显式传或同一
  model 表）。
- 夹具形态：每个用例 = 一组按序 SSE 回放文件 + 一段驱动剧本（`rivet -p … --stream-json` 或
  serve-agent 脚本化调用）。工具调用统一落到固定本地 fixture 文件（如 `read_file` 读 `fixtures/data/…`），
  保证 tool result 确定。

### 4.1 夹具表

| ID | 构造 | 触发的路径 | 期望可观测效应（clean-room 预测） |
|---|---|---|---|
| F0 | capability 探针：一次不含长推理的普通对话，观察纯文本 assistant 轮 | K3 剥离分支是否走、系统后缀是否追加 | 两侧 `messages` 里 reasoning 均不出现、system 尾部同后缀。**任何不等 ⇒ preset capability 不同，先修这个再往下** |
| F1 | 工具轮 + **超长 ASCII 推理**（`'a'.repeat(L)`，L 远大于 `4N`） | K1 截断触发 | 该 assistant 轮 `reasoning_content` 变为纯尾段；长度 = `4N`（见 §五 P1 公式） |
| F2 | 工具轮 + **短推理**（总估计 ≤ N，如 ASCII 2000 字符） | K1 `i<=0` 不截断 | 该轮 `reasoning_content` 原样出现，与内存态一致 |
| F3 | 工具轮 + **边界长度**（ASCII `4N` 与 `4N+1` 两个变体；CJK `floor(1.2N)` 与 `+1`） | K1 截断阈 | `4N`/`floor(1.2N)` 不截断；`+1` 截到 `4N`/`floor(1.2N)` |
| F4 | 工具轮长推理，**dropped 前段**含 3~5 个"排除…"句，末尾无标记 | K1 + 锚点提取 | 下一请求动态附录出现 `<excluded-paths>`，含这些句的规范化文本，条数/顺序对应 |
| F5 | 工具轮长推理，标记句**只放保留尾段**、前段干净 | 锚点域 = dropped front 的验证 | **不出现**新锚点（若出现 ⇒ 提取域不是 dropped front，重大差异） |
| F6 | 单轮 dropped 前段含 **25 条不同排除句**（全新会话） | 引擎 cap 20 / 排序 | clean-room：引擎 `slice(-20)` 保留**最新 20 条**（#6–#25，首见序） |
| F7 | F6 之后再来一轮注入 5 条新锚点（#26–#30） | 全局 cap 淘汰最旧 | clean-room：淘汰 #1–#5，剩 #6–#30 中最新 20（详见 §五 P3 判定树） |
| F8 | user 消息**仅**为 `<system-reminder>…</system-reminder>` 包裹内容 | Goal 跳过 system-reminder | `<current-goal>` 不新增/不变（或无该块） |
| F9 | user 消息 = 实质指令 + **尾随** `<system-reminder>…</system-reminder>` 片段 | Goal 剥离尾随 reminder | `<current-goal>` 取指令首句，不含 reminder 文本 |
| F10 | user 消息分别是延续指令语（继续/接着/如上/请继续/go on/continue）与确认语（ok/好的/嗯/明白…） | Goal 延续语 → null | `<current-goal>` 维持上一值不变（目标不切换） |
| F11 | user 消息从目标甲切到目标乙（均为实质祈使句） | Goal 覆盖语义 | `<current-goal>` 整段替换为乙；**只有一块**、位于尾部 |

### 4.2 reasoning 构造器（供 F1–F7 复用）

```ts
// 纯 ASCII：token 估计 = ceil(len/4)，可精确推 N（P1）
const asciiReasoning = (len: number) => 'a'.repeat(len)
// 纯 CJK：token 估计 = ceil(len/1.2)，可交叉验证类边界（P5）
const cjkReasoning = (len: number) => '甲'.repeat(len)
// 带标记句：前半=候选排除句（编号唯一便于核对），其余用与标记无关的长填充
const markerSentence = (i: number, phrase: string) =>
  `${phrase}：候选路径 ${String(i).padStart(3, '0')} 已被验证不可达。`
const frontLoadedReasoning = (total: number, sentences: string[]) =>
  sentences.join('') + 'b'.repeat(Math.max(0, total - sentences.join('').length))
```

驱动剧本里固定：**同一请求轮次、同一 tool call id 格式、同一 tool 结果文本**。记录每次请求
的序号 `seq` 与 `messages` 中 system 消息长度、各 assistant 轮 `reasoning_content` 长度，
供后处理脚本生成差异报告。

---

## 五、参数恢复实验（逐未知量）

> 所有实验都在 A（Pro）上做，得到参数后填入 B 的 `src/pro/index.ts`，再用 §七验收清单全量比对。
> 实验顺序有依赖：**P1 先于 P3/P5**（锚点域与类边界计算要用到 N）。

### P1 — `truncateN.flash` / `truncateN.pro`（clean-room 猜测 4000 / 8000）

原理：`WireTransform` 保留**尾部** ≤N token。对纯 ASCII 超长推理，保留尾长 `K = 4N`；对纯 CJK，
`K = floor(1.2N)`。反过来由观测尾长反推 N。每档（flash / pro）各扫一遍。

步骤：

1. 每档选推理长度 `L ∈ {20000, 40000, 80000, 160000}`（纯 ASCII），跑 F1。
2. 从捕获里读该 assistant 轮 `reasoning_content` 长度 `K`。判读：
   - `K = 0` → 截断把整条抹空（N 极小或异常路径，先查 env）。
   - `K = L` → 未截断（N ≥ L/4），加大 L。
   - `K = 4·N*` → 截断生效，`N* = K/4`。多长度交叉验证。
3. 用纯 CJK 交叉验证：预测 `K = floor(1.2·N*)`，若实测不符 → 该文本类别的估计系数不同，转入 P5。
4. flash/pro 各测一遍，记录两档 N。

精确边界（F3）再验证：ASCII `4N` 字符不截断、`4N+1` 截到 `4N`。

> 若 Pro 用的不是"字符类 * 系数"估计而是真 tokenizer，`K` 将不等于上表——记录实测 `(L, K)`
> 点列即可反拟合其规则；本方案的公式只用于预测"若与 clean-room 同规则则应是 X"。

### P2 — env 覆盖变量名（clean-room 猜测 `SPARK_TRUNCATE_N_FLASH` / `SPARK_TRUNCATE_N_PRO`）

先确认"env 在首启被读、之后冻结"这一语义（共享的 `bootstrap.ts:901-908` 在两侧应一致，但要实证）：

1. **冻结语义实验**：全新会话，设 `SPARK_TRUNCATE_N_PRO=1234` 启动 → ASCII 实验读到 `N=1234/4`? 不，
   直接按 P1 反推应为 `N=1234`（若该 env 名生效）。结束进程。
2. **保留同一会话目录**，把 env 改成 `9876` 再启动同一会话 → 若 `N` 仍为 1234 ⇒ 冻结生效
   （meta 已有值恒用）；若变 9876 ⇒ 不冻结。
3. 删除会话 meta 后用 `9876` 再启 → 应为 9876。

候选变量名矩阵（逐个试，每试一次 = 全新会话 + ASCII 实验看 N 是否变化）：

```
SPARK_TRUNCATE_N_FLASH / SPARK_TRUNCATE_N_PRO        ← clean-room 猜测
RIVET_SPARK_TRUNCATE_N_FLASH / _PRO
DEEPSEEK_SPARK_TRUNCATE_N_FLASH / _PRO
SPARK_TRUNCATE_FLASH / SPARK_TRUNCATE_PRO
RIVET_TRUNCATE_N_FLASH / _PRO
... 按"命中即停"的原则，先测最可能的完整名，再测截短/加前缀变体
```

记录：命中名 + 非法值行为（`NaN`、`0`、负数、非数字字符串 → 是否回退默认，clean-room 是
回退默认；§六不变量一并查）。

### P3 — 锚点提取（标记短语 / 切分 / 规范化 / 排序与 cap 归属）

依赖 P1 已得 N，保证能把"标记句放进 dropped 前段、把对照句放进保留尾段"（F4/F5）。

**(a) 标记短语集合**：构造超集候选短语，每句**恰好一个短语**并带唯一编号（见 4.2
`markerSentence`），全部放入 dropped 前段，跑 F4；在 `<excluded-paths>` 里核对哪些编号句出现。
一次实验覆盖全部候选：

```
排除 · 不采用 · 不是最优 · 不可行 · 此路不通 · 行不通 · 放弃 · 不要尝试 · 不适合 · 否决 ·   ← clean-room 10 词
pass · skip · reject · 不值得 · 会失败 · 概率低 · 效果差 · 已被证伪 · 有问题 · 终止 · 换方向 · 忽略 · 待定
```

含某短语的编号句出现在附录 ⇒ 该短语（或其子串）被识别；逐词消去可定位**真**标记集与其子串边界
（如"不通"是否已够、"否决"/"放弃"是否单独成词）。

**(b) 句子切分**：dropped 前段用不同句界符排列同一组短语（`。`/`！`/`？`/`；`/`\n`/`. `/无句界连续），
观察哪些被当成独立句、哪些被并入邻句。

**(c) 规范化**：锚点句分别带 ①前导列表符（`- * • · #`）②内部连续空白 ③尾随标点 ④超过 120 字符，
核对附录文本是否做了"去前导符/折叠空白/截断到 120/去尾标"（clean-room 的 `normalizeAnchor`）。

**(d) 排序与 cap 归属（extractor 内建 vs 引擎 cap）**：跑 F6（单轮 25 条）判单轮上限与保留侧；
再跑 F7（跨轮）判全局淘汰。判读树：

| 观测（F6 后） | 观测（F7 后） | 结论 |
|---|---|---|
| #6–#25（最新 20，首见序） | 淘汰最旧、剩 #6–#30 中最新的 20 | 与 clean-room 同：extractor 不 cap，引擎 cap20 最新 |
| #1–#20（最前 20） | 淘汰最旧…… | extractor 内建 cap 保留**最前** 20（差异，记录） |
| 条数 < 20 | — | extractor 有更小内建 cap（差异，记录数值与保留侧） |

> 附录里锚点出现的**顺序**与**条数**都记；clean-room 的引擎去重是"首见序、追加式"。

### P4 — Goal 提取（clean-room 规则：跳 system-reminder → 取最后实质 user 消息 → 去延续语 →
去短确认 → 取首句 → 去前导冒号/尾标点 → cap 80）

用 F8–F11 组合矩阵扫：

| 用户消息 | clean-room 预测 |
|---|---|
| 纯 `<system-reminder>` | 不设/不改 `<current-goal>` |
| 实质指令 + 尾随 `<system-reminder>` | 取指令首句，去尾随 reminder |
| `继续` / `接着` / `如上` / `如上所述` / `请继续` / `继续吧` / `go on` / `continue` | 延续语 → 目标不变 |
| `ok` / `好的` / `嗯` / `明白` / `收到` / `知道了`（含带标点） | 确认语 → 目标不变 |
| 长度 3 / 4 / 5 的实质短句 | ≤4 → null；5 → 目标=该句 |
| 一句含多个分句（`。`/`！`/`\n` 切） | 只取首句 |
| 前导冒号（`：修复 X`） | 剥 `：` 后取 |
| 长句 >80 | cap 80 |

核对 `F11` 目标切换后 `<current-goal>` 是否**整段替换、单实例、位于尾部**（与旧目标字节不同处只该块）。

### P5 — token 估计器字符类边界（clean-room 镜像 `src/compact/micro.ts`）

目标：确定每个 Unicode 区间被计入 CJK（÷1.2）还是 ascii（÷4），以及代理对/astral 的计法。
构造**纯单类**推理串：把某码位重复到超长，看保留尾长 `K`；再换下一个码位。若某码位被计为 CJK
则 `K≈floor(1.2N)`，被计为 ascii 则 `K≈4N`。

待测码位（覆盖 clean-room `isCjkCodePoint` 的每个区及其边界，加易混项）：

```
U+4E00        CJK 统一表意 起点
U+9FFF / U+A000  统一表意 上界 vs 界外
U+3400 / U+4DBF  CJK 扩展 A
U+20000 / U+2A6DF CJK 扩展 B（astral，代理对 —— 见下方重点）
U+3040-309F   平假名
U+30A0-30FF   片假名
U+AC00-D7AF   谚文音节
U+FF01 全角标点 / U+3000 全角空格   （ascii 侧，观察是否被计 1/4）
U+1F600 emoji / U+1F680  （astral 非 CJK，观察是否算 2 个 ascii）
ASCII 0x20-0x7E
```

**重点（代理对/astral 分歧点）**：clean-room 的 `tailCutIndex` 按 UTF-16 code unit 遍历并跳过低代理
项（高代理项计 1 个 ascii）；而 `micro.ts` 的估计器按 code point 遍历。对 astral 字符两者结果不同：
`tailCutIndex` 眼中一个 astral = 1 个 ascii 字符，而估计器眼中是 1 个 ascii **code point**。若闭源
用的是 code-point 计法，则同一 N 下含 astral 的保留尾长会不同。用**高密度 emoji 推理串**跑 F1，
对比实测与两种预测即可判定 Pro 采用哪种计法（若 Pro 用 code-point，clean-room 需改 `tailCutIndex`）。

类边界判读完成后，把"估计器系数 + astral 计法"作为独立参数记档（它同时影响 K1 截断点与 P3 锚点域）。

---

## 六、边界情况与不变量（每条都做成一个可执行断言）

1. **不截断直通**：推理估计 ≤ N（F2）时，wire 上的 `reasoning_content` 与内存态逐字节相同；
   重放同一轮不产生任何字节变化。
2. **空 reasoning**：`reasoning_content` 为 `''` 的工具轮 → wire 上该键存在且为空串（补 `''`
   回显规则 `openai-client.ts:434-436`）；**与"键不存在"字节不同**，两种形态都要测。
3. **纯文本 assistant 轮**：剥离 `reasoning_content` 后若有 `tool_calls` 才可能不带 `content`，
   否则补 `content:''`（`446-452`）；剥离结果逐字节一致。
4. **系统后缀幂等**：同一请求对象因 speculation/failover 重入 `stream()` 时，后缀**不得双加**
   （`559-566` copy-on-write 注释所防的事故）；用 llm-speculation/重放路径触发一次重入断言。
5. **`<excluded-paths>` append-only**：锚点只在语义变化（新锚点进入 / 挤掉最旧）时改字节；锚点
   不变时跨轮请求该块逐字节不变（cacheRead 可命中的前提）。
6. **`<current-goal>` 覆盖式 + 尾部单实例**：目标不变零抖动；切换整段替换；全消息里只此一块。
7. **resume 字节稳定**：同一会话目录 resume（meta 已冻结 `wireContext`）时，即使 env 已改，截断点
   仍用冻结 N（P2 步骤 2 已实证）；两侧一致。
8. **首启冻结 + 非法 env 回退**：全新会话读 env；`NaN`/`0`/负数/超长 → 回退默认（clean-room
   `parseIntEnv` 语义：min=1，非法回退）。测 Pro 是否同规则。
9. **非 spark 会话零差异**：把 provider 换成非 `deepseek-spark`，两侧 wire 应等于"未加载 pro 模块
   的开源基线"（注册表恒空路径）。这条证明 clean-room 没有在非 spark 会话泄漏行为。

每条断言给出通过/失败 + 差异消息编号；失败一律落到 §七差异表。

---

## 七、验收标准（checklist）

### 7.1 判定口径

- 以 3.1 捕获的**原始请求体字节**为准。逐请求比较 `messages`：
  ```bash
  # 规范比对：逐请求解析后稳定键序序列化，再 sha256
  node scripts/compare-capture.mjs probe-run/<ts>/pro/capture.ndjson probe-run/<ts>/clean/capture.ndjson
  ```
  输出：逐 `seq` 的 `MATCH / DIFF`、首个 DIFF 的 `role` 与字段路径、原始字节 vs 规范化差异标记。

### 7.2 参数结论记录表（每行 = 一个待恢复参数）

| 参数 | clean-room 猜测 | Pro 实测 | 两侧一致？ | 差异处置 |
|---|---|---|---|---|
| `truncateN.flash` | 4000 | | | 不一致则改 clean-room 默认 |
| `truncateN.pro` | 8000 | | | 同上 |
| env 覆盖名 flash/pro | `SPARK_TRUNCATE_N_FLASH/PRO` | | | 不一致则改 `parseIntEnv` 名 |
| 标记短语集合 | 10 词 | | | 增删 |
| 句子切分 / 规范化 | 见 4.1/§五 P3 | | | 对齐 |
| >20 排序与 cap 归属 | 引擎 cap、保最新 20、首见序 | | | 见 P3 判读树 |
| Goal 归一化（延续语/长度/切句/cap） | 见 §五 P4 | | | 对齐 |
| 估计器类边界 / astral 计法 | 镜像 micro.ts / UTF-16 低代理跳过 | | | 不一致则改 `estimateTokens`/`tailCutIndex` |

### 7.3 字节对齐验收清单

- [ ] F0 capability 驱动行为一致（K7 预检通过）。
- [ ] F1/F2/F3 在 P1 恢复的 N 下，两侧截断结果（含边界 L=4N / 4N+1、floor(1.2N)）逐字节全等。
- [ ] F4/F5：锚点出现域正确（只来自 dropped 前段），附录块内容/顺序/条数全等。
- [ ] F6/F7：>20 候选的保留侧与跨轮淘汰规则全等。
- [ ] F8–F11：`<current-goal>` 存在性、切换、单实例、尾部位置全等。
- [ ] §六 9 条不变量断言全部通过（含 resume、冻结、非 spark 零差异）。
- [ ] 差异表为空，或全部落在 §2.2"允许不同"清单内且已注明字段。
- [ ] 记录：两侧基座 commit、被测物版本、运行日期、env 全量、夹具哈希。

**判收**：所有 F 用例逐字节全等 + 差异表仅含允许项 ⇒ clean-room 与闭源 Pro 在 wire 字节层面对齐。
任何一条 K 类（§2.1）差异未清零 ⇒ **不判收**，按 §五对应实验补测后重跑全量。

---

## 附：执行顺序速查

```
1. 3.1 起捕获代理（透传模式）→ 2. F0 预检 capability → 3. P1 恢复 N（ASCII+CJK）
4. P2 恢复 env 名 + 冻结语义 → 5. P5 恢复类边界/astral（若 P1 出现偏差先做）
6. P3 恢复锚点规则 → 7. P4 恢复 Goal 规则 → 8. 把参数写入 src/pro/index.ts
9. 代理切回放模式，用同一 fixture 集对 A/B 各跑 F0–F11 → 10. §7.3 全量验收
```
