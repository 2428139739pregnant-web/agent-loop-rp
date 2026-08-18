# Agent Loop RP

独立的多 Agent 角色扮演项目。该目录只保留 Agent Loop、角色卡/酒馆兼容运行时、前端和本地运行数据，不包含 DSH 插件主体。

## 启动

```powershell
pnpm install
pnpm start
```

离线 Mock 模式：

```powershell
pnpm start:mock
```

浏览器打开 `http://127.0.0.1:3080`。

## 目录

- `src/agent-loop/`：Agent Loop、agent、世界书兼容和 HTTP 服务
- `src/import/`：角色卡、世界书和酒馆字段解析所需的兼容模块
- `scripts/agent-loop-ui/`：React 18 单页前端
- `characters/`、`sessions/`、`worldbooks/`：本地运行数据
