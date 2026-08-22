# MVU 状态栏占位符修复

## 问题描述

在「在全是恶女婊子的异世界开后宫！」这张卡中，状态栏在变量更新之后不出现了。经检查发现：

1. **开场白自带 `<StatusPlaceHolderImpl/>`**，所以状态栏显示正常
2. **普通回复经过 MVU 后**，`<StatusPlaceHolderImpl/>` 没有被添加到正文末尾
3. **手动添加占位符后**，出现了状态栏拉伸问题

## 根本原因

我们的实现与 SillyTavern/MVU 的原始处理链不一致：

### SillyTavern/MVU 的正确流程

```text
AI 回复
  ↓
MVU 解析 <UpdateVariable> / <update>
  ↓
更新当前楼层的 message.data.stat_data
  ↓
将 <StatusPlaceHolderImpl/> 写入该楼层正文末尾
  ↓
发送给模型前：promptOnly 正则删除占位符
  ↓
显示给用户时：markdownOnly 正则把占位符替换成状态栏 HTML
  ↓
状态栏通过当前楼层的 message.data 读取变量
```

### 我们之前的错误实现

```typescript
function writeMvuBackToAssistant(message, statData, update) {
  // ...
  // ❌ 错误：在应用 patch 之前就添加占位符
  const nextContent = ensureStatusPlaceholder(syncAssistantSwipe(message, message.content).content)
  // ...
}

// 调用方
const writeback = writeMvuBackToAssistant(last, currentMvu.statData, mvuResult.update)
if (writeback !== undefined) {
  // ❌ 这里又尝试添加占位符，但 writeback.message.content 已经有了
  const contentWithUpdate = `${writeback.message.content}...`
  const anchored = ensureStatusPlaceholder(contentWithUpdate)
}
```

**核心问题**：
1. `writeMvuBackToAssistant` 在应用 patch 时就添加了占位符
2. 但调用方在追加 `<UpdateVariable>` 块后又尝试添加
3. 结果是占位符出现在 `<UpdateVariable>` 块之前，而不是整个消息的末尾
4. 更严重的是，**如果本轮没有变量更新（MVU 返回 undefined），占位符根本不会被添加**

## 修复方案

### 1. 修正 `writeMvuBackToAssistant` 函数

```typescript
function writeMvuBackToAssistant(
  message: ChatMessage,
  statData: JsonValue,
  update: string,
): AssistantDataWriteback | undefined {
  if (message.role !== 'assistant') return undefined
  const applied = applyMvuReply(statData, update)
  if (applied === undefined) return undefined
  
  // ✅ 修复：不再在这里添加占位符，由调用方在追加 update 块后统一添加
  const swipeSynced = syncAssistantSwipe(message, message.content)
  
  const dataRecord: Record<string, unknown> = (() => {
    const current = swipeSynced.data
    return current !== undefined && typeof current === 'object' && !Array.isArray(current)
      ? { ...current, stat_data: applied.statData }
      : { stat_data: applied.statData }
  })()
  return { message: { ...swipeSynced, data: dataRecord }, updatedStatData: applied.statData }
}
```

### 2. 调用方按正确顺序处理

```typescript
// ⑤ MVU 阶段：有变量更新时
if (mvuResult !== null && mvuResult.update !== undefined) {
  const writeback = writeMvuBackToAssistant(last, currentMvu.statData, mvuResult.update)
  if (writeback !== undefined) {
    // 1. 移除旧占位符
    const baseContent = writeback.message.content.replace(
      new RegExp(`\\s*${STATUS_PLACEHOLDER_TOKEN.replace(/[<>]/gu, '\\$&')}\\s*$`, 'u'),
      '',
    )
    // 2. 追加 <UpdateVariable> 块
    const contentWithUpdate = `${baseContent}\n\n${mvuResult.update}`.trimEnd()
    // 3. 在最终内容末尾添加占位符
    const anchored = ensureStatusPlaceholder(contentWithUpdate)
    // 4. 同步到 swipes 并持久化
    // ...
  }
}

// ✅ 核心适配：即使本轮没有变量更新，只要 MVU 启用，也要确保 assistant 消息
// 带有占位符和 message.data，这样状态栏能显示上一轮的变量状态
if (state.mvuSettings.enabled && currentMvu !== undefined) {
  const history = [...session.getHistory(sessionId)]
  const last = history[history.length - 1]
  if (last?.role === 'assistant' && !last.content.includes(STATUS_PLACEHOLDER_TOKEN)) {
    // 本轮没有变量更新（或 MVU 未生成 update），但需要确保占位符存在
    const anchored = ensureStatusPlaceholder(last.content)
    const dataRecord: Record<string, unknown> = (() => {
      const current = last.data
      return current !== undefined && typeof current === 'object' && !Array.isArray(current)
        ? { ...current, stat_data: currentMvu.statData }
        : { stat_data: currentMvu.statData }
    })()
    const finalMessage: ChatMessage = {
      ...last,
      content: anchored,
      data: dataRecord,
      swipes: (() => {
        const swipes = Array.isArray(last.swipes) && last.swipes.length > 0
          ? [...last.swipes]
          : [last.content]
        const idx = Number.isInteger(last.swipe_id) ? Number(last.swipe_id) : 0
        swipes[idx] = anchored
        return swipes
      })(),
    }
    history[history.length - 1] = finalMessage
    session.setHistory(sessionId, history)
    // 持久化...
  }
}
```

### 3. MVU Retry 路由同步修复

```typescript
const nextHistory = appendToReply && assistantMessage !== undefined
  ? history.map((message, index) => {
      if (index !== assistantIndex || message === undefined) return message
      const writeback = writeMvuBackToAssistant(message, currentMvu.statData, update)
      if (writeback === undefined) return message
      
      // ✅ 修复：正确的顺序
      // 1. 移除旧占位符
      const baseContent = writeback.message.content.replace(
        new RegExp(`\\s*${STATUS_PLACEHOLDER_TOKEN.replace(/[<>]/gu, '\\$&')}\\s*$`, 'u'),
        '',
      )
      // 2. 追加 update 块
      const contentWithUpdate = `${baseContent}\n\n${update}`.trimEnd()
      // 3. 添加占位符
      const anchored = ensureStatusPlaceholder(contentWithUpdate)
      // 4. message.data 已由 writeMvuBackToAssistant 设置，这里只需同步 swipe
      return syncAssistantSwipe({ ...writeback.message, content: anchored }, anchored)
    })
  : history
```

## 修复效果

### Before（修复前）

```text
[正文内容]
```
❌ 没有占位符 → 状态栏不显示

### After（修复后）

```text
[正文内容]

<UpdateVariable>
<Analysis>...</Analysis>
<JSONPatch>...</JSONPatch>
</UpdateVariable>

<StatusPlaceHolderImpl/>
```
✅ 占位符在正确位置 → 状态栏正常显示

### 无变量更新时

```text
[正文内容]

<StatusPlaceHolderImpl/>
```
✅ 即使没有 `<UpdateVariable>` 块，占位符也会被添加 → 状态栏显示上一轮的状态

## 与 SillyTavern/MVU 的一致性

修复后的实现完全遵循 SillyTavern 的原始处理链：

1. **消息生命周期**：AI 回复 → MVU 解析 → 更新 message.data → 追加占位符
2. **楼层数据绑定**：每条 assistant 消息的 `message.data.stat_data` 存储该楼层的变量快照
3. **占位符位置**：永远在整个消息内容的最末尾，无论有没有 `<UpdateVariable>` 块
4. **正则处理**：
   - `promptOnly` 正则：删除占位符，不让模型看到
   - `markdownOnly` 正则：将占位符替换为状态栏 HTML

## 相关文件

- `src/agent-loop/ui-server.ts`：主修复文件
  - `writeMvuBackToAssistant` 函数：不再提前添加占位符
  - `handleRunSse` 路由：在 MVU 阶段后统一添加占位符
  - `handleRetryMvu` 路由：同步修复
- `src/mvu.ts`：MVU 核心逻辑（未修改）
- `docs/sillytavern-compatibility.md`：SillyTavern 兼容性文档
- `docs/mvu-pipeline.md`：MVU 管线说明

## 测试建议

1. 使用「在全是恶女婊子的异世界开后宫！」卡片测试
2. 发送一条对话，检查状态栏是否显示
3. 检查 assistant 消息末尾是否有 `<StatusPlaceHolderImpl/>`
4. 检查 message.data.stat_data 是否正确保存
5. 测试连续多轮对话，状态栏应该持续显示
6. 测试 MVU retry 功能，确保状态栏更新

## 关于拉伸问题

手动添加占位符后出现的拉伸问题是另一个独立的问题，涉及到：

1. 卡片 iframe 的高度计算使用 `body.scrollHeight`
2. 卡片 HTML 使用了 `height:100%` 和 `position:fixed`
3. 这会形成尺寸反馈循环

这个问题不在本次修复范围内，因为它与 MVU 消息回写逻辑无关，是前端 iframe 容器管理的问题。
