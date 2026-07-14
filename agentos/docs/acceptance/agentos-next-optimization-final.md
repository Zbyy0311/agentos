# AgentOS 下一阶段优化最终验收记录

## 自动化

验收入口：`scripts/verify-next-optimization-acceptance.ps1`

- Shared TypeScript build：通过。
- Agent Core 测试：74/74 通过，覆盖 Run、统一事件、执行证据、Memory CRUD、检索预算、候选提取、候选状态机和 API。
- Server 测试：73/73 通过，覆盖 Run、统一事件、执行证据、Memory CRUD、检索预算、候选提取、候选状态机、迁移计数、失败/取消路径和 API。
- Web production build：通过，Next.js 类型检查和静态生成通过。
- Monorepo build：通过；4/5 workspace 项目构建成功，退出码 0。
- `http://localhost:3000/api/health`：通过，HTTP 200。
- `http://localhost:3001/`：通过，HTTP 200。

## 功能验收范围

- 每次单聊/群聊请求拥有一个 `AgentRun`，历史执行记录可迁移且不重建原执行数据。
- 公开事件、CLI 调用和工作区文件变化可追踪；未保存密钥、完整 CLI 输出或私有思维链。
- Run 详情按原始需求、状态耗时、事件、CLI、文件、总结和记忆用量展示。
- 四类 Markdown 项目记忆支持 CRUD、归档、来源 Run、FTS5/安全回退检索和固定预算注入。
- 已完成 Run 可显式生成最多 3 条待审核候选；接受前不进入正式记忆和 Prompt，接受后保留来源 Run，拒绝后保留审计状态。

## 浏览器验收说明

3001 端口保持由用户当前本地前端进程提供。内置浏览器已打开 `agentos` 工作区，确认已有单聊消息和执行完成状态；刷新后消息与执行历史仍存在；项目知识面板可打开并显示记忆 CRUD 界面。此前真实 CLI 单聊曾停在当前 3000 进程的 CLI 调用阶段，因此未将真实 CLI 群聊和候选审核误记为通过；自动化测试使用 mock CLI 覆盖相同的消息、Run、事件、记忆和候选路径。

## 已知风险

- Windows 测试临时目录中的 Git reparse 清理是 best-effort，测试本身不依赖删除失败；工作区源码未受影响。
- 不应让 `next dev` 与 `next build` 同时写同一个 `.next` 目录；若出现缺失 chunk，停止构建后清理 `.next` 并单独重启开发服务器。
- 统一验收脚本的构建、测试和 monorepo build 阶段已通过；一次末尾健康检查曾受上述 `.next` 并行写入导致的缺失 chunk 影响，清理并单独重启后 3001 已恢复 HTTP 200。
