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
| `excludeRecursion` | bool `false` | 递归扫描时不参与（不能被已激活条目的 content 再触发） |
| `preventRecursion` | bool `false` | 其 content 不参与递归扫描文本 |
| `matchPersonaDescription` 等 7 个 | bool `false` | 把用户 persona / 角色 description / personality / depth prompt / scenario / creator notes 纳入扫描文本（`world-info.js:295-320`） |
| `delayUntilRecursion` | number `0` | 延迟到第 N 层递归才可激活 |
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
| `sticky` / `cooldown` / `delay` | number? `null` | 定时效应：激活后保持 N 轮 / 冷却 N 轮 / 延迟 N 轮（`WorldInfoTimedEffects`，`world-info.js:475+`） |
| `role` | enum `0` | atDepth 注入的消息角色（0=system） |
| `automationId` | string `''` | 外部 API 触发 id |
| `characterFilterNames/Tags/Exclude` | — | 条目按角色卡过滤（模板外字段） |
| `triggers` | array `[]` | 生成类型触发器 |

**世界书级全局设置**（`world-info.js:69-86`）：`world_info_depth=2`（扫描最近 2 条消息，默认）、`world_info_budget=25`（占上下文 25%）、`world_info_budget_cap=0`（绝对上限，0=不限）、`world_info_case_sensitive=false`、`world_info_match_whole_words=false`、`world_info_recursive=false`、`world_info_max_recursion_steps=0`、`world_info_min_activations=0`。

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
8. 激活条目的 `content` 做 `substituteParams` 宏替换后拼接注入；其 content 若未 `preventRecursion`，追加进递归缓冲，进入下一层递归扫描（直到无新激活或达 `max_recursion_steps`）
9. `min_activations` > 0 时若激活数不足，扩大扫描深度（skew 机制）继续找

**关键词匹配细节**（`WorldInfoBuffer.matchKeys`，`world-info.js:336-360`）：
- key 形如 `/regex/flags` → 按正则匹配，**覆盖大小写/整词设置**
- 普通文本：默认 `haystack.includes(needle)`（两者都按大小写设置 toLowerCase）
- `matchWholeWords=true`：多词短语仍用 includes；单词用边界正则 `(?:^|\W)(word)(?:$|\W)`
- 扫描文本 = 最近 `scanDepth`（默认 2）条消息 + 可选 persona/角色字段 + 递归缓冲，用 `\n\x01` 连接防跨消息误匹配

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
| 蓝灯 constant 无条件激活 | 保留现有 preprocess 合并进三文档的路径，但改为**严格按 ST 语义**：constant && !disable 的条目按 order 降序拼接注入 response 的 system 区（persona 文档）。不再依赖 LLM 判断 |
| 绿灯 keyed 激活 | 支持三种模式：`ST strict` 由确定性 ST 关键词/次关键词匹配；`ST enhanced` 先保留 ST 基线，再由 ② worldbook-match agent 只追加普通绿灯的语义候选；`Agent native` 由 agent 判断普通绿灯。ST baseline 与 agent 结果交给纯代码 WorldbookResolver 去重、排序并标记 source，不新增额外 LLM 调用。蓝灯、原生 ST regex key、控制型 EJS、`@INJECT`、`[GENERATE]`、`[RENDER]`、decorator 条目先排除出 agent 候选池；EJS-only 普通条目仍按普通绿灯激活，命中后再渲染 |
| ST-Prompt-Template 特殊条目 | `worldbook-plugin.ts` 在本地生成结构化计划：`@INJECT pos/target/regex` 和 `[GENERATE:BEFORE/AFTER/idx/REGEX]` 修改正文 agent 的既有消息数组；`[RENDER:BEFORE/AFTER]` 只生成 display-only 结果；常用 `@@generate_*`/`@@render_*` 作为别名。该 lane 不调用 LLM，未覆盖的变量初始化/复杂 decorator 保留并记录 skipped |
| position | 简化映射：`0/before_char` → persona 文档（system 前段）；`1/after_char` → worldview 文档；`4/atDepth` → 交给 2.2 context-process 作为分段素材；`2/3/5/6` → 并入 style 文档尾部（v1 简化，注释说明与 ST 的差异） |
| order 排序 | 同一注入点内 order 降序拼接 |
| mes_example | preprocess 新增第四文档「示例对话」：`<START>` 分组、宏替换后注入 response prompt（示例消息区，位于人设后历史前）。**当前项目完全没接此字段，是最大缺口** |
| system_prompt / post_history_instructions | preprocess 提取；response 组装时 system_prompt 前置、post_history 追加在历史之后（宏替换） |
| {{user}}/{{char}} 宏 | 全链路替换：卡文本、世界书 content 与 key、开场白。与 A3 的 persona 联动（userPersona.name） |
| probability / scanDepth / caseSensitive / matchWholeWords / useRegex / selectiveLogic | 条目级参数透传到代码匹配器（ImportedLorebookEntry 已有部分字段，补全缺失的 delayUntilRecursion/ignoreBudget/group 系可先留默认） |
| 世界书级 scan_depth | 全局设置项（配置 API + 前端输入），默认 2 |

### 可选（后置）

- token 预算（budget/cap/ignoreBudget）—— 本项目上下文压力小，可先只做条目数上限
- sticky/cooldown/delay 定时效应、递归扫描（excludeRecursion/preventRecursion/delayUntilRecursion）—— 需要 chat_metadata 级状态，v1 跳过
- 包含组（group/groupWeight）—— 跳过
- vectorized 紫灯 —— 跳过（无向量库）
- matchPersonaDescription 等 7 开关 —— 可选做 2 个（persona/character description）
- persona AT_DEPTH 注入 —— v1 只做 IN_PROMPT
- `{{random}}`/`{{roll}}`/时间宏 —— 小工作量，顺手做

### 与 ST 的明确差异（要写进代码注释）

1. 普通绿灯匹配由世界书模式决定：strict 只走 ST，enhanced 为 ST + agent，native 只走 agent；Resolver 纯代码合并，probability 掷骰与宏替换在代码层收尾
2. position 2/3/5/6/7 并入文档尾部，不精确复刻 ST 的插入点
3. 定时效应/递归/包含组/向量暂不支持
4. token 计数用字符数近似（无 tokenizer 依赖）

## 9. 验收口径（A5 完成标准）

1. 导入的卡里 constant 条目每轮都在 response 的 system 中（trace 可见），不受消息内容影响
2. 绿灯条目由 ② agent 基于「最近 N 条消息 + 条目参数」选择激活；agent 的输入里能看到 key/secondary/逻辑标注（trace 验证）；prompt 中有条目参数的酒馆语义说明
3. probability < 100 的条目在 agent 选中后仍有对应概率出现（统计冒烟）
4. mes_example / system_prompt / post_history_instructions 三字段进入 response prompt（trace 截图/字段检查）
5. {{user}}/{{char}} 在开场白、卡文本、世界书 content 与 key 中完成替换
6. 现有功能（角色库/会话/独立世界书开关/trace/persona）回归不破
