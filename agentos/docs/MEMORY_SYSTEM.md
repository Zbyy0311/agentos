# AgentOS 项目记忆系统

## 数据模型与目录

正式记忆的元数据存放在 `.agentos/agentos.sqlite` 的 `memories` 表，正文仍保存为工作区内的 UTF-8 Markdown：

```text
agent-memory/records/overview/<id>.md
agent-memory/records/conventions/<id>.md
agent-memory/records/decisions/<id>.md
agent-memory/records/experiences/<id>.md
```

`memory_sources` 保存来源 Run，`memory_fts` 为标题、摘要、正文和标签提供 FTS5 索引。归档只改变状态，不再参与默认检索。

## 检索与注入边界

每次 Run 最多注入 5 条记忆、最多 6000 个字符，单条正文最多 1800 个字符。注入内容使用固定 Markdown 格式，Run 通过 `run_memory_usage` 记录记忆 ID、排序和实际字符数。Workspace 的 `memoryEnabled` 为 false 时不检索、不注入、不记录用量。

检索只读取 active 记忆，并根据关键词、关联文件、重要性和更新时间做确定性排序。中文无空格查询使用二字符片段辅助匹配；若 FTS 没有直接命中，会在 active 记忆的有限集合内做安全回退。

## 候选审批

候选不是正式记忆。只有用户对已完成 Run 显式执行“生成记忆候选”，并在队列中编辑后接受，才会写入 Markdown 和 `memories`；接受时保留来源 `sourceRunIds`。拒绝候选仍保留在 `memory_candidates` 中用于审计，但不会检索或注入。

候选提取器只接收原始需求、Run 的公开结果摘要、可见回复和文件变化，优先兼容显式 `agentos-memory` JSON 标记；没有标记时依据公开文件证据、决定、方案、规范、修复和验证关键词生成最多 3 条候选，不调用后台模型，也不读取原始 CLI 输出或隐藏 Prompt。只有“完成”“好的”等无证据短回复才返回明确的 `no_valuable_public_evidence`。失败、取消、等待用户或运行中的 Run 不生成候选；相似正式记忆只写入冲突提示，不自动覆盖或合并。

## 隐私边界

Prompt、完整 CLI 输出、私有思维链、密钥、Authorization 头和环境变量不写入事件、Run 详情或候选输入。CLI 证据只保存安全命令标签、模型/思考级别、退出码、耗时以及工作区相对文件路径。

## 迁移与备份

打开 Store 时会增量创建记忆、来源、FTS、用量和候选表，不重建既有消息或执行记录。旧执行记录会迁移到 `legacy-run-<executionId>`，并回填 `executions.run_id`。迁移前应备份 `.agentos/agentos.sqlite`、`workspace/workspaces.json` 和 `agent-memory/`；若 Markdown 写入或数据库写入失败，服务会删除本次正文并恢复更新前的文件。
