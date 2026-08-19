# 更新日志

## Unreleased

### 修复

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
