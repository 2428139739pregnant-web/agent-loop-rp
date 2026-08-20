# 更新日志

## Unreleased

### 修复

- Tavern Helper 聊天 mutation 现在保留并规范化 `refresh: none/affected/all`，兼容旧的布尔值和 `options.refresh` 写法；服务端响应会回传最终 refresh 模式，避免宿主在解析或响应阶段丢失刷新语义。
- 对齐酒馆助手公开的 `setChatMessage(fieldValues, messageId, options)` 签名：支持局部更新 `message`、`data`、`extra` 等楼层字段，保留旧版 `(messageId, message)` 调用兼容；`getChatMessages` 同时支持 `0-` 形式的开放末端范围。
- 修正 ST-Prompt-Template 的 `[GENERATE:REGEX:*]`：正则型生成条目现在由自身消息扫描激活，不再被普通蓝/绿灯过滤提前丢弃，仍由本地插件 lane 处理且不增加 LLM 调用。
- 角色卡/酒馆助手 iframe 不再提供原样返回的 `EjsTemplate` 占位：补齐隔离沙盒内的 `evalTemplate`、`prepareContext`、`compileTemplate`、EJS 条件/循环/输出、楼层读取、变量读取/更新和世界书条目读取；不会额外调用 LLM，也不会开放父页面或网络能力。
- 补齐酒馆原生 `setExtensionPrompt` 位置语义：`NONE`、`IN_PROMPT`、`IN_CHAT`、`BEFORE_PROMPT`（`-1/0/1/2`）现在会分别进入扫描、主提示词后、聊天深度和主提示词前锚点；保留深度、角色、扫描开关与函数过滤器。
- 修正 ST World Info 位置映射：`2/3` 现在进入 Author's Note 前后，`5/6` 进入示例消息前后；角色卡与独立世界书的蓝灯、绿灯命中条目统一使用同一套位置语义。
- 补齐酒馆助手 `chatMetadata` 桥接：支持 `SillyTavern.getContext().chatMetadata` 与 `updateChatMetadata(values, reset)`，并将更新持久化到当前会话。
- 按酒馆助手官方消息接口修正楼层语义：`setChatMessages` 现在按 `message_id` 做局部 patch，不会因为只更新 `data`/`is_hidden` 而清空正文、角色名或 swipe；`getChatMessages` 按真实楼层号处理负数深度、`role`、`hide_state` 和 `include_swipes`，隐藏楼层也不会进入 response/worldbook 的模型提示词。
- 卡片 iframe 内的聊天楼层变更现在会按 `refresh: none/affected/all` 回刷宿主对话区；隐藏楼层继续保留上下文边界但不渲染、不送入模型，避免状态栏/插件修改后外层楼层停留在旧快照。
- 隐藏楼层现在保留在会话和原始消息 API 中，但不会被普通对话表面渲染；编辑/删除仍按原始楼层索引操作，避免隐藏楼层导致后续消息错位。
- 对齐 Tavern Helper 的聊天消息树基础 API：`getChatMessages` 支持范围、隐藏状态和 swipe 选项，新增 `createChatMessages`、`deleteChatMessages`、`rotateChatMessages`、`setChatHidden`；插入/删除/旋转/隐藏/整段替换统一写入会话 JSONL，并保留 `message_id`、角色名、`data`、`extra` 和 swipe 元数据。
- iframe 内的 `SillyTavern.getContext()` 不再只是 `{ chat: [] }` 占位：宿主会同步当前会话消息、角色/用户投影、chat id、extension prompts、MVU/变量读写和 World Info 查询入口；消息按 ST 常用的 `name`/`mes`/`is_user`/`is_system` 形状提供给卡片脚本。
- Tavern Helper iframe 事件桥对齐酒馆助手的可等待生命周期：`eventEmit` 现在等待异步监听器和注入/变量 RPC，补齐 `eventMakeFirst`、`eventMakeLast`、移除/清理监听 API 与完整 `tavern_events` 常量；生成前事件会等待所有卡片帧确认后再进入 `/api/run`，避免提示词注入竞态。
- 世界书全局扫描设置补齐 ST 的 `min_activations`/深度上限、`recursive`、`max_recursion_steps`、`include_names` 和 `use_group_scoring`；全部由确定性 matcher 执行，不增加 LLM 调用，并在 UI/API 中可持久化配置。
- 旧角色存档首次启动时会自动迁移到新的卡片世界书结构，并将迁移后的 `preprocessed.json` 持久化，避免每次启动重复迁移。
- Tavern Helper 世界书的 `before_author_note/after_author_note` 现在映射到 ST 的 5/6 位置；独立世界书蓝灯按 0–7 位置进入示例区、atDepth、Author's Note 和 outlet，旧自定义模板保留三文档回退。
- 角色卡内嵌蓝灯不再预先揉进三文档：新格式会与外部书进入同一 Store，统一参与来源预算和 ST 位置组装；同时补齐 Tavern Helper 的递归控制字段映射。
- 世界书来源预算不再在合并 Store 时丢失：角色卡/独立 World Info 的 `token_budget`、来源书身份和条目优先级会传到 matcher，先执行来源书预算再执行当前会话共享预算；独立书重启和条目开关写盘时保留书级字段，并在 trace 记录各来源书的裁剪结果。

- 世界书兼容层加入 ST `world_info_budget` / `budget_cap` 运行时收尾：按 ST 优先级本地裁剪已激活的多本世界书条目，`ignoreBudget` 条目不占预算，并把使用量与被裁剪路径写入 worldbook trace；整个过程不新增 LLM 调用。

- response 消息树加入 ST `openai_max_context` 风格的上下文预算：可在回复设置中配置总上下文 token 上限，模型输出预留空间后，从最旧历史按 user/assistant 对裁剪，系统层、世界书、示例、插件注入和当前用户输入保留；response trace 同时记录预算、估算 token、裁剪数量及超预算状态。

- 默认 response 模板接入 ST PromptManager 风格的消息树：角色卡 `mes_example` 按 speaker 拆为独立 system 消息并保留 `name`，加入 `[Example Chat]` 标记，聊天历史保留真实 user/assistant 角色，`atDepth` 条目按 depth/order/role 插入，post-history 指令位于历史之后；不带新标记的自定义 response 模板继续走旧兼容路径。
- 保留角色卡、独立世界书和 Tavern Helper 条目的 atDepth `depth`/`role` 元数据，避免到 response 阶段只剩 position 而丢失插入语义。
- 修正 Tavern Helper 函数式 `injectPrompts` 过滤器：每轮生成准备阶段按官方形状把 prompt 作为参数传入 filter，仍由 iframe 本地执行，不增加 LLM 调用。

- 对齐 ST-Prompt-Template 的世界书查询：EJS `getwi()`/`getWorldInfo()` 现在读取当前会话实际可见的角色卡、外部世界书和酒馆助手世界书，不再因为 renderer 未绑定书目而静默返回空内容。
- 实现 `[InitialVariables]` 与 `@@initial_variables`：按 JSON 优先、YAML 回退解析对象，按条目顺序深度合并，并暴露给 EJS 的 `initial` 变量作用域；保留原有 `<initvar>`/`[initvar]` 兼容。
- 保留 Tavern Helper 原始脚本树和父文件夹开关；禁用父文件夹时子脚本不会执行，同时补齐 `getScriptTrees`、`replaceScriptTrees`、`updateScriptTreesWith` 兼容 API。
- 修正 ST 世界书 fallback：secondary key 不能脱离 primary key 独立触发；enhanced 模式同一条目每轮只进行一次概率判定；蓝灯无 key 条目仍可在空扫描文本时激活。
- 按提示词模板官方规则处理 `@INJECT`：它属于扩展特殊条目，不再被普通蓝绿灯 matcher 错误拦截；继续由本地无 LLM 的插件 lane 完成注入。
- 角色卡 iframe 同步脚本树快照，让卡片脚本在宿主会话内可以查询和替换当前 scope 的 ScriptTree。
- 补齐酒馆助手 `extension` 变量作用域，按官方 `extension_id` 隔离读写，并兼容没有该字段的旧会话快照。
- iframe 变量 bridge 对齐 Tavern Helper option：补齐 `message_id`（默认 `latest`）、`script_id`（默认当前脚本）和 `extension_id` 的原样透传；`message` 读写保持独立作用域，不再误写入 chat。
- 补齐 Tavern Helper 注入的 `injectPrompts`、`uninjectPrompts`、`once`、`order`、`should_scan`、筛选和生成后消费逻辑，防止一次性注入误删新替换内容。
- 将 Tavern Helper 注入真正接入正文生成链：`should_scan` 文本进入世界书扫描缓冲，`position=in_chat` 按 ST 的 depth/order/role 规则进入 response 消息数组，`position=none` 保持扫描专用，并在成功生成后消费本轮 `once` 快照。
- iframe 运行时补齐官方全局 `injectPrompts`/`uninjectPrompts` 以及 `TavernHelper` 同名方法；调用通过 canonical RPC 写入当前聊天，`injectPrompts(..., { once })` 和返回的 `uninject()` 都能落到宿主持久化状态。
- 修正角色卡内 Tavern Helper 脚本的注入 owner：脚本顶层调用现在使用导入脚本自身的 id，不再把 iframe id 错当成 `scriptId` 导致宿主拒绝持久化。
- 对齐 `TavernHelper` 世界书方法的官方参数形状：角色卡绑定使用 `(characterName, { primary, additional })`，聊天书绑定使用 `(chatName, worldbookName)`，并补齐 `replaceWorldbook` 的 canonical mutation bridge。
- 将当前已实现的聊天、世界书、注入、变量和脚本树能力同步挂到 `window.TavernHelper`，不再只有同名全局函数，减少官方脚本因调用入口不同而失配。
- 补齐角色卡 iframe 的 Tavern Helper/ST 事件生命周期桥：修正 `tavern_events` 官方事件名，并转发聊天切换、消息发送/编辑/删除/切换、生成开始/结束/停止、角色消息渲染和世界书更新事件；事件参数按 SillyTavern 的消息索引形状传递，`getCurrentChatId()` 改为当前应用会话 ID。
- 对齐 Tavern Helper 函数式注入过滤器：在每次生成前由卡片 iframe 本地执行 `filter`，宿主只提交本轮的布尔快照，不增加 LLM 调用，并支持卡片刷新/卸载时安全结束握手。
- 对齐 ST chatHistory 的消息层：上下文 agent 选中的历史按真实 `user`/`assistant` 消息注入 response 请求，当前用户输入不会重复注入；未选中或无摘要的轮次继续丢弃。
- 世界书激活支持条目级 `scanDepth`、累计递归缓冲、`exclude_recursion`、`prevent_recursion` 和 `delay_until_recursion`，并把角色卡/独立世界书字段映射到执行层。
- 按 SillyTavern 消息计数接入世界书 `sticky`、`cooldown`、`delay`；定时效果按会话持久化，重 roll 不推进计数，分支回退会清理未来状态。
- 接入 SillyTavern 世界书包含组：贯通 `group`、`groupOverride`、`groupWeight`、`useGroupScoring`，按 sticky 优先、覆盖优先、评分和加权选择在本地收尾，避免让 LLM 决定组内互斥关系。
- 接入 ST World Info 的六个条目级全局扫描开关：角色卡、独立世界书和酒馆助手条目可选择扫描 Persona、角色描述、性格、depth prompt、场景和 `creator_notes`；未启用的字段不会进入 matcher 扫描缓冲，也不增加 LLM 调用。
- response 阶段保留 ST 世界书 0–7 插入位置，将角色定义、示例、Author Note、atDepth 和 outlet 分配到对应提示词锚点，旧版无 position 的条目继续进入兼容 worldbook block。
- 扩大回归命令覆盖范围，加入 EJS、Tavern Helper、角色卡导入和 lorebook 测试。
- 重构角色卡前端宿主：消息楼层继续由外层对话区统一滚动，卡片 HTML/CSS/JS 改在独立 iframe 文档中运行，避免 `html/body`、固定定位、全局 ID 和脚本污染宿主页面。
- 对齐 JS-Slash-Runner 的 iframe 规则：使用 `body.scrollHeight`、`requestAnimationFrame`/throttle、`ResizeObserver` 和 `--TH-viewport-height` 同步；移除项目自定义的绝对定位测量与 flex stage 高度补偿，避免宿主擅自改写角色卡布局。
- 移除旧版宿主侧的绝对定位/折叠内容高度推断；高度只由 iframe 内部按上游 `body.scrollHeight` 规则报告，宿主不再扫描或重排角色卡节点。
- iframe 运行时补齐 Tavern Helper/MVU 的变量、事件、lodash 常用方法、jQuery 轻量 fallback，并执行角色卡内置的启用 Tavern Helper 脚本。
- iframe 保留酒馆助手的稳定 iframe id、可信 origin 和父子桥接边界；不执行卡片自带的远程 `script[src]`，由宿主提供已审计的兼容 API，避免远程脚本覆盖酒馆助手桥接。
- 角色卡 iframe 增加酒馆助手同款可信 origin `<base>`，并修正第三方依赖的实际加载顺序，保证卡片相对图片、字体、样式和 jQuery UI 依赖按预期解析。
- 角色卡 iframe 的 `replaceVariables` 更新接入楼层宿主和会话变量 API，变量快照按序写入 `sessions/<id>/variables.json`，重启后仍可恢复并供模板、状态栏读取。
- 消息内容容器取消宿主额外的 segment 间距，HTML 卡片与 Markdown 正文按酒馆单一消息文本容器的边界衔接。
- 新增底层扩展适配注册表：酒馆助手与提示词模板分别拥有稳定的本地 adapter contract，运行时不再把扩展兼容逻辑散落在 response/UI 代码中。
- 新增“扩展”面板与手动更新 API：固定读取两个官方仓库的 manifest，检查和 bundle 下载并行执行，更新文件原子写入 `extensions/`；不自动执行远程 bundle，当前回复链仍使用项目内审计适配器。
- 扩展面板支持已下载版本的手动激活和回滚；旧版 registry 也会保留可见的已安装版本状态。
- Tavern Helper iframe 补齐 `getVariables`、`replaceVariables`、`updateVariablesWith`、插入/删除变量、聊天消息读写和世界书绑定 RPC；会话变量快照会在 iframe 加载后同步，避免状态栏只拿到空的初始变量。
- response 阶段改由 Prompt Template adapter 统一应用 `[GENERATE]`、`[RENDER]`、`@INJECT` 计划，不增加额外 LLM 调用；世界书与上下文 agent 继续并行。
- 删除旧消息状态栏搬运逻辑；每个楼层只渲染自己的原始消息，避免重复状态栏、重复脚本和错位。
- 显示阶段遵循 SillyTavern 的 Markdown 过滤原则：角色卡普通正则和 promptOnly 正则不在显示时二次执行，只执行 markdownOnly 脚本。
- 回复楼层改为 SillyTavern 风格的 swipe 数据：重 roll 追加到同一 assistant 楼层，楼层内显示上一条/下一条和计数，编辑、删除、切换及重启均保留候选回复。

## 2026-08-19

### 新增

- 回复设置支持动态人称选项：预置跟随角色卡、第一人称、第二人称、第三人称有限和第三人称群像。
- 人称选项支持新增、删除、重命名，并可编辑实际发送给 response agent 的提示词。
- 人称和字数设置支持自动保存，下一轮回复实时使用最新配置，无需重启服务。
- 增加回复设置 API、持久化配置和 response 阶段的 `max_tokens` 安全上限。
- 增加世界书 key-only 索引生成及对应测试，补充世界书与上下文处理链路的测试覆盖。

### 修复与优化

- 旧版 `response-settings.json` 可以自动兼容升级，缺失人称配置时使用默认选项。
- response agent 使用用户配置的实际人称提示词，而不是固定写死的人称文本。
- 完善 README 中的回复设置和实时生效说明。

### 验证

- `pnpm typecheck`
- `pnpm test:agents`：137 项测试全部通过。
