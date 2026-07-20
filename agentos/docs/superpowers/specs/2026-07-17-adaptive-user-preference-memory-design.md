# AgentOS 自适应用户偏好记忆设计

## 1. 目标

在不改写现有项目知识记忆系统的前提下，为 AgentOS 增加一套可解释、可回滚的个人偏好学习链路，使系统能够仅依靠可观察行为逐步学习用户的交互与工作方式，并在不同任务场景中应用不同偏好。

第一阶段只覆盖：

- 回答语言与详略；
- 先规划还是直接执行；
- 不确定时询问还是采用安全假设；
- 修改范围偏好；
- 验证与测试深度；
- 进度沟通与交付格式；
- 常用工具和执行习惯。

第一阶段不使用偏好记忆决定技术架构、依赖选择、Agent 或模型路由。

## 2. 设计原则

1. **双层记忆**：项目知识继续按 Workspace 隔离；个人偏好可以跨 Workspace 沉淀。
2. **仅隐式反馈**：不依赖点赞、点踩或评分，通过纠正、重复要求、工作流选择、返工和成功沿用等行为学习。
3. **证据先于结论**：一次行为只形成证据，不直接写成稳定画像。
4. **分级自动晋升**：偏好经历 `observed -> provisional -> stable -> dormant` 生命周期。
5. **按场景共存**：相反偏好可以分别存在于编码、调试、规划、评审、解释等场景。
6. **本次指令优先**：当前用户明确要求始终覆盖历史偏好。
7. **可解释与可回滚**：每个投影必须能追溯到来源 Run 和证据，并能重新计算。
8. **学习失败不阻塞任务**：偏好提取、投影或注入失败时，原始 Run 继续执行。

## 3. 与现有记忆系统的边界

现有 `MemoryService`、`MemoryRetriever`、`MemoryCandidateService` 和 `RunContextBuilder` 继续负责项目事实、决策、规范和经验。现有正式项目记忆仍然：

- 保存为 Workspace 内 Markdown，SQLite 保存索引和来源；
- 按 `workspaceId` 隔离；
- 通过候选审核进入正式记忆；
- 使用 FTS5 检索并记录 `MemoryUsage`。

个人偏好记忆不写入 `agent-memory/records/`，也不作为项目知识候选。它保存在 AgentOS 本地 SQLite 中，通过独立服务解析和注入。两类上下文在 Prompt 中使用不同标题，防止个人习惯被误当作项目事实。

## 4. 总体架构

运行前链路：

1. `PreferenceContextClassifier` 根据 Run 类型、入口和请求特征识别场景。
2. `PreferenceResolver` 读取适用于当前用户、Workspace 和场景的投影。
3. 解析器按作用域、状态和置信度解决冲突。
4. `PreferenceContextBuilder` 生成紧凑的“用户工作偏好”上下文。
5. `ConversationService` 将偏好上下文与项目知识上下文分别注入 Agent。

运行后链路：

1. `PreferenceObserver` 读取用户可见消息、Run 状态、后续纠正、返工和工作流选择。
2. 确定性规则产生高可信硬证据；受限语义观察器识别同义表达产生软证据。
3. `PreferenceEvidenceService` 校验、去重并保存证据。
4. `PreferenceProjector` 根据全部有效证据重算受影响的偏好投影。
5. `PreferenceApplicationService` 记录本次 Run 实际采用的投影，为后续正负反馈提供关联。

语义观察器只能返回受约束的结构化候选证据，不能直接更新投影。它通过现有 Agent 适配能力执行非流式结构化提取，输入仅包含本次 Run 的用户可见请求、公开结果摘要以及与本次 Run 直接相邻的用户纠正；输出必须包含来源消息 ID，并通过 JSON Schema、枚举和长度校验。语义软证据的绝对权重上限为 `2`，不能单独把投影晋升为 `stable`。第一阶段不引入新的模型 SDK、向量数据库或知识图谱。

## 5. 数据模型

### 5.1 UserProfile

第一阶段只创建一个本地默认用户，但保留多用户扩展字段：

- `id`
- `display_name`
- `learning_enabled`
- `created_at`
- `updated_at`

不实现登录、账户同步或云端画像。

### 5.2 PreferenceEvidence

表示一次可追溯的行为证据：

- `id`
- `profile_id`
- `workspace_id`，全局证据可为空
- `conversation_id`
- `run_id`
- `source_message_id` 或 `source_event_id`
- `dimension`
- `context_kind`
- `candidate_value`
- `signal_type`
- `polarity`
- `weight`
- `summary`
- `status`
- `observed_at`
- `created_at`

使用唯一指纹防止同一来源、维度和值被重复计分。`summary` 只保存足以解释证据的短摘要，不复制完整聊天正文。

### 5.3 PreferenceProjection

表示系统当前对某项偏好的理解：

- `id`
- `profile_id`
- `scope`：`global` 或 `workspace`
- `workspace_id`
- `dimension`
- `context_kind`
- `preferred_value`
- `confidence`
- `score`
- `evidence_count`
- `independent_run_count`
- `status`：`observed`、`provisional`、`stable`、`dormant`
- `last_supported_at`
- `last_conflicted_at`
- `created_at`
- `updated_at`

投影不保存不可解释的自由文本规则。`dimension`、`context_kind` 和可用值由共享类型约束。

### 5.4 PreferenceProjectionEvidence

保存投影与证据的多对多关系，使投影能够解释和重算：

- `projection_id`
- `evidence_id`
- `contribution`

### 5.5 PreferenceApplication

记录某次 Run 实际采用的偏好：

- `run_id`
- `projection_id`
- `resolved_value`
- `rank`
- `injected_characters`
- `applied_at`

该记录与现有 `run_memory_usage` 类似，但只服务于用户偏好闭环。

## 6. 场景与偏好维度

第一阶段场景使用有限枚举：

- `coding`
- `debugging`
- `planning`
- `review`
- `explanation`
- `general`

第一阶段偏好维度使用有限枚举：

- `response_language`
- `response_detail`
- `execution_style`
- `clarification_style`
- `change_scope`
- `verification_depth`
- `progress_update_style`
- `delivery_format`
- `tooling_habit`

场景识别不确定时使用 `general`。第一阶段不允许模型动态创建新维度，防止画像无限膨胀。

## 7. 隐式证据与晋升规则

默认证据权重：

- 用户纠正系统行为并给出期望方式：`+4`
- 用户在不同 Run 中重复同一要求：`+3`
- 用户持续选择同一种工作流或交付方式：`+2`
- 偏好被采用、Run 成功且未出现返工：`+1`，每个投影最多累计 `3` 分
- 采用偏好后用户要求返工或改用相反方式：`-3`
- 用户直接纠正该偏好：`-4`

沉默不是强认可；单纯“Run 完成”不能独立把偏好晋升为稳定状态。

默认晋升规则：

- 第一条可信证据产生 `observed` 投影，但不注入；
- 至少两个独立 Run、总分达到 `6` 后晋升为 `provisional`；
- 至少四个独立 Run、总分达到 `12`，且最近四个相关 Run 中不存在 `-4` 强冲突后晋升为 `stable`；
- 总分降到 `0` 以下，或最近三个相关 Run 中至少两个包含 `-3/-4` 负证据时，降为 `dormant` 并停止注入；
- 全局投影必须包含至少两个 Workspace 的支持证据；如果用户长期只使用一个 Workspace，则至少需要三个独立会话且证据时间跨度达到七天；不满足条件时只产生 Workspace 投影。

置信度使用固定公式 `clamp(0, 100, round(50 + score * 3))`。第一阶段不做纯时间衰减；偏好只因新证据、冲突、休眠或清空而变化，避免用户一段时间未使用系统就丢失稳定习惯。阈值集中配置在一个模块中并由测试固定，不做用户可配置界面。

## 8. 冲突解析与注入

偏好解析顺序：

1. Workspace 场景偏好；
2. 全局场景偏好；
3. Workspace 通用偏好；
4. 全局通用偏好。

同一优先级下，如果相反投影的置信度接近，解析器放弃注入该维度。`observed` 和 `dormant` 永不注入；`provisional` 作为柔性建议，`stable` 作为默认行为。

最终运行优先级固定为：

`当前用户明确要求 > 系统安全规则 > Workspace 配置 > 已学习偏好`

偏好上下文预算默认不超过 800 个字符，只包含最终解析值，不包含证据正文、聊天原文或推断过程。上下文首行固定声明“以下内容仅为历史默认偏好；如与当前用户要求冲突，以当前要求为准”。

## 9. 隐私与安全边界

- 不读取或保存私有思维链、隐藏 Prompt、密钥、Authorization 头或环境变量。
- 语义观察器只读取用户可见消息、公开 Run 结果和结构化事件。
- 证据保存来源 ID 和短摘要，不复制完整聊天历史。
- 投影值必须通过枚举和长度校验，不能把任意用户文本直接拼接到系统 Prompt。
- Workspace 局部偏好不得泄漏到其他 Workspace。
- 全局偏好只描述工作方式，不携带项目代码、文件内容、客户名称或业务事实。
- 学习链路异常只记录经过脱敏的诊断信息。

## 10. 用户可见控制与可观察性

仅隐式反馈不等于不可控。第一阶段提供“系统对我的理解”只读视图，展示：

- 当前稳定和暂定偏好；
- 适用场景与作用域；
- 置信度、独立 Run 数和最近支持时间；
- 来源 Run 链接；
- 当前 Run 实际应用的偏好。

提供三个安全控制：暂停学习、清空全部个人偏好、使单个投影休眠。它们是隐私与纠错控制，不作为点赞或点踩信号参与评分。

## 11. 错误处理

- 场景识别失败：降级为 `general`。
- 确定性或语义观察失败：跳过本次学习，不影响 Run 状态和用户结果。
- 缺少来源、枚举非法或超长的候选证据：拒绝写入并记录脱敏诊断。
- 证据去重：返回已有记录，不重复计分。
- 投影重算：使用数据库事务；失败时保留旧投影。
- 偏好解析或注入失败：使用空偏好上下文继续执行。
- 清空或休眠操作：保留必要审计事件，但删除或停用可注入画像。

## 12. 测试策略

### 单元测试

- 场景分类与 `general` 回退；
- 每种证据权重、去重和非法输入拒绝；
- 四阶段晋升、降级和重算；
- 全局/Workspace、场景/通用的优先级；
- 相反偏好置信度接近时不注入；
- 800 字符预算与 Prompt 安全编码；
- 当前用户明确要求覆盖已学习偏好。

### 存储与服务测试

- 增量迁移不破坏现有 SQLite 数据；
- 全局偏好可跨 Workspace 解析，局部偏好不能跨界；
- 投影与证据来源可追溯；
- 事务失败不留下半更新数据；
- 暂停、休眠和清空行为正确。

### 集成测试

模拟多个独立 Run：

1. 第一次行为只产生 `observed`；
2. 重复证据晋升为 `provisional`；
3. 达到独立 Run 阈值后晋升为 `stable`；
4. 下一次同场景 Run 注入该偏好并保存 `PreferenceApplication`；
5. 后续纠正产生负证据并使投影降级；
6. 不同场景的相反偏好可以同时稳定存在。

### 回归与真实流程

- 现有 agent-core、server 测试和 web build 全部通过；
- 现有项目记忆检索、候选审核和 Run 详情行为不变；
- 浏览器真实流程能查看投影、来源和实际应用记录；
- 学习服务故障时聊天和 Agent 执行仍然可用；
- 验证数据库和公开事件中不存在聊天全文复制、隐藏 Prompt 或敏感环境数据。

## 13. 实施边界

本设计采用现有 monorepo、SQLite、事件总线、SSE 和 Agent 适配器，不引入 Redis、Kafka、向量数据库、知识图谱、新模型 SDK、账户系统或云同步。

实施应按“类型与迁移 -> 证据账本 -> 投影器 -> 解析与注入 -> 运行后观察 -> 可见界面 -> 全链路验收”推进。每一阶段先编写失败测试，再做最小实现，并设置独立验收标准。
