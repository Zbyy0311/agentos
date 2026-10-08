# S7 显式 Markdown 导入候选证据包（LITE-07-106 / LITE-07-107 / LITE-07-108）

本报告只记录候选证据，不能直接改变验收矩阵状态。三个 requirement 的本轮 verdict 只能取 `candidate-supported`、`insufficient-evidence` 或 `failed`；本轮没有执行 PASS 提升，也没有执行 `--require-closed`。

## 固定边界

- baseline SHA：`d89137ccbf72ef75faca8c807de61fb972f356ff`（本次证据运行绑定的 worktree HEAD）
- 分支：`audit/lite-s6-s7-candidate-evidence`（与 S6 包同一分支、同一冻结口径）
- 机器可读包：`docs/implementation/lite-closeout/S7-candidate-evidence.json`
- 模型口径：**导入路径不调用任何 Provider 模型**，证据绑定 AgentOS 自身的解析、幂等、事务与事件契约。
- 输入：真实写入磁盘的 UTF-8 Markdown 文件（解析器版本 `lite-v1-markdown-heading`），不是内存字符串常量。

| Requirement | 原文（matrix v15） | 最终 verdict | assertion counts | raw exit |
| --- | --- | --- | --- | ---: |
| `LITE-07-106` | `显式Markdown导入为Candidates` | `candidate-supported` | 7 total / 7 passed / 0 failed / 0 skipped | 0 |
| `LITE-07-107` | `按Scope/owner及稳定来源去重，保留审计证据` | `candidate-supported` | 3 total / 3 passed / 0 failed / 0 skipped | 0 |
| `LITE-07-108` | `无Run触发器也有规范candidate_created与可验证因果` | `candidate-supported` | 2 total / 2 passed / 0 failed / 0 skipped | 0 |

## 最终执行记录

harness 命令（在 `apps/server` 下执行；导入路径不需要 Provider 凭据或 CLI）：

```powershell
node --import tsx ../../scripts/verify-lite-s7-candidate-evidence.mjs --out E:\workspace\Multi-Agent-worktrees\agentos-lite-s67-evidence\agentos\docs\implementation\lite-closeout\evidence\s7-candidate-evidence-20260914
```

raw exit = `0`；receipts 统计 `12 total / 12 passed / 0 failed / 0 skipped`。

| 日志 / 收据 | bytes | SHA-256 |
| --- | ---: | --- |
| `docs/implementation/lite-closeout/evidence/s7-candidate-evidence-20260914/receipts.json` | 13299 | `3cf389215a59a92a573ceb5945c6826615329b5e3a79d814a0e30dea46178dce` |
| `docs/implementation/lite-closeout/evidence/s7-candidate-evidence-20260914/stdout.txt` | 63 | `1c1e722533d9b8981a9fcc71ace18b4478f23a4f14f4cd982d3c650a6a908475` |
| `docs/implementation/lite-closeout/evidence/s7-candidate-evidence-20260914/stderr.txt` | 0 | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| `docs/implementation/lite-closeout/evidence/s7-candidate-evidence-20260914/exit.txt` | 3 | `13bf7b3039c63bf5a50491fa3cfd8eb4e699d1ba1436315aef9cbe5711530354` |
| `docs/implementation/lite-closeout/evidence/s7-candidate-evidence-20260914/scope-verifier.stdout.txt` | 93 | `c412198c0b3a31ba0bce0ce7a3d661de904524bc7082edd140be153a9d2eb5b1` |
| `docs/implementation/lite-closeout/evidence/s7-candidate-evidence-20260914/scope-verifier.stderr.txt` | 0 | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| `docs/implementation/lite-closeout/evidence/s7-candidate-evidence-20260914/targeted-tests/targeted.stdout.txt` | 1151 | `a9dbd826f83e92a24155d9b0daee00be08882db63c3310584d9a72fb5f945347` |
| `docs/implementation/lite-closeout/evidence/s7-candidate-evidence-20260914/targeted-tests/targeted.stderr.txt` | 0 | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |

## `LITE-07-106`

matrix 原文为 `显式Markdown导入为Candidates`，matrix section 为 `§7; user-approved import`；冻结条款来源 `docs/implementation/lite-closeout/S7-import-authorization.md:1`，并引用：

- `docs/Runtime-Specification lite/07-Memory-Runtime.md:174` — canonical Memory 来源之一：显式导入
- `apps/server/src/services/MemoryImportService.ts:19` — 实现常量：解析器版本、1 MiB 上限、分段与片段预算

- matrix 状态：`GAP`（workPackage `S7`，matrixVersion 15，本轮未改动）
- 冻结退出条件（matrix `exit`）：用户选择UTF-8 Markdown<=1MiB→预览→确认→有界分段候选/来源/事件；幂等、源文件保持。
- 原始记录缺口（matrix `finding`）：Workspace import强制memory:false；没有forward Memory import入口。
- 生产入口（matrix `implementation`）：`apps/server/src/managers/WorkspaceManager.ts`
- 关联测试（matrix `tests`）：`apps/server/src/services/LegacyTaskItemImportService.test.ts`

| Assertion | 阶段 / 步骤 | 实际值 | 预期值 | 结果 |
| --- | --- | --- | --- | --- |
| `S7E-PREVIEW-01` | `file`：the production preview segments the real file without persisting anything | `{"parserVersion":"lite-v1-markdown-heading","byteSize":11626,"fileBytes":11626,"sourceHashMatchesFileBytes":true,"fragmentCount":5,"fragmentTitles":["handbook.md","Alpha","Beta","Beta (part 2)","Gamma"],"skipped":0,"rowsWritten":{"candidates":0,"records":0,"events":0,"entries":0,"runs":0}}` | `{"parserVersion":"lite-v1-markdown-heading","byteSize":11626,"fileBytes":11626,"sourceHashMatchesFileBytes":true,"fragmentCount":5,"fragmentTitles":["handbook.md","Alpha","Beta","Beta (part 2)","Gamma…` | passed |
| `S7E-PREVIEW-02` | `file`：an oversized section is split further so every fragment stays bounded | `{"sectionCharacters":12000,"limit":8000,"fragmentLengths":[35,549,8000,2999,11],"allWithinLimit":true,"partTitles":["Beta (part 2)"],"betaPartsReassemble":true}` | `{"sectionCharacters":12000,"limit":8000,"fragmentLengths":[35,549,8000,2999,11],"allWithinLimit":true,"partTitles":["Beta (part 2)"],"betaPartsReassemble":true}` | passed |
| `S7E-PREVIEW-03` | `file`：each fragment is content-addressed and the user file is left untouched | `{"fragmentHashesMatch":true,"hashOnDiskBefore":"6a5b09bc07c13f0974e35bec1854bd7d017087e784c41b17f8fb3bd35512ad2f","hashOnDiskAfter":"6a5b09bc07c13f0974e35bec1854bd7d017087e784c41b17f8fb3bd35512ad2f","fileUnchanged":true,"fileBytesOnDisk":11626}` | `{"fragmentHashesMatch":true,"hashOnDiskBefore":"6a5b09bc07c13f0974e35bec1854bd7d017087e784c41b17f8fb3bd35512ad2f","hashOnDiskAfter":"6a5b09bc07c13f0974e35bec1854bd7d017087e784c41b17f8fb3bd35512ad2f","…` | passed |
| `S7E-CONFIRM-01` | `service`：a confirmed import writes review-required Candidates, durable records and canonical Events | `{"imported":5,"converged":0,"skipped":0,"recordCount":5,"parserVersion":"lite-v1-markdown-heading","sourceHashMatchesPreview":true,"fragmentHashesMatchPreview":true,"fragmentIndexes":[0,1,2,3,4],"candidateIdsMatchRecords":true,"scopes":["workspace"],"categories":["knowledge"],"authorities":["imported-verified"],"decisi…` | `{"imported":5,"converged":0,"skipped":0,"recordCount":5,"parserVersion":"lite-v1-markdown-heading","sourceHashMatchesPreview":true,"fragmentHashesMatchPreview":true,"fragmentIndexes":[0,1,2,3,4],"cand…` | passed |
| `S7E-REFUSAL-01` | `refusals`：the size, encoding, emptiness and input rules are executed, not assumed | `{"tooLarge":"IMPORT_TOO_LARGE","atLimit":null,"notUtf8":"IMPORT_NOT_UTF8","notUtf8IsImportError":true,"empty":"IMPORT_EMPTY","blankName":"IMPORT_INPUT_INVALID","maxBytes":1048576,"rowsWrittenByRefusals":{"candidates":0,"records":0,"events":0}}` | `{"tooLarge":"IMPORT_TOO_LARGE","atLimit":null,"notUtf8":"IMPORT_NOT_UTF8","notUtf8IsImportError":true,"empty":"IMPORT_EMPTY","blankName":"IMPORT_INPUT_INVALID","maxBytes":1048576,"rowsWrittenByRefusal…` | passed |
| `S7E-REFUSAL-02` | `refusals`：the fragment budget bounds one import instead of unbounded Candidate writes | `{"sections":205,"fragmentCount":200,"maxFragments":200,"skipped":5,"skipReasons":["fragment-limit"],"confirmedImported":200,"confirmedSkipped":5}` | `{"sections":205,"fragmentCount":200,"maxFragments":200,"skipped":5,"skipReasons":["fragment-limit"],"confirmedImported":200,"confirmedSkipped":5}` | passed |
| `S7E-HTTP-01` | `http`：the mounted router previews, confirms and converges over real HTTP | `{"previewStatus":200,"previewFragments":2,"previewParser":"lite-v1-markdown-heading","confirmStatus":201,"confirmImported":2,"repeatStatus":200,"repeatImported":0,"repeatConverged":2,"listedStatus":true,"listedIds":2,"tooLargeStatus":413,"tooLargeError":"IMPORT_TOO_LARGE","missingFieldStatus":400,"missingFieldError":"I…` | `{"previewStatus":200,"previewFragments":2,"previewParser":"lite-v1-markdown-heading","confirmStatus":201,"confirmImported":2,"repeatStatus":200,"repeatImported":0,"repeatConverged":2,"listedStatus":tr…` | passed |

Everything is executed over a real UTF-8 Markdown file on disk. The production parser segments by heading with the versioned parser id, splits an oversized section further so every fragment stays inside the bound and the parts reassemble to the authored body, content-addresses each fragment, and leaves the user file byte-identical. Confirm then writes, in one transaction, one review-required / workspace-scoped / imported-verified Candidate per fragment plus its durable import record (source hash, fragment index, fragment hash, parser version, byte size, candidate id) and the canonical Event. The refusals are executed too: over 1 MiB is refused while exactly at the limit is accepted, invalid UTF-8 and an empty file are refused with their own codes, a blank file name is refused, and none of them write a row. The mounted router reproduces the whole path over HTTP (200 preview, 201 confirm, 200 converge, 413 for oversized, 400 for a missing field, 404 for an unknown Workspace), and the 200-fragment budget bounds one import instead of unbounded Candidate writes.

未证明的相邻行为：The import proves the file, parser, record, Candidate and Event path for the fragments it created, with the reported skip reasons. It does not prove a UI file picker, and it does not re-verify the downstream review decision (a separate S3 row). Non-UTF-8 is only reachable through the service because an HTTP JSON body cannot carry invalid UTF-8; that refusal is asserted on the service and cited as such.

## `LITE-07-107`

matrix 原文为 `按Scope/owner及稳定来源去重，保留审计证据`，matrix section 为 `补可证实重复分支`；冻结条款来源 `docs/implementation/lite-closeout/S7-import-authorization.md:1`，并引用：

- `apps/server/src/services/MemoryImportService.ts:161` — 幂等键：workspace + source hash + fragment + parser version

- matrix 状态：`GAP`（workPackage `S1`，matrixVersion 15，本轮未改动）
- 冻结退出条件（matrix `exit`）：补可证实重复分支：同owner来源合并并发收敛；不同owner不串线；近重复审核，来源保留。
- 原始记录缺口（matrix `finding`）：查重未隔离Scope/owner/category及active状态；终态精确命中缺来源合并与版本/Event/Outbox，显式save在完整校验前返回命中。 S1-A终态与S1-D显式save的精确匹配补缺已有独立提交证据；近似重复审核、review promotion与来源真实性仍待闭合，状态保持GAP。
- 生产入口（matrix `implementation`）：`apps/server/src/store/MemoryCandidateRepository.ts`、`apps/server/src/services/MemoryCandidateGenerationService.ts`、`apps/server/src/routes/memoryRuntime.ts`、`apps/server/src/store/MemoryEntryRepository.ts`
- 关联测试（matrix `tests`）：`apps/server/src/services/MemoryCandidateGenerationService.test.ts`、`apps/server/src/routes/memoryRuntime.test.ts`

| Assertion | 阶段 / 步骤 | 实际值 | 预期值 | 结果 |
| --- | --- | --- | --- | --- |
| `S7E-IDEMPOTENT-01` | `service`：a repeated import of the same bytes converges and writes nothing new | `{"imported":0,"converged":5,"sameCandidates":true,"rows":{"candidates":0,"records":0,"events":0}}` | `{"imported":0,"converged":5,"sameCandidates":true,"rows":{"candidates":0,"records":0,"events":0}}` | passed |
| `S7E-IDEMPOTENT-02` | `service`：a changed source becomes a traceable new version instead of overwriting the audit trail | `{"sourceHashChanged":true,"imported":5,"converged":0,"importedIndexes":[0,1,2,3,4],"recordsAfter":10,"distinctSourceVersions":2,"oldVersionFragmentKept":true,"oldAndNewFractionDiffer":true,"oldAndNewCandidatesDiffer":true,"scopesUnchanged":["workspace"],"fragmentReuseAcrossVersions":"not-part-of-the-contract"}` | `{"sourceHashChanged":true,"imported":5,"converged":0,"importedIndexes":[0,1,2,3,4],"recordsAfter":10,"distinctSourceVersions":2,"oldVersionFragmentKept":true,"oldAndNewFractionDiffer":true,"oldAndNewC…` | passed |
| `S7E-OWNER-01` | `owner`：the same bytes in another Workspace are a new import, not a cross-owner convergence | `{"imported":5,"converged":0,"records":5,"candidates":5,"events":5,"sameSourceHashAsFirstWorkspace":true,"firstWorkspaceRecordsUnchanged":10}` | `{"imported":5,"converged":0,"records":5,"candidates":5,"events":5,"sameSourceHashAsFirstWorkspace":true,"firstWorkspaceRecordsUnchanged":10}` | passed |

The idempotency key is the owning Workspace plus the source hash, fragment index and parser version, and it is exercised in both directions: re-importing the same bytes in the same Workspace converts every fragment to a converged candidate (referencing the SAME candidate ids) and adds zero candidate, record or event rows; importing the same bytes under a different owner creates a genuine new import with its own records, candidates and events, and leaves the first Workspace untouched. A changed file becomes a second recorded source version: both versions keep their own fragment hash and candidate id for the same fragment index, and the new candidates stay workspace-scoped.

未证明的相邻行为：Covers owner-scoped, stable-source idempotency for the import trigger, which is what the import contract defines. It records, without claiming, that a changed file is a new source version and therefore records its fragments again: fragment reuse across file versions is not part of the frozen contract, and the review gate is what keeps a re-imported fragment out of long-term Memory. Candidate-level exact/near-duplicate convergence across the other triggers is covered by the S1 evidence packs.

## `LITE-07-108`

matrix 原文为 `无Run触发器也有规范candidate_created与可验证因果`，matrix section 为 `授权最小契约扩展`；冻结条款来源 `docs/implementation/lite-closeout/S7-import-authorization.md:1`，并引用：

- `apps/server/src/store/WorkspaceEventWriter.ts:314` — candidate_created 必须由持久来源记录证明 origin
- `apps/server/src/services/MemoryImportService.ts:188` — origin = memory.import:<recordId>，因果 = 该记录

- matrix 状态：`GAP`（workPackage `S1`，matrixVersion 15，本轮未改动）
- 冻结退出条件（matrix `exit`）：授权最小契约扩展；持久来源因果证明，未知或跨Workspace来源拒绝；回滚和重放验证。
- 原始记录缺口（matrix `finding`）：保留基线反证：Workspace allowlist无candidate_created。02a50947已为实际Artifact完成登记来源专属Workspace因果和事务校验，禁止借用其它origin；不伪造Run。审批/压缩/导入仍需各自真实来源登记，保持GAP。
- 生产入口（matrix `implementation`）：`packages/shared/src/types/mf5-workspace-events.ts`、`apps/server/src/services/WorkspaceEventContextAuthority.ts`
- 关联测试（matrix `tests`）：`apps/server/src/store/WorkspaceEventWriter.test.ts`

| Assertion | 阶段 / 步骤 | 实际值 | 预期值 | 结果 |
| --- | --- | --- | --- | --- |
| `S7E-CONFIRM-02` | `service`：the non-Run origin registers its own canonical causal Event without inventing a Run | `{"eventTypes":["memory.candidate_created"],"eventCount":5,"correlationNamesItsOwnRecord":true,"causationMatchesRecordIds":true,"importIds":["imp_01M2FZJ6GC6ENX5KV7Z3D69JK7","imp_01M2FZJ6GE25DRM4PM3VPECFV6","imp_01M2FZJ6GE25DRM4PM3VPECFV9","imp_01M2FZJ6GFQF5R1BDFNG6J7NQZ","imp_01M2FZJ6GFQF5R1BDFNG6J7NR2"],"payloadCandid…` | `{"eventTypes":["memory.candidate_created"],"eventCount":5,"correlationNamesItsOwnRecord":true,"causationMatchesRecordIds":true,"importIds":["imp_01M2FZJ6GC6ENX5KV7Z3D69JK7","imp_01M2FZJ6GE25DRM4PM3VPE…` | passed |
| `S7E-CONFIRM-03` | `service`：the origin is proved against the durable record, and a borrowed origin is refused | `{"proof":{"candidateId":true,"scope":"workspace","category":"knowledge","authority":"imported-verified","decision":"review-required"},"provesOnlyOwnRecord":true,"unknownRecordProved":false,"borrowedOriginRefusal":"WORKSPACE_EVENT_ORIGIN_UNPROVEN","eventsAfterRefusal":5}` | `{"proof":{"candidateId":true,"scope":"workspace","category":"knowledge","authority":"imported-verified","decision":"review-required"},"provesOnlyOwnRecord":true,"unknownRecordProved":false,"borrowedOr…` | passed |

The import registers its own origin (memory.import pointing at the durable import record) and emits exactly one canonical memory.candidate_created per fragment, each correlating and causally naming its own record, with a payload that matches that record's candidate, and zero fabricated Runs in the database. The origin is proved against the durable row: the positive proof returns the record's candidate/scope/category/authority/decision, an unknown record proves nothing, and a well-formed payload with a BORROWED origin (a candidate created by an import, presented as a compaction) is refused with WORKSPACE_EVENT_ORIGIN_UNPROVEN without adding an Event.

未证明的相邻行为：This pack executes the import origin. The compaction origin is executed in the S6 pack, and the approval / Artifact-completion origins are evidenced by their own merged slices; the rule is shared (one prover per kind), but every kind is not re-run here.

## targeted tests 与 scope verifier

受影响测试（3 个 S7 文件，`node --import tsx --test --test-concurrency=1`，在 `apps/server` 下执行）raw exit = 0，Node summary 为 `11 pass / 0 fail / 0 skipped / 0 cancelled / 0 todo`；普通 scope verifier 未加 `--require-closed`，raw exit = 0，stdout 原文为 `{"matrixVersion":15,"status":"frozen","PASS":0,"GAP":26,"RUNTIME-VERIFY":205,"DEFERRED":164}`。

## 已知限制与运行历史

- 解析器、幂等键与片段预算都是实现策略（`lite-v1-markdown-heading`、1 MiB、200 片段、8000 字符）并随记录持久化，因此历史导入的解释不会被后续调整改写。
- 变更文件的幂等语义是「新来源版本」：同源重复导入收敛，改写后的文件按新 source hash 记录；`S7E-IDEMPOTENT-02` 记录了这一点，并明确不宣称跨版本片段复用。
- HTTP 阶段销毁自己建立的 socket 并按正常路径退出，保证 `exit.txt` 的 raw exit code 可用。
- 证据只覆盖被点到编号的行为，没有把任何 skipped、缺日志或失败项折算为通过。

## 矩阵保护

生成前后未修改 `pass-freeze.json` / `matrix.json` / `pass-evidence-audit.json`，未执行任何 promotion 脚本，未执行 `--require-closed`。与 baseline blob 的 SHA-256 对比：

| 受保护文件 | worktree SHA-256 | baseline SHA-256 | 一致 |
| --- | --- | --- | --- |
| `docs/implementation/lite-closeout/matrix.json` | `81202d2273568177df2ed370cc0f5525cd38f961b65e85d0f7e66feda2001690` | `81202d2273568177df2ed370cc0f5525cd38f961b65e85d0f7e66feda2001690` | true |
| `docs/implementation/lite-closeout/pass-freeze.json` | `7263d8c4d857804e5c3603658bd2f3081eda7cb46ab3380b5b87532cda88dcb6` | `7263d8c4d857804e5c3603658bd2f3081eda7cb46ab3380b5b87532cda88dcb6` | true |
| `docs/implementation/lite-closeout/pass-evidence-audit.json` | `e5b81d9904136abe1aad251f25afba3e6c4d8765ccd4629bcd138a839eeb9795` | `e5b81d9904136abe1aad251f25afba3e6c4d8765ccd4629bcd138a839eeb9795` | true |

矩阵仍为 v15、`status=frozen`、PASS=0、GAP=26、RUNTIME-VERIFY=205、DEFERRED=164：这三个 requirement 保持 `GAP`，verdict 只是候选证据。

工作区 delta（`git status --porcelain=v1`）：

```text
?? agentos/docs/implementation/lite-closeout/evidence/s7-candidate-evidence-20260914/
?? agentos/scripts/assemble-lite-s7-candidate-evidence.mjs
?? agentos/scripts/verify-lite-s7-candidate-evidence.mjs
```

