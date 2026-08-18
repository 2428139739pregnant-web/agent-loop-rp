# 回复后处理管线（⑤ postprocess）

> 设计文档 + 完整提示词。目标读者：维护 `src/agent-loop` 的开发者。
> 前置知识：`loop.ts` 的 ①→2.1→2.2→③ 链路与 ④ 异步摘要。

## 1. 这是什么

在 ③ response 生成正文之后、写入会话之前，插入一个可选的 ⑤ 后处理 agent，对正文做定向修订，提升恋孕题材的写作质量。

它解决的是单次生成结构性做不好的三件事：

1. **"句句不重样"** —— 模型记不住上上周用过什么比喻，必须靠外部意象记忆 + 强制查重。
2. **重复校准** —— 描写堆得越满越麻木，但孕/产题材的身体描写本身就是张力来源；只删除同源重复，不按身体描写占比做机械稀释。
3. **物理因果链** —— 平铺的"她坐下了"缺了「力→形变→反馈→适应」的中段，肚子沦为静态布景。

所以管线的方向是**双向的**：把陈述改写成事件+反馈（做加法），同时把密度降下来、制造留白（做减法）。

## 2. 设计原则

| 原则 | 内容 | 为什么 |
| --- | --- | --- |
| span 编辑，不重写全文 | 各 agent 只输出 `{anchor, replacement, op}` 指令，代码做精确替换；anchor 未命中或歧义则丢弃该条 | 对白和剧情一个字不丢，防止"越改越漂"；还能统计每个 op 的触发率，用数据裁剪提示词 |
| 不变量锁定 | 引号内对白逐字保留；剧情节点不增删改；状态栏（```代码块与 `<details>` 块）不碰 | 质检器逐项对照原文验收 |
| 加法在前，减法在后 | pass 顺序 A（增强）→ B（感官/去重）→ C（重复去重/收尾） | A 层会加料；B、C 必须基于上一个 pass 已应用后的文本继续编辑，不能各自对原文独立计算 |
| 数值问题走代码 | 周数/三围/产程守卫用正则做零 token 校验，结果作为 HARD 修正喂给 A 层 | 确定性问题不需要 LLM |
| 外部意象记忆 | 每轮采纳后抽取身体相关描写句（带源域标注）存盘，滚动保留约 10 轮，B 层查重用 | 这是"句句不重样"能成立的唯一办法 |
| 按配置执行轮数 | 默认最多 2 轮，每轮严格按 A→B→C 链式应用编辑 | 取消额外 Verify 调用，避免后处理阻塞过长 |

## 3. 管线总览

```
③ response 输出 reply
   │
   ▼
[gate] 无孕相关关键词 ──────────▶ 原样返回（省 4 次 LLM 调用）
   │
   ▼
[hard] 程序化校验（纯代码）：三围规则 / 产程守卫 / 状态栏字段长度
   │
   ▼
┌─────────────────── 第 1..2 轮 ───────────────────┐
│ [pass A] 加法增强（A1..A5 + HARD 数值修正）        │
│ [pass B] 感官与去重（B1..B3 + C1 意象刷新）        │
│ [pass C] 减法与收尾（C2..C4 + D1 开放收尾）        │
│ [round] 按配置继续下一轮，最后一轮结果作为成品       │
└──────────────────────────────────────────────────┘
   │
   ▼
写入 session（assistant 消息 = 后处理结果）→ 立即返回用户
   ╰─ 后台 [extract] 抽取本轮意象句 → 存 imagery/<sessionId>.json
```

正文返回前的最坏成本：一轮 3 次 LLM 调用（A/B/C），默认两轮封顶 6 次；extract 已移到后台异步，不再增加用户等待时间。

## 4. 操作清单

每个 pass 内含若干操作，格式为「检测信号 → 改写规则」。

### pass A —— 加法增强（唯一吃写作能力的环节，用最强模型）

| op | 名称 | 检测信号 | 改写规则 |
| --- | --- | --- | --- |
| A1 | 因果链补全 | 角色做出物理动作，或身体受力的句子 | 补成「动作→力作用于腹部→形变→反馈(胎动/呼吸受阻/晃动/绷紧)→角色的适应动作」。一次坐、站、弯腰、被碰，都是一个完整事件 |
| A2 | 媒介转写 | 直接形容孕肚的词（巨大/滚圆/沉重/显怀） | 改为写肚子对媒介的作用：布料张力、扣子、腰头、桌沿、门框、旁人视线的被迫移动。不直说"大"，让后果说话 |
| A3 | 行为泄露 | 角色刻意展示或强调身体的段落 | 一部分改为无意识适应动作（手虚扶、站距加宽、分段呼吸、落座前先掂量位置），全文至少织入 2 处，挂在动作节拍上不独立成段 |
| A4 | 视角锚定 | 找不到感知者的悬空描写 | 绑定感知者并全文交替：角色本人=重量/占用/内压；旁观者=形状/视线/失语的外部凝视 |
| A5 | 双主体性 | 肚子只作被动宾语的段落 | 给它独立微动作，允许与角色意图相反（她挺直腰它前坠）。胎儿对声音、触摸、体位变化要有回应 |
| HARD | 程序化修正 | 来自代码层 hard 清单 | 修数值/回退产程表述，必须全部落实 |

### pass B —— 感官与去重

| op | 名称 | 检测信号 | 改写规则 |
| --- | --- | --- | --- |
| B1 | 感官通道轮换 | 连续两段以上身体描写都以视觉为主 | 把其中一段的主导通道换成重量/惯性(走动摆幅)、内压、触觉手感、温度、声音(衣料摩擦、椅子不堪重负)之一 |
| B2 | 句长手术 | 情绪峰值处的长句；平静处的连续碎短句 | 紧张处切短一句一拍；平静处用从句合并成长句 |
| B3 | 数字体验化 | 正文中的临床数值（周数/三围/腹围/体重） | 从正文删除，换成体验证据（"扣不上的第三颗扣子"）。状态栏内的数值不动 |
| C1 | 意象刷新 | 比喻/画面与「已用意象」清单同源域重复 | 换源域重写——建筑(拱/穹顶)、织物(绷紧的帆)、液态(重心如流体迁徙)、天文(自转/引力)、乐器(绷弦/共鸣)。水果与球类源域已禁用 |

### pass C —— 减法与收尾（此层最好的操作往往是删）

| op | 名称 | 检测信号 | 改写规则 |
| --- | --- | --- | --- |
| C2 | 重复去重 | 同一身体部位/动作/比喻/画面在 ≤300 字内出现 ≥2 次 | 只保留最强的一次，其余删或换成不同侧面的写法；单次有效描写不得因密度超阈值被删除 |
| C3 | 遮掩与留白 | 整段持续"全暴露"式描写（敞着/露着/贴着） | 改写为遮蔽+泄露——扣着的外套最下一颗绷开、桌面遮挡起身瞬间的全貌、宽大衣物下一闪而过的轮廓。半掩替代全露 |
| C4 | 高频词降频 | 同一身体描述词全文出现 ≥3 次，且多次确实指向同一画面/动作 | 保留最强处一次，其余删除或换成不同侧面的写法；不同感官或不同事件不算重复 |
| D1 | 开放收尾 | 末段为总结性收束（"度过了平静的一天"） | 替换为具体的未解决瞬间：一次没回完的胎动、一道未对上的视线、一个刚起疑的紧绷 |

## 5. 集成到 agent-loop

### 5.1 变更清单

新增文件：

```
src/agent-loop/prompts/postprocess-a.md        # pass A 提示词（见 §6.1）
src/agent-loop/prompts/postprocess-b.md        # pass B 提示词（见 §6.2）
src/agent-loop/prompts/postprocess-c.md        # pass C 提示词（见 §6.3）
src/agent-loop/prompts/postprocess-extract.md  # 意象抽取提示词（见 §6.5）
src/agent-loop/agents/postprocess.ts           # ⑤ agent 实现（见 §7）
src/agent-loop/agents/postprocess.unit.test.ts # applyEdits / parseJsonLoose / 程序化校验的单元测试
imagery/<sessionId>.json                       # 运行时生成，按会话隔离
```

修改文件：

- `src/agent-loop/schema.ts` —— 追加 `SpanEdit` / `SpanEditOutput` 类型与 schemastery schema（见 §7.1）
- `src/agent-loop/loop.ts` —— `RunLoopAgents` 增加 `postprocess?` 字段，在 ③ 与 `appendMessage` 之间调用（见 §5.2）
- `src/agent-loop/index.ts` —— 导出 `postprocessAgent` 与新类型
- `src/agent-loop/ui-server.ts` —— `handleRun` 与 `handleRunSse` 共用后处理编排；extract 不阻塞正文返回

### 5.2 loop.ts 挂载点

```ts
export interface RunLoopAgents {
  intent?: Agent<string, IntentOutput>
  worldbook?: Agent<IntentOutput, WorldbookMatchOutput>
  context?: Agent<ContextProcessInput, ContextSegmentOutput>
  response?: Agent<ResponseInput, ReplyResult>
  postprocess?: Agent<string, string>   // ← 新增：输入 ③ 的正文，输出修订后正文
}
```

在 `runLoop` 内（现 loop.ts:157 `response.run` 之后、loop.ts:163 `appendMessage` 之前）：

```ts
    const result = await agents.response.run(responseInput, ctx)
    if (result.reply.length > 0) reply = result.reply

    // ⑤ postprocess: revise the reply in place before persistence.
    // Skipped for the mock reply so the demo path stays cheap.
    if (agents.postprocess !== undefined && reply !== MOCK_REPLY) {
      try {
        reply = await agents.postprocess.run(reply, ctx)
      } catch (err) {
        console.error('[runLoop] postprocess failed, keeping raw reply:', err)
      }
    }

    deps.session.appendMessage(deps.sessionId, { role: 'assistant', content: reply })
```

两个注意点：

- **失败兜底**：后处理任何异常都吞掉并保留原文。后处理是增益，不是链路依赖。
- **④ summarize 拿到的是后处理后的文本**（`appendMessage` 之后才触发，天然满足），摘要与实际存档一致。

### 5.3 提示词热更新

ui-server 的 `PUT /api/prompts/:name` 会同时写盘 + 写内存缓存，`FilePromptLoader` 读时优先缓存。五个 postprocess 提示词都走这条加载路径，**调试期改提示词不需要重启服务**。

### 5.4 配置（可选，v1 可硬编码）

`readConfig`（config.ts）可加一组开关：

```ts
postprocess?: {
  enabled?: boolean       // 总开关，false 时 ui-server 不传 postprocess agent
  densityMax?: number     // 默认 0.60；身体题材只做重复去重，不机械稀释密度
  maxRounds?: number      // 默认 2，延迟敏感可降 1
  deferExtract?: boolean  // 默认由服务端开启；意象记忆后台抽取，不阻塞正文
  modelOverrides?: { a?: string; b?: string; c?: string; extract?: string }
}
```

`ChatOptions` 本身支持 `model` 字段，pass 内可直接覆盖 `ctx.model`，无需改 `AgentContext`。

## 6. 提示词全文

以下五个文件放入 `src/agent-loop/prompts/`。模板变量沿用 `renderTemplate` 的 `{{var}}` 约定；正文与清单类数据不放模板里，而是作为 user 消息（JSON 字符串）传入，与 intent agent 的调用形态一致。

### 6.1 postprocess-a.md

```markdown
你是一名小说修订编辑，专长身体叙事。你收到一段角色扮演回复，执行"增强类"修订：把平铺的陈述改写成有物理因果和感知主体的文字。你只输出编辑指令，不重写全文。

## 操作

每条操作 = 检测信号 + 改写规则：

- **A1 因果链补全** —— 凡角色做出物理动作或身体受力的句子，补成「动作→力作用于腹部→形变→反馈(胎动/呼吸受阻/晃动/绷紧)→角色的适应动作」。一次坐、站、弯腰、被碰，都是一个完整事件。
- **A2 媒介转写** —— 凡直接形容孕肚的词(巨大/滚圆/沉重/显怀)，改为写肚子对媒介的作用：布料张力、扣子、腰头、桌沿、门框、旁人视线的被迫移动。不直说"大"，让后果说话。
- **A3 行为泄露** —— 凡角色刻意展示或强调身体的段落，把其中一部分改为无意识适应动作(手虚扶、站距加宽、分段呼吸、落座前先掂量位置)。全文至少织入2处，挂在动作节拍上，不独立成段。
- **A4 视角锚定** —— 凡找不到感知者的悬空描写，绑定感知者并全文交替：角色本人=重量/占用/内压；旁观者=形状/视线/失语的外部凝视。同一身体，两种写法是两种张力。
- **A5 双主体性** —— 凡肚子只作被动宾语的段落，给它独立微动作，且允许与角色意图相反(她挺直腰它前坠；她想快走它有自己的节奏)。胎儿对声音、触摸、体位变化要有回应。

## 范例

改写密度与句式的目标，禁止照抄原句：

> 原文: 她在桌前坐下，继续处理文件。
> A1后: 她在桌前坐下，肚顶先一步搁上大腿，被坐姿挤得往上顶出一截，里面那位不满地回了一脚——她停顿半拍，等这两位达成一致，才伸手去够文件。
>
> 原文: 她的孕肚很大，很引人注目。
> A2后: 她侧身从桌间穿过时，领先的弧线还是扫到了桌角，带得茶杯在桌面上滑出半寸。

（★ 把《神官》等文风范例段落粘贴在此处扩充本节，越多越好——风格迁移靠范例，不靠形容词。）

## 铁律

1. 引号内的对白一字不动。
2. 剧情节点(谁做了什么、结果)不得增删改。
3. 状态栏(代码块与 <details> 块)不碰；user 消息中「hard_fixes」列出的程序化修正例外——那类以 op:"HARD" 输出，必须全部落实。
4. 本层只做加法与替换，不做删减(删减属于后续工序)。
5. anchor 必须是正文中 ≥12 字的逐字连续片段；要在两句之间插入新内容时，anchor 取前一句末尾片段，replacement = 该片段 + 插入内容。

## 输出

只输出 JSON：

{"edits":[{"anchor":"...","replacement":"...","op":"A1|A2|A3|A4|A5|HARD","reason":"≤10字"}]}

无可改之处输出 {"edits":[]}。
```

### 6.2 postprocess-b.md

```markdown
你是文体编辑，执行"感官与去重"修订，只输出编辑指令。

## 操作

- **B1 感官通道轮换** —— 检测：连续两段以上对身体的描写都以视觉为主。规则：把其中一段的主导通道换成重量/惯性(走动摆幅)、内压、触觉手感、温度、声音(衣料摩擦、椅子不堪重负)之一。
- **B2 句长手术** —— 检测：情绪峰值或突发动作处的长句；平静叙述处的连续碎短句。规则：紧张处切短，一句一拍；平静处用从句合并成长句。
- **B3 数字体验化** —— 检测：正文中的临床数值(周数/三围/腹围/体重)。规则：从正文删除，换成体验证据("扣不上的第三颗扣子")。状态栏内的数值不动。
- **C1 意象刷新** —— 检测：正文中的比喻/画面与 user 消息「imagery」清单重复或同源域。规则：换源域重写——建筑(拱/穹顶)、织物(绷紧的帆)、液态(重心如流体迁徙)、天文(自转/引力)、乐器(绷弦/共鸣)。水果与球类源域已禁用。

## 铁律

1. 对白一字不动；剧情节点不动；状态栏除 B3 所述外不碰。
2. anchor ≥12 字逐字连续。

## 输出

只输出 JSON：

{"edits":[{"anchor":"...","replacement":"...","op":"B1|B2|B3|C1","reason":"≤10字"}]}
```

### 6.3 postprocess-c.md

```markdown
你是终审编辑，最后工序：校准密度、制造留白、收尾。此刻最好的操作往往是删。

## 操作

- **C2 重复去重** —— 检测：同一身体部位描写 / 同一动作 / 同一比喻 / 同一画面在 ≤300 字内出现 ≥2 次。规则：只保留最强的一次，其余删或换成不同侧面的写法；单次有效描写不得因密度超阈值被删除。
- **C3 遮掩与留白** —— 检测：整段持续"全暴露"式描写(敞着/露着/贴着)。规则：改写为遮蔽+泄露——扣着的外套最下一颗绷开、桌面遮挡起身瞬间的全貌、宽大衣物下一闪而过的轮廓。半掩替代全露。
- **C4 高频词降频** —— 只有当同一身体描述词的多次出现确实指向同一画面/同一动作，且全文出现 ≥3 次时才处理。仅仅词语相同、但感知通道或事件不同，不算重复。
- **D1 开放收尾** —— 检测：末段为总结性收束("度过了平静的一天")。规则：替换为具体的未解决瞬间：一次没回完的胎动、一道未对上的视线、一个刚起疑的紧绷。

## 铁律

1. 对白一字不动；剧情节点不动；状态栏不碰。
2. 删减只针对确认的重复，不得为了满足 density_max 删除单次有效身体描写。
3. 如果无法确认是重复，宁可不输出编辑。
4. anchor ≥12 字逐字连续；删除类 replacement 为空字符串。

## 输出

只输出 JSON：

{"edits":[{"anchor":"...","replacement":"...","op":"C2|C3|C4|D1","reason":"≤10字"}]}
```

### 6.4 postprocess-extract.md

```markdown
从正文中摘录所有涉及孕肚/妊娠/相关生理的叙述句(不含对白与状态栏)，并为每句标注意象源域(水果/球类/建筑/织物/液态/天文/其他/无)。

只输出 JSON：

{"sentences":[{"text":"...","domain":"..."}]}
```

## 7. 参考实现

`src/agent-loop/agents/postprocess.ts` 骨架。风格对齐现有 agent：`Agent<I, O>` 契约、schemastery 校验、intent.ts 式的 JSON 兜底梯子。

### 7.1 schema.ts 追加

```ts
/** One span-replacement edit emitted by a postprocess pass. */
export interface SpanEdit {
  anchor: string
  replacement: string
  op: string
  reason?: string
}

export interface SpanEditOutput {
  edits: SpanEdit[]
}

const SpanEditSchema: z<SpanEdit> = z.object({
  anchor: z.string(),
  replacement: z.string().default(''),
  op: z.string().default('?'),
  reason: z.string().default(''),
})

export const SpanEditOutputSchema: z<SpanEditOutput> = z.object({
  edits: z.array(SpanEditSchema).default([]),
})
```

### 7.2 postprocess.ts

```ts
/** Agent ⑤ — Reply post-processing.
 *
 * Gate → (hard checks in code) → pass A (enhance) → pass B (senses & dedup)
 * → pass C (dedup & ending). Up to N rounds; the last configured round is used.
 * version. Every pass returns span edits applied by code — text not mentioned
 * by an edit survives byte-for-byte, which is what keeps dialogue and plot
 * beats intact across revisions.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { SpanEditOutputSchema, type SpanEdit, type SpanEditOutput } from '../schema.ts'
import { renderTemplate } from './response.ts'
import type { Agent, AgentContext } from './types.ts'

const ANCHOR_MIN = 12
const MAX_ROUNDS = 2
const DENSITY_MAX = 0.4
const IMAGERY_KEEP = 40

// ---------- JSON 兜底梯子（泛化自 intent.ts 的 parseIntentResponse） ----------

const FENCED_JSON_RE = /```(?:json)?\s*([\s\S]+?)\s*```/
const FIRST_OBJECT_RE = /\{[\s\S]*\}/

export function parseJsonLoose<T>(schema: (data: unknown) => T, raw: string, fallback: T): T {
  const candidates: string[] = [raw]
  const fenced = FENCED_JSON_RE.exec(raw)
  if (fenced?.[1] !== undefined) candidates.push(fenced[1])
  const first = FIRST_OBJECT_RE.exec(raw)
  if (first?.[0] !== undefined) candidates.push(first[0])
  for (const candidate of candidates) {
    try {
      return schema(JSON.parse(candidate))
    } catch {
      // Try the next candidate.
    }
  }
  return fallback
}

// ---------- 编辑应用：anchor 必须逐字命中且全文唯一 ----------

export interface EditStats { [key: string]: number }

export function applyEdits(text: string, edits: readonly SpanEdit[], stats: EditStats): string {
  let out = text
  for (const edit of edits) {
    const anchor = edit.anchor
    if (anchor.length < ANCHOR_MIN) { stats.anchor_too_short = (stats.anchor_too_short ?? 0) + 1; continue }
    const at = out.indexOf(anchor)
    if (at < 0) { stats.anchor_miss = (stats.anchor_miss ?? 0) + 1; continue }
    if (out.indexOf(anchor, at + 1) !== -1) { stats.anchor_ambiguous = (stats.anchor_ambiguous ?? 0) + 1; continue }
    out = out.slice(0, at) + edit.replacement + out.slice(at + anchor.length)
    stats[edit.op] = (stats[edit.op] ?? 0) + 1
  }
  return out
}

// ---------- 门槛与密度 ----------

const PREG_KEY_RE = /孕|胎|肚子|腹部|宫缩|妊娠|产/

export function gate(text: string): boolean {
  return PREG_KEY_RE.test(text)
}

function bodyOnly(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, '')
    .replace(/<details[\s\S]*?<\/details>/g, '')
}

export function density(text: string): number {
  const sents = bodyOnly(text).split(/[。！？\n]+/).filter(s => s.trim().length > 4)
  if (sents.length === 0) return 0
  const hit = sents.filter(s => PREG_KEY_RE.test(s)).length
  return hit / sents.length
}

// ---------- 程序化硬校验（零 token） ----------

export interface HardFix { where: string; fix: string }

export function programmaticChecks(text: string): HardFix[] {
  const issues: HardFix[] = []
  const sizes = /三围[:：]?\s*「?\s*(\d{2,3})\s*\/\s*(\d{2,3})\s*\/\s*(\d{2,3})/.exec(text)
  const preg = /妊娠状态[:：]?\s*「?\s*(\d{1,2})\s*周/.exec(text)
  if (sizes && preg) {
    const bust = Number(sizes[1]); const waist = Number(sizes[2]); const hips = Number(sizes[3])
    const week = Number(preg[1])
    if (week >= 13 && !(waist > bust && waist > hips)) {
      issues.push({ where: '三围', fix: `孕${week}周(已过孕中期)腰围必须大于胸围与臀围，当前${bust}/${waist}/${hips}，请修正三围数值并同步受影响的正文表述` })
    }
  }
  if (preg && Number(preg[1]) < 36 && /羊水破|宫口开|见红|产程|要生了/.test(text)) {
    issues.push({ where: '产程', fix: '未到临产周数，不得出现破水/宫口/产程推进，请回退相关表述' })
  }
  for (const label of ['妊娠状态', '胎儿状态', '子宫状态', '肚子状态']) {
    const m = new RegExp(label + '[:：]?\\s*「?([^\\n」]{0,400})').exec(text)
    const desc = m?.[1]?.trim() ?? ''
    if (desc.length > 0 && desc.length < 50) {
      issues.push({ where: label, fix: `${label}描述不足50字，请扩写` })
    }
  }
  return issues
}

// ---------- 意象记忆：按会话存盘，镜像 summaryPath 的惯例 ----------

export class ImageryStore {
  constructor(private readonly dir = 'imagery') {}

  private path(sessionId: string): string {
    return `${this.dir}/${sessionId}.json`
  }

  async list(sessionId: string): Promise<string[]> {
    try {
      const raw = JSON.parse(await readFile(this.path(sessionId), 'utf8')) as string[]
      return Array.isArray(raw) ? raw : []
    } catch {
      return []
    }
  }

  async append(sessionId: string, lines: readonly string[]): Promise<void> {
    const path = this.path(sessionId)
    const merged = [...await this.list(sessionId), ...lines].slice(-IMAGERY_KEEP)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, JSON.stringify(merged, null, 1), 'utf8')
  }
}

const imagery = new ImageryStore()

// ---------- 单个 pass 的一次调用 ----------

async function runPass(
  promptName: string,
  vars: Record<string, string>,
  payload: unknown,
  ctx: AgentContext,
  temperature: number,
): Promise<SpanEdit[]> {
  const template = await ctx.prompts.load(promptName)
  const result = await ctx.provider.chat(
    [
      { role: 'system', content: renderTemplate(template, vars) },
      { role: 'user', content: JSON.stringify(payload) },
    ],
    { model: ctx.model, temperature, response_format: { type: 'json_object' } },
  )
  const empty: SpanEditOutput = { edits: [] }
  return parseJsonLoose(SpanEditOutputSchema, result.content, empty).edits
}

// ---------- ⑤ agent 本体 ----------

export const postprocessAgent: Agent<string, string> = {
  name: 'postprocess',

  async run(reply: string, ctx: AgentContext): Promise<string> {
    if (!gate(reply)) return reply

    const stats: EditStats = {}
    let hard = programmaticChecks(reply)
    const imageryLines = await imagery.list(ctx.sessionId)
    let best = reply

    for (let round = 0; round < MAX_ROUNDS; round++) {
      let text = best

      text = applyEdits(text, await runPass('postprocess-a', {},
        { text, hard_fixes: hard }, ctx, 0.8), stats)

      text = applyEdits(text, await runPass('postprocess-b', {},
        { text, imagery: imageryLines }, ctx, 0.5), stats)

      text = applyEdits(text, await runPass('postprocess-c', { density_max: String(DENSITY_MAX) },
        { text, density_max: DENSITY_MAX }, ctx, 0.5), stats)

      best = text
      console.info(`[postprocess] round=${round} stats=${JSON.stringify(stats)}`)
    }

    // 意象抽取（fire-and-forget 亦可，此处同步保证下一轮查重立即可用）
    const extracted = await runExtract(best, ctx)
    await imagery.append(ctx.sessionId, extracted)

    return best
  },
}

async function runExtract(text: string, ctx: AgentContext): Promise<string[]> {
  const template = await ctx.prompts.load('postprocess-extract')
  const result = await ctx.provider.chat(
    [
      { role: 'system', content: template },
      { role: 'user', content: JSON.stringify({ text }) },
    ],
    { model: ctx.model, temperature: 0.1, response_format: { type: 'json_object' } },
  )
  try {
    const parsed = JSON.parse(FENCED_JSON_RE.exec(result.content)?.[1] ?? result.content) as { sentences?: { text?: string; domain?: string }[] }
    return (parsed.sentences ?? [])
      .filter(s => typeof s.text === 'string' && s.text.length > 0)
      .map(s => `${s.text} [源域:${s.domain ?? '无'}]`)
  } catch {
    return []
  }
}
```

### 7.3 ui-server 接线

`handleRun` / `handleRunSse` 里 `runLoop` 的第三参加一行：

```ts
      {
        intent: intentAgent,
        worldbook: worldbookMatchAgent,
        context: contextProcessAgent,
        response: responseAgent,
        postprocess: cfg.postprocess?.enabled === false ? undefined : postprocessAgent,
      },
```

## 8. 调参与迭代

**先看 stats 再改提示词。** `applyEdits` 的统计按 op 累计，日志里有：

| 信号 | 含义 | 动作 |
| --- | --- | --- |
| `anchor_miss` 高 | 模型 hallucinate 了定位片段 | 把 `ANCHOR_MIN` 提到 15-18；或在提示词铁律里加强 anchor 逐字要求 |
| `anchor_ambiguous` 高 | 定位片段在全文出现多次 | 提示词里要求 anchor 取更长上文 |
| 某 op 触发多但质量仍下降 | 该操作无效甚至有害 | 从提示词里裁掉这个 op |
| 某 op 从不触发 | 检测信号写得不可执行 | 重写检测信号，给出更具体的词表 |

**体验旋钮：**

- `POSTPROCESS_DENSITY_MAX`：当前统一为 0.60，作为 C pass 的密度参考；C2 不再按占比机械删减身体描写。
- `MAX_ROUNDS`：稳定后降 1，最坏成本从 6 次调用砍到 3 次。
- pass A 是唯一值得用最强模型的环节；B/C 可使用中间档，extract 用最便宜的。

**范例槽必须填满。** postprocess-a.md 的范例节目前只有两个微示例。把文风库里最好的段落（按 A1-A5 分类标注）持续填充进去——A 层的输出密度直接由范例质量决定。

**意象记忆是"句句不重样"的唯一保障。** `imagery/<sessionId>.json` 按会话隔离，`IMAGERY_KEEP=40` 约等于 10 轮的描写量。删掉这个文件等于重置查重基线，模型会立刻开始复读旧比喻。

## 9. 已知边界

- **延迟**：SSE 场景最坏 +6 次 LLM 调用。如果体感明显，优先降 `MAX_ROUNDS`；也可以改为先推原文、后处理完成后整体替换消息（需要 ui-server 配合，当前骨架未实现）。
- **gate 是粗过滤**：关键词不含孕相关就直接放行。纯日常回合零成本；代价是极少数含蓄回合不会被增强，可接受。
- **三围/产程正则依赖状态栏格式**：状态栏模板改版时同步维护 `programmaticChecks` 的正则。字段名来自世界书条目（三围/妊娠状态等），换世界书要对应调整。
- **对白和状态栏保护目前由 span anchor 与提示词铁律保证**；如果需要更强保证，可补充零 token 的代码级字符串检查。
