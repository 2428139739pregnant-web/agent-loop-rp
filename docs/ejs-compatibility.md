# EJS 兼容范围

Agent RP 只执行能够从当前 Session 日志确定性重建的模板语义。模板运行在独立 QuickJS 环境中，不会获得浏览器页面、文件、网络、模块、凭据或宿主回调。

| 能力 | 当前状态 | 说明 |
|---|---|---|
| `<% %>`、`<%= %>`、`<%- %>`、注释与空白裁剪 | 支持 | 包含条件、循环、`print` 和完全在隔离运行时内完成的 Promise |
| `char`、`user`、`charName`、`userName`、`runType` | 支持 | 默认是 `generate`；调用方可通过 `EjsTemplateTarget.runType` 明确传入 `preparation`、`render` 或 `render_permanent`，不会从宿主生命周期隐式推断 |
| `lastMessage`、`lastUserMessage`、`lastCharMessage` 与对应楼层编号 | 支持 | 从当前可见的 user/assistant Session 消息重建；没有匹配消息时内容为空、编号为 `-1` |
| `getChatMessage`、`getChatMessages` | 支持 | 支持负数楼层、角色筛选、最近数量和闭区间读取，只返回可见消息正文 |
| `variables`、`stat_data`、`getvar` 及作用域别名 | 只读支持 | 合并 global、preset、character、chat、message 和当前 MVU 状态；模板不能直接改写 Session |
| `_` 与 `YAML.stringify` | 支持 JSON 数据子集 | `_` 提供 `get`、`cloneDeep`、`mapValues`、`isEmpty`、`omit`、`pick`、`transform`；YAML 输出保持确定性并可由 YAML 1.2 读取，不提供页面对象或插件实例 |
| `setvar`、`incvar`、`decvar` | 未执行 | 需要持久事件、准备/生成/渲染阶段和失败回滚语义，不能伪装成一次性的局部修改 |
| `getwi`、`getWorldInfo` | 只读支持 | 按当前 Session 的世界书来源和条目标识读取纯文本条目；支持当前书及显式书名，找不到返回空字符串，读取次数和累计字符受限 |
| `getCharData` | 只读支持 | 从 `EjsTemplateContext.characterData` 或 `characterCards` 读取未经过模板处理的 JSON 快照；没有快照或找不到 ID/名称时返回 `null`，不访问角色卡文件 |
| `getchar`、`getChara` | 只读支持 | 使用官方默认角色定义格式或调用方传入的 EJS 格式，在同一隔离 QuickJS 中渲染；没有角色资源、递归超限或模板失败时返回空字符串 |
| `getpreset`、`getPresetPrompt` | 只读支持 | 从可选的 `presetPrompts` JSON 快照读取并在同一隔离 QuickJS 中渲染；缺少资源或名称未命中时返回空字符串，不读取磁盘预设 |
| `[GENERATE:REGEX:*]` 的 `matched_message`、`matched_message_index`、`matched_message_role` | 支持 | 每个正则命中楼层分别渲染；同一条目命中多楼层不会复用另一楼层的模板结果，也不会增加 LLM 调用 |
| `getqr`、`getQuickReply` | 未提供 | 当前没有 Quick Reply 的 JSON 资源模型，因此不伪造该接口，也不访问 UI、文件或网络；调用方应把它视为未兼容能力 |
| `activewi`、`injectPrompt`、`activateRegex`、`@@` 装饰器 | 未执行 | 会改变提示词结构或激活顺序，需要独立的 Session 事件和可检查的执行计划 |
| 页面对象、JQuery、toastr、SillyTavern 全局对象 | 不提供 | 模型提示词模板不得访问 UI、网络或宿主页面 |
| `Date`、随机数和 Host 异步 API | 不提供 | 保证同一 Session 日志可以重放出相同提示词 |

模板超过源码、输出、内存、栈、解释器工作量、资源读取或单轮执行次数限制时，只跳过对应模块或世界书条目，并返回不含模板正文的稳定失败类别。`getWorldInfo` 引用含 EJS 的条目时不会泄露未执行标签；递归渲染加入循环检测前会明确归类为不支持。

`prepareContext` 的边界：官方扩展会在酒馆运行时把变量、角色卡、预设和楼层状态合并成执行环境；模型侧这里不持有那个可变运行时。`EjsTemplateContext` 必须由调用方先整理成 JSON-only 快照，`render`/`createRenderer` 只读取该快照，不执行隐式准备、持久化写入或跨轮合并。角色卡和预设资源缺失时保持空结果，而不是回退到文件或网络读取。

兼容事实参考公开的 [ST Prompt Template 文档](https://github.com/zonde306/ST-Prompt-Template/blob/9bf9bcdfa8d0d38ab1f4f7342067bc16f347d85d/docs/reference.md)。实现依据公开接口行为独立完成，不包含其 AGPL 源代码。

上表描述的是发送给模型的 Host QuickJS 模板环境。角色卡和酒馆助手脚本所在的 iframe 另有一个受限的 `window.EjsTemplate` 兼容面，提供 `evalTemplate`、`prepareContext`、`compileTemplate`、楼层/变量/世界书读取和变量桥接写入；两者不会共享页面对象，也不会因为模板兼容而增加额外模型调用。
