# 独立 MVU 变量处理管线

MVU 不属于正文生成 agent，也不属于 ⑤ postprocess 的修订 pass。它模拟酒馆扩展在 assistant 正文生成完成后做的一次额外分析：读取当前变量快照和最终正文，依据角色卡中的变量规则生成机器更新块，再由 Harness 校验后写入 assistant 消息。

## 生命周期

```text
response(正文) → postprocess(A/B/C) → ai_output 正则 → mvu(额外 LLM) → append assistant
```

`mvu` 阶段不会改写正文。它只返回经过 `normalizeMvuSupplement` 和 `applyMvuReply` 校验的 `<UpdateVariable>` 或 legacy `<update>` 块；模型调用失败、输出非法或没有变量规则时，正文照常落库。

这样安排有两个目的：

- 后处理和 `ai_output` 正则先确定用户可见正文，MVU 不会读到未完成的草稿，也不会被输出正则误伤。
- 重 roll 复用 intent/worldbook/context，但每个新正文都必须重新做 MVU 分析，避免把上一版回复的状态更新带到新回复。

## 独立配置

WebUI 的「MVU 变量处理（独立 LLM）」面板对应 `mvu-settings.json`，支持：

- `enabled`：MVU 总开关；
- `model`：变量处理模型，留空时只回退到主 API 配置的模型；
- `temperature`：变量分析温度，默认 `0`；
- 命名处理预设：切换、另存为、覆盖和删除；
- `src/agent-loop/prompts/mvu.md`：可从提示词面板热编辑的处理提示词。

当前设计复用主 API 的 provider/base URL/API key，仅把模型、温度、提示词和 preset 独立出来。这样不会重复保存密钥，也符合“变量处理模型独立配置”的需求。后续如果确实需要把 MVU 放到另一家 API，再扩展 preset 的连接字段即可，不会改变阶段边界。

## API

- `GET/PUT /api/mvu-settings`
- `POST /api/mvu-presets`
- `PUT/DELETE /api/mvu-presets/:id`
- `GET/PUT /api/prompts/mvu`
- `POST /api/sessions/:id/mvu/retry` — 单独对最新一条 assistant 回复重算 MVU 变量
  - 行为：剥离既有 `<UpdateVariable>` 块后，基于当前 `statData` 与最近一段正文再走一次独立 MVU LLM
    调用，校验通过后把新的机器块追加回 assistant 消息并刷新会话 `mvuState`；变量失败时返回 `{ applied: false, error }`，
    不会重 roll 也不会清空原 prose。Body 支持 `{ appendToReply?: boolean, update?: string }`，
    其中 `update` 用于把手动编辑的 JSON Patch 走与模型输出完全相同的校验路径。
  - 返回：`{ applied, appended?, mvuState, update?, appliedOperations?, history?, error? }`。
  - 前端：聊天区域最新一条 assistant 楼层提供 “重算 MVU” 按钮，无需打开 Trace 面板；点击后通过 `setMvuState`
    触发原有的 `useEffect` → `syncFrameState` 链，角色卡 iframe 状态栏立刻收到新的 `stat_data`。

SSE trace 使用名称 `mvu`，token 统计也单独落在 `agents.mvu`。JSON `/api/run?format=json` 同样走独立 MVU 调用，但目前 JSON 路径不发送 SSE trace。
