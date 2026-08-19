# SillyTavern 源码调研 → 本项目适配规格

> 调研对象：SillyTavern/SillyTavern `release` 分支（2026-08 快照）。
> 用途：指导本项目（agent-loop）的世界书/角色卡/Persona 适配开发。所有结论以源码为证，标注 `文件:行号`。
> 本项目架构回顾：①intent → ②worldbook-match → 2.2context-process → ③response（角色 = persona/worldview/style 三文档）→ ④summarize。

## 1. World Info 条目字段全表

来源：`public/scripts/world-info.js:4004-4043`（`newWorldInfoEntryDefinition`）。

| 字段 | 类型/默认 | 语义 |
| --- | --- | --- |
| `key` | array `[]` | 主关键词。空 = 只能靠 constant/sticky/外部激活 |
| `keysecondary` | array `[]` | 次关键词（配合 selectiveLogic） |
| `comment` | string `''` | 备注/条目名 |
| `content` | string `''` | 条目正文（注入 prompt 的内容） |
| `constant` | bool `false` | **蓝灯**：无条件每轮激活（见 §2） |
| `vectorized` | bool `false` | 紫灯：向量检索激活（依赖 Data Bank 向量库） |
| `selective` | bool `true` | 历史遗留：现代版本所有条目都是 selective，实际由 keysecondary+logic 决定行为 |
| `selectiveLogic` | enum `0` | 次关键词逻辑：`0=AND_ANY 1=NOT_ALL 2=NOT_ANY 3=AND_ALL`（`world-info.js:33`） |
| `addMemo` | bool `false` | UI 备注开关 |
| `order` | number `100` | 同位置内排序：**order 降序**（`world-info.js:87` `sortFn=(a,b)=>b.order-a`） |
| `position` | number `0` | 插入位置枚举（见 §4） |
| `disable` | bool `false` | 条目禁用 |
| `ignoreBudget` | bool `false` | 不受 token 预算约束（超预算后仍可进，但排在预算内条目之后） |
| `excludeRecursion` | bool `false` | 递归扫描时不参与（当前确定性 lorebook inspector 已实现） |
| `preventRecursion` | bool `false` | 其 content 不参与递归扫描文本（当前已实现） |
| `matchPersonaDescription`、`matchCharacterDescription`、`matchCharacterPersonality`、`matchCharacterDepthPrompt`、`matchScenario`、`matchCreatorNotes` | bool `false` | 按条目开关把用户 persona / 角色 description / personality / depth prompt / scenario / creator notes 纳入扫描文本（`world-info.js:295-320`）；本项目已在本地扫描器执行 |
| `delayUntilRecursion` | number `0` | 延迟到第 N 层递归才可激活（`true` 按第 1 层处理；当前已实现） |
| `probability` | number `100` | 激活概率 %（`world-info.js:4907-4925`：`Math.random()*100 <= probability` 则通过；sticky 条目免掷） |
| `useProbability` | bool `true` | 概率开关 |
| `depth` | number `4` | position=atDepth(4) 时的插入深度（`DEFAULT_DEPTH=4`，`world-info.js:96`） |
| `outletName` | string `''` | position=outlet(7) 时注入到指定插座 |
| `group` | string `''` | 包含组：同组条目按 groupWeight 权重竞争，只进一个 |
| `groupOverride` | bool `false` | 组内强制选中 |
| `groupWeight` | number `100` | 组内权重（`DEFAULT_WEIGHT=100`） |
| `scanDepth` | number? `null` | 条目级扫描深度覆盖；null = 用全局 `world_info_depth` |
| `caseSensitive` | bool? `null` | 条目级大小写敏感覆盖；null = 用全局（默认 false） |
| `matchWholeWords` | bool? `null` | 条目级整词匹配覆盖；null = 用全局（默认 false） |
| `useGroupScoring` | bool? `null` | 组打分 |
| `sticky` / `cooldown` / `delay` | number? `null` | ST 定时效应字段；已按消息计数接入会话级状态机，支持跨轮保持、冷却和延迟 |
| `role` | enum `0` | atDepth 注入的消息角色（0=system） |
| `automationId` | string `''` | 外部 API 触发 id |
| `characterFilterNames/Tags/Exclude` | — | 条目按角色卡过滤（模板外字段） |
| `triggers` | array `[]` | 生成类型触发器 |

**世界书级全局设置**（`world-info.js:69-86`）：`world_info_depth=2`（扫描最近 2 条消息，默认）、`world_info_budget=25`（占上下文 25%）、`world_info_budget_cap=0`（绝对上限，0=不限）、`world_info_case_sensitive=false`、`world_info_match_whole_words=false`、`world_info_recursive=false`、`world_info_max_recursion_steps=0`、`world_info_min_activations=0`。本项目当前把 `scan_depth`/`recursive_scanning` 以及条目递归控制映射进 `ImportedLorebook`；确定性 inspector 执行递归扫描，独立世界书 JSON 还兼容顶层 `recursive` 别名。`sticky/cooldown/delay` 由宿主按会话消息计数维护，不依赖 LLM。

## 2. 蓝灯 vs 绿灯：激活语义（`checkWorldInfo`，`world-info.js:4597` 起）

每轮生成的扫描循环里，条目激活判定顺序（`world-info.js:4770-4876`）：

1. `disable` → 跳过；`@@dont_activate` 装饰器 → 跳过
2. 外部激活（API）→ 直接激活
3. **`constant === true`（蓝灯）→ 无条件激活**，不需要任何关键词。这就是"常驻注入"
4. `sticky` 生效中 → 激活（并免后续概率掷骰）
5. 无 `key` 且非上述情况 → 跳过
6. **绿灯（keyed）**：在扫描文本中匹配主关键词（首个命中即可）。关键词先过 `substituteParams`（宏替换）
   - 无次关键词 → 激活
   - 有次关键词 → 按 `selectiveLogic` 判定（`world-info.js:4845-4870`）：
     - `AND_ANY(0)`：任一次关键词命中 → 激活
     - `NOT_ALL(1)`：任一次关键词**未**命中 → 激活
     - `NOT_ANY(2)`：所有次关键词都未命中 → 激活
     - `AND_ALL(3)`：所有次关键词命中 → 激活
7. 激活集合再做：包含组过滤（`filterByInclusionGroups`）→ 概率掷骰 → token 预算截断
8. 激活条目的 `content` 做 `substituteParams` 宏替换后拼接注入；其 content 若未 `preventRecursion`，追加进**累计**递归缓冲，进入下一层递归扫描。`excludeRecursion` 阻止条目从递归文本触发，`delayUntilRecursion` 控制可进入的递归层级；当前本项目 inspector 重复扫描直到没有新条目。跨消息 `sticky/cooldown/delay` 由 `src/agent-loop/worldbook-timed-effects.ts` 按消息计数维护：普通生成提交激活时间点，重 roll 不推进状态。
9. `min_activations` > 0 时若激活数不足，扩大扫描深度（skew 机制）继续找

**关键词匹配细节**（`WorldInfoBuffer.matchKeys`，`world-info.js:336-360`）：
- key 形如 `/regex/flags` → 按正则匹配，**覆盖大小写/整词设置**
- 普通文本：默认 `haystack.includes(needle)`（两者都按大小写设置 toLowerCase）
- `matchWholeWords=true`：多词短语仍用 includes；单词用边界正则 `(?:^|\W)(word)(?:$|\W)`
- 扫描文本 = 最近 `scanDepth`（默认 2）条消息 + 条目显式选择的 persona/角色字段 + 递归缓冲，用 `\n\x01` 连接防跨消息误匹配；未开启的全局字段不会进入该条目的扫描文本

**本项目递归实现边界**：`src/import/lorebook.ts` 的 `inspectLorebook`/`inspectLorebooks` 已实现 book-level recursive switch、entry-level scan-depth override、累计递归文本、`excludeRecursion`、`preventRecursion` 和 `delayUntilRecursion`，并有单元测试覆盖。跨轮 timed effects 和包含组另由会话级确定性状态机维护；向量匹配和所有宿主分支编辑边界仍未完全复刻 ST。

## 3. 排序与预算

- 排序：全局 `sortFn` = **order 降序**（`world-info.js:87`）；概率/预算检查前再按 sticky 优先 + 原序稳定排序（`world-info.js:4881-4886`）
- 预算：`budget = world_info_budget% × maxContext`，`budget_cap` 为绝对上限；逐条累计 token，超出即停（`ignoreBudget` 条目不受限但排后）（`world-info.js:4624-4640, 4889-4955`）

## 4. position 枚举与注入位置（`world-info.js:855-870`）

| 值 | 名称 | 注入到 |
| --- | --- | --- |
| 0 | before | 角色定义**之前** |
| 1 | after | 角色定义**之后** |
| 2 | ANTop | Author's Note 顶部 |
| 3 | ANBottom | Author's Note 底部 |
| 4 | atDepth | 聊天历史中 `depth` 深度处（默认 4，role 默认 system） |
| 5 | EMTop | 示例消息区顶部 |
| 6 | EMBottom | 示例消息区底部 |
| 7 | outlet | 自定义插座 |

角色卡内嵌 character_book 的换算（`world-info.js:5517`）：`extensions.position ?? (position==='before_char' ? 0 : 1)`。

### 4.1 当前 response 的位置分桶

本项目 response 阶段先由 `splitWorldbookMatches` 分为 `beforeCharacter`、`afterCharacter`、`beforeExamples`、`afterExamples`、`beforeAuthorNote`、`afterAuthorNote`、`atDepth`、`outlet` 和 `unplaced` 九个桶；桶内按 `order` 升序、`weight` 降序（再按 path）稳定排序。默认 `response.md` 带有 `agent-rp:st-message-tree` 标记，随后按 ST PromptManager 风格组装真实消息层；旧版自定义 response 模板没有该标记时仍保留扁平模板兼容路径。当前模板锚点如下：

| ST position | 本项目桶 | response 锚点 |
| ---: | --- | --- |
| 0 | `beforeCharacter` | persona 段 |
| 1 | `afterCharacter` | worldview 段 |
| 2 | `beforeExamples` | `mes_example` 前 |
| 3 | `afterExamples` | `mes_example` 后 |
| 4 | `atDepth` | 按 `depth`、`order`、`role` 插入聊天历史消息数组 |
| 5 | `beforeAuthorNote` | `post_history_instructions` 段 |
| 6 | `afterAuthorNote` | `post_history_instructions` 段 |
| 7 | `outlet` | 与 `unplaced` 合并进旧 `worldbook_block` |

没有受支持 position 的条目进入 `unplaced`。默认消息树中，角色卡 `mes_example` 会解析成带 `name` 的独立 system 消息，并在示例前加入 `[Example Chat]` 标记；`post_history_instructions` 位于聊天历史之后。当前没有独立 Author's Note/outlet host 对象，position 5/6 仍合并到 post-history，position 7 与 unplaced 合并为激活世界书段。独立世界书的 constant 条目走另一条简化映射：`0 → persona`、`1 → worldview`、`2–7 → style`。

## 5. 角色卡 V2/V3 字段与消费方式

来源：`src/endpoints/characters.js:518-603` + `public/script.js:4560-4680`（prompt 组装）。

| 字段 | ST 消费方式 |
| --- | --- |
| `name` | 角色名，{{char}} 宏源 |
| `description` | → prompt 的 characterDescription（角色定义主体） |
| `personality` | → characterPersonality（"Personality: ..." 段，跟在 description 后） |
| `scenario` | → "Scenario: ..." 段 |
| `first_mes` | 开场白（首条 assistant 消息） |
| `mes_example` | 示例对话：`<START>` 分隔多组，`{{user}}:`/`{{char}}:` 行；注入在角色定义后、聊天历史前 |
| `creator_notes` | 仅 UI 展示（卡片信息），不进 prompt（除非条目 matchCreatorNotes 打开） |
| `system_prompt` | 卡片自定义系统提示词（power_user 设为可覆盖主 system prompt） |
| `post_history_instructions` | 注入在**聊天历史之后**（对模型是最后的强调指令） |
| `alternate_greetings` | 备选开场白数组（支持 string 或 array，`characters.js:572-575`） |
| `character_book` | 内嵌世界书（§1-4 语义） |
| `tags` / `creator` / `character_version` | 元信息，UI 展示与过滤 |
| `extensions` | 兼容字段袋（含 world 书 position/probability/depth 等迁移值） |

**ST 默认 prompt 组装顺序**（`public/script.js:4568-4680`）：system prompt → persona 描述（IN_PROMPT 时）→ 角色定义（description/personality/scenario）→ 世界书 before → 示例消息（含 EMTop/EMBottom 条目）→ **聊天历史**（atDepth 条目插进历史）→ 世界书 after/atDepth → Author's Note → post_history_instructions。

## 6. Persona 系统（`public/scripts/personas.js`）

- 存储：`power_user.personas = { avatarId: name }`；`power_user.persona_descriptions = { avatarId: { description, position, depth, role } }`（`personas.js:509-527`）
- `name1`（当前用户名）即 {{user}} 宏源；切 persona = 换头像 + 换 name1
- 描述注入位置枚举（`personas.js:88-96`）：`IN_PROMPT=0`（默认，system 区）、`AT_DEPTH=4`（历史中 depth 处，默认 depth=2, role=0）、`NONE=9`（不注入）；AFTER_CHAR/TOP_AN/BOTTOM_AN 已弃用
- persona 可绑定专属 lorebook（`persona_description_lorebook`）

## 7. 宏系统（值得支持清单）

`public/scripts/macros.js` + `macros/definitions/*`。按本项目价值排序：

1. `{{user}}` / `{{char}}` —— 必须。替换时机：WI key 匹配前、WI content 注入前、角色卡所有文本字段、开场白
2. `{{persona}}` —— 用户 persona 描述全文
3. `{{time}}` / `{{date}}` / `{{weekday}}` —— 时间宏
4. `{{random:a,b,c}}` / `{{pick:a,b,c}}` —— 随机/固定随机选择
5. `{{roll:NdM}}` / `{{roll:dN}}` —— 骰子
6. `{{getvar::x}}` / `{{setvar::x::y}}` —— 变量（本项目可后置）
7. `{{lastMessage}}` / `{{input}}` —— 上下文引用
8. `{{// 注释}}` —— 生成时剥离
9. `{{idle_duration}}`、`{{width}}×{{height}}` 等 —— 可跳过

## 8. 适配映射：ST 机制 → 本项目落地方案

### 必做（A5 范围）

| ST 机制 | 本项目落地 |
| --- | --- |
| 蓝灯 constant 无条件激活 | `constant && enabled` 条目不进入 2.1 agent 候选池；角色卡内嵌蓝灯在 preprocess 合并进三文档，独立书蓝灯由 response 每轮注入。独立书按 ST position 做 `0 → persona`、`1 → worldview`、`2–7 → style` 简化映射；实际代码仍会按 `probability/useProbability` 处理可掷骰条目 |
| 绿灯 keyed 激活 | 支持三种模式：`ST strict` 由确定性 ST 关键词/次关键词匹配；`ST enhanced` 先保留 ST 基线，再由 ② worldbook-match agent 只追加普通绿灯的语义候选；`Agent native` 由 agent 判断普通绿灯。ST baseline 与 agent 结果交给纯代码 WorldbookResolver 去重、排序并标记 source，不新增额外 LLM 调用。蓝灯、原生 ST regex key、控制型 EJS、`@INJECT`、`[GENERATE]`、`[RENDER]`、decorator 条目先排除出 agent 候选池；EJS-only 普通条目仍按普通绿灯激活，命中后再渲染 |
| ST-Prompt-Template 特殊条目 | `worldbook-plugin.ts` 在本地生成结构化计划：`@INJECT pos/target/regex` 和 `[GENERATE:BEFORE/AFTER/idx/REGEX]` 修改正文 agent 的既有消息数组；`[RENDER:BEFORE/AFTER]` 只生成 display-only 结果；常用 `@@generate_*`/`@@render_*` 作为别名。该 lane 不调用 LLM，未覆盖的变量初始化/复杂 decorator 保留并记录 skipped |
| World Info parser mapping | 角色卡条目从 `extensions.selectiveLogic/probability/useProbability/position/scan_depth/exclude_recursion/prevent_recursion/delay_until_recursion`（并兼容直接字段）归一化；独立 World Info 从 `entries` 字典读取，兼容顶层 `recursive`/`recursiveScanning`，将 `selectiveLogic` 数字/枚举名、禁用、概率和 position 映射到统一模型。未知字段不进入执行模型 |
| recursive scanning | `src/import/lorebook.ts` 的 deterministic inspector 已执行 `recursiveScanning`、entry `scanDepth`、累计递归 buffer、`excludeRecursion`、`preventRecursion` 和 `delayUntilRecursion`；递归控制不再写成 inert。它不是跨轮 timed-effects 状态机 |
| position / response buckets | `response.ts` 先将匹配结果分为 `beforeCharacter`、`afterCharacter`、`beforeExamples`、`afterExamples`、`beforeAuthorNote`、`afterAuthorNote`、`atDepth`、`outlet`、`unplaced`。默认 ST 消息树把这些桶分别接到角色定义、`mes_example` 前后、聊天历史深度插入、post-history 和激活世界书消息层；旧自定义模板仍使用兼容锚点 |
| order 排序 | 匹配条目桶内按 `order` 升序、`weight` 降序和 path 稳定排序；独立 constant 文档块保留 ST 风格按 `order` 降序 |
| mes_example | preprocess 提取 `<START>` 分组后的 `mes_example`，response 按 ST 的 speaker 行解析成独立 system 消息并保留 `name`，示例前加入 `[Example Chat]`；position 2/3 条目包在其前后 |
| system_prompt / post_history_instructions | preprocess 提取；默认消息树中 system_prompt 进入控制 system 消息，post_history 追加在历史之后（宏替换） |
| {{user}}/{{char}} 宏 | 全链路替换：卡文本、世界书 content 与 key、开场白。与 A3 的 persona 联动（userPersona.name） |
| probability / scanDepth / caseSensitive / matchWholeWords / useRegex / selectiveLogic | 参数进入确定性 ST lane 或统一 `ImportedLorebookEntry`/`WorldbookEntry`；概率在代码层收尾，regex 走隔离 deterministic lane，不能让 agent 重解释原生 regex 条目 |
| 世界书级 scan_depth | 世界书匹配设置默认扫描最近 2 条消息；角色卡/独立书的 parser 另保留书级递归开关和已支持的 entry-level override |
| Tavern Helper `injectPrompts` | Host state 实现 `injectPrompts`、`uninjectPrompts`、按 script replacement；prompt id 全局唯一，重复 id 替换，其他脚本 prompt 保留；生成时 `should_scan` 进入 World Info 扫描，`in_chat` 按 ST 的 depth/order/role 插入 response 消息，`none` 仅扫描 |
| `once` / `filter` | selection 按 `order` 排序，`filter:false` 和同步/异步 host predicate 都可排除；只消费本次实际选中的 once snapshot，并按 id + script id + content 防止晚到完成事件删除新替换；iframe API 已接通官方 `injectPrompts`/`uninjectPrompts`，函数型 filter 跨 JSON bridge 时仅保留同步 false 快照 |
| iframe variable scopes | iframe bridge 实现 `global`、`preset`、`character`、`chat`、`message`、`script`、`extension` 七类 scope；`message_id` 默认 `latest`，`script_id` 默认当前脚本，`extension` 必须带 `extension_id` 并按 id 隔离 |

### 可选（后置）

- token 预算（budget/cap/ignoreBudget）—— 当前仍未完全复刻 ST PromptManager 的 tokenizer、budget_cap 和逐条截断；后续应在消息树之上实现确定性的历史裁剪，并在 trace 中报告被裁剪消息
- 更复杂的 timed-effects 边界——基础 `sticky/cooldown/delay` 已实现；仍需继续对齐 ST 的所有 chat_metadata 分支编辑细节
- 包含组（`group/groupOverride/groupWeight/useGroupScoring`）——已在 matcher 中按确定性 ST 管道执行；仍需补齐与完整 Host 递归/预算生命周期的所有边界
- vectorized 紫灯 —— 跳过（无向量库）
- 六个全局扫描开关 —— 已接入角色卡、独立 World Info 和 Tavern Helper 条目；按条目 opt-in 后由本地 matcher 拼入扫描缓冲，不增加 LLM 调用
- persona AT_DEPTH 注入 —— v1 只做 IN_PROMPT
- `{{random}}`/`{{roll}}`/时间宏 —— 小工作量，顺手做

### 与 ST 的明确差异（要写进代码注释）

1. 普通绿灯匹配由世界书模式决定：strict 只走 ST，enhanced 为 ST + agent，native 只走 agent；Resolver 纯代码合并，probability 掷骰与宏替换在代码层收尾
2. 默认 response 消息树已真实保留 position 2/3 的示例前后层、position 4 的 atDepth 深度插入和 post-history 顺序；position 5/6/7 仍因缺少独立 Author's Note/outlet host 而采用兼容合并
3. 基础 sticky/cooldown/delay 定时效应、包含组和六个全局扫描开关已支持；向量匹配和部分 chat_metadata/分支编辑边界暂不支持，递归扫描仍只实现确定性 entry/content 语义
4. Tavern Helper 的任意函数型 `filter` 不能跨持久化 iframe 快照执行；当前宿主只保存并使用已解析的布尔筛选结果
5. token 预算尚未完全复刻 ST PromptManager 的 `maxContext`/`budget_cap`/`ignoreBudget` 组合；当前保留 response `max_tokens` 和字符数近似统计

## 9. 验收口径（A5 完成标准）

1. 导入的卡里 constant 条目每轮都在 response 的 system 中（trace 可见），不受消息内容影响
2. 绿灯条目由 ② agent 基于「最近 N 条消息 + 条目参数」选择激活；agent 的输入里能看到 key/secondary/逻辑标注（trace 验证）；prompt 中有条目参数的酒馆语义说明
3. probability < 100 的条目在 agent 选中后仍有对应概率出现（统计冒烟）
4. mes_example / system_prompt / post_history_instructions 三字段进入 response prompt（trace 截图/字段检查）
5. {{user}}/{{char}} 在开场白、卡文本、世界书 content 与 key 中完成替换
6. 现有功能（角色库/会话/独立世界书开关/trace/persona）回归不破
