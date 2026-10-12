# Phase 3/4 Runtime 收尾记录

本记录对应工作树与暂停/恢复收尾计划，不替代历史 M3 P3/P4 验收文件。
整合基线为 PR #221 的 main 合并提交
`37b2990d4013ee0a4347481f91495e6f1ed8ca64`。该基线的 CI 与 Memory gate
已通过；本次新增实现的发布状态以绑定 PR、精确提交 SHA 的完整 CI、
合并提交及其 main CI 为准。

## 工作树与 Git 控制

- 工作树创建先持久化 `creating` 租约和 `worktree.reserved`，再执行 Git。
  创建/激活、放弃、合并和删除事实通过同一 SQLite Runtime Event/Outbox
  通道记录；租约行变更与相应事件/Outbox 处于同一事务。
- 启动扫描同时读取配置中的 Git 根、持久化租约和 `git worktree list`。
  完整创建可重新激活；不完整创建、身份不匹配及没有租约的目录保留，
  不自动删除或接管。无法绑定 canonical Run 的历史/孤儿记录写审计诊断。
- 合并支持 ff、squash、merge-commit，锁覆盖 Git common-dir 中的来源和
  目标分支。目标引用以完整 `expectedHeadCommit` 做 CAS；Git 操作只在
  管理的 checkout 中执行，最后恢复来源分支，不修改主工作区文件或索引。
- Git 引用的 CAS 前写入独占、同步的意图日志，补齐 Git 更新与 SQLite
  结果/事件事务之间的故障窗口。启动只补记已确认发布的引用，按 commit SHA
  或 merge record ID 去重；未发布或状态不明确的日志保留并阻止分支再次变更。
  这类现场及未知/陈旧分支锁需要明确恢复，不自动删除。
- 控制 API 包括 commit、review、rebase、cleanup。它们核对 workspace、
  终态 Run、完整 HEAD SHA、checkout 身份和共享分支锁。
  commit 只暂存明确选择的路径；review 要求干净状态，不发明新的租约状态；
  rebase 冲突保留操作和冲突报告，并支持继续及明确确认后的中止。
- cleanup 要求 `confirmRecoveryBundle: true`，重新生成并按字节验证
  tracked patch、untracked archive 和 manifest，再移除管理目录。
  旧 DELETE 接口保留先建恢复包/再确认的约定，删除前刷新恢复包，
  避免丢失旧恢复包创建后新增的文件。临时归档采用随机名称和独占创建。
  Git 删除前持久化 `cleanup_pending`，重启核对目录和 Git 注册均已消失后，
  才补齐 cleaned 状态与删除事件，避免把查询失败当作删除证明。
- 工作树证据支持已有 canonical Artifact 来源，不伪造旧版 Run/Execution。
  `/worktrees/:leaseId/events` 从持久化事件按 sequence 分页读取。

## Run 恢复与进程控制

- 默认逻辑恢复保留原 Run ID 和已完成 Stage，由 dispatcher 继续驱动。
  暂停期间已在执行的 Stage 可以完成；后续 Stage 等待恢复后调度。
- 显式 `resumeMode: "child-run"` 创建 `reason: "resume-fallback"` 的关联
  Child Run，保留父 Run 历史并复制冻结配置；Child 使用新的 Stage 身份、
  自己的 `run.start` 和 Workspace Admission。幂等重放返回原 Child。
  父 Provider 退出未获证明时拒绝回退；受管 collaboration 使用原恢复通道。
- required-worktree Child 必须先建立自己的持久化租约和隔离 checkout。
  重启复用已验证的 Child 租约；不完整或身份改变的目录保留并记录失败，
  在准备完成前不进入 Provider。排队 Child 在启动/Admission 释放时继续驱动。
- 当前适配器没有接入原生会话恢复，`sessionResume` 保持 false；
  `native-session` 请求明确拒绝。逻辑恢复与 Child 回退均不声称恢复原生会话。
- Process Manager 提供受 claim 约束的 suspend/resume 与 stdin write/close。
  Windows 使用已有受管进程句柄；Linux 支持根进程 SIGSTOP/SIGCONT。
  挂起暂停 idle 计时，startup/total 计时继续；控制操作串行防止并发竞争。
- Custom CLI 可显式选择 `promptDelivery: "stdin"`；配置经持久化、冻结快照
  和 Stage 配置传入实际适配器。新增迁移 059 保存可选选项；历史配置/快照
  未提供该字段时保持 argument 默认和原有 hash。stdin 分块上限 16 KiB，
  有背压并发送 EOF；同时持续读取 stdout/stderr，取消可打断输入等待。

## 验证与边界

本地证据覆盖真实 Git、SQLite、Outbox、完整控制流程、跨进程分支锁、
冻结配置的真实 Custom CLI stdin，以及重启后的 Child 租约复用和执行。
Node CLI 是实际本地进程测试，不代表外部供应商模型或原生会话恢复验收。
Linux 原生进程控制未在本次 Windows 环境运行；其平台声明不扩大为跨平台
进程树挂起保证。完整服务器覆盖以最终提交的所有 CI shard 和汇总回执为准。

用户明确 Apply 的工作区写入仍遵循原有审阅、冻结身份、Admission 和
Apply Journal 回滚流程。其 `git apply --cached` 使用私有 Git context 的
shadow index，不能据此推断它写入主工作区索引或把 Apply 自动改为工作树。
Phase 5 及之后的工作不属于本次收尾范围。
