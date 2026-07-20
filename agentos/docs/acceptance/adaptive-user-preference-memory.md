# 自适应用户偏好记忆验收记录

## 范围

本阶段只学习交互与工作方式，不保存项目代码、完整用户消息、Prompt、CLI 原始输出、密钥或授权信息。偏好分为两层：Workspace 局部偏好和用户全局偏好；解析优先使用当前场景的 Workspace 投影，再回退到全局投影。

## 生命周期验收

- `observed`：单条证据只记录，不注入。
- `provisional`：至少 2 个独立 Run 且总分达到 6。
- `stable`：至少 4 个独立 Run 且总分达到 12。
- `dormant`：连续强冲突或总分低于 0 时停止注入。
- 全局投影必须来自至少两个 Workspace，或跨至少三个会话并覆盖七天。
- 场景允许 `coding`、`debugging`、`planning`、`review`、`explanation`、`general` 并分别解析。

## 控制面验收

工作区页面的“交互偏好”面板可以查看状态、层级、场景、置信度、独立 Run 数和最近支持时间；可以暂停/恢复隐式学习、清除可注入投影、休眠单条投影，并从脱敏证据打开来源 Run。没有加入点赞/点踩或其他显式评分流程。

## 隐私验收

证据摘要由固定模板生成，来源只保留 Run/事件 ID；测试会检查摘要中不存在 `SECRET`、`API_KEY`、`token` 等敏感值，也不会返回完整源消息。清除投影不会删除审计证据。

## 可复现命令

在仓库根目录执行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\verify-preference-memory.ps1
```

脚本依次执行验收场景、完整 server 测试、agent-core 测试、web build 和 `git diff --check`；任一步非零都会立即停止并打印命令和退出码。

## 本次实现提交

- `a316117`：偏好记忆持久化
- `052fea5`：确定性投影规则
- `7cdc552`：场景解析与上下文注入
- `3f80b46`：隐式观察与学习编排
- `82483f1`：接入 direct/resume/group Run
- `8103f15`：API、控制面板与 Run 详情
