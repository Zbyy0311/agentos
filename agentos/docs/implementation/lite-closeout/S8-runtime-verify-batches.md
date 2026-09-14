# S8 RUNTIME-VERIFY 批次验收与逐行断言账本

本轮把 S0 矩阵里 **205 条 `RUNTIME-VERIFY`** 从「点名文件整体通过」推进到「该文件里实际执行过的断言」，
并把当时撤回 196 个 PASS 的唯一根因——*No immutable per-requirement mapping to specific executed test assertions and their outcomes.*——变成可复查的账本。

**边界**：本 PR 不改任何矩阵状态（`matrix.json`/`pass-freeze.json`/`pass-evidence-audit.json` 与基线逐字节一致），
不执行 PASS 提升，不执行 `--require-closed`。每行只得到 `candidate-supported` / `insufficient-evidence` / `failed` 三种候选判定之一。

## 1. 一个真实的工具缺陷与修复

`scripts/run-lite-verification-batches.mjs` 的计数解析器把 vitest 的输出判成 `unparsed`：

```text
      Tests  5 passed (5)      <- vitest 省略计数为 0 的分类
```

解析器对缺失分类返回 `null`（而不是 0），`hasCompleteCounts` 因此失败，整个批次被判 `unparsed` ——
**21 行**（agent-core 三个 Provider 适配器 + process-runtime 的 Windows 出生身份）因此无法取证。

修复方式（不是放宽判定）：缺失分类只有在**括号内总数等于各分类之和**时才被接受为派生的 0；
同一标签出现多次视为歧义，仍然不解析。修复后同一批次的判定从 `22 passed / 4 unparsed / 1 not-clean` 变为 **`26 passed / 1 not-clean`**。

唯一保留的 `not-clean` 是 `RunEngineProviderDispatcher.test.ts`：它含 4 个 env-gated 真实 Provider 用例，本机无对应 CLI，如实记为跳过而非通过。

## 2. 交付物

| 文件 | 内容 |
| --- | --- |
| `evidence/s8-runtime-verify-batches-20260914/verification-batches.json` | 27 个批次的原始进程收据：命令、cwd、raw exit、计数、捕获的 stdout/stderr、基线 SHA |
| `evidence/s8-runtime-verify-batches-20260914/vitest-verbose/` | 4 个包测试的 verbose 收据（含逐条断言名与退出码），供账本解析 |
| `evidence/s8-runtime-verify-batches-20260914/runtime-verify-ledger.json` | 205 行逐行判定，含点名文件、已解析断言数、命中断言（名 + 结果 + 共享词元 + 所在文件） |
| `evidence/s8-runtime-verify-batches-20260914/runtime-verify-ledger.md` | 同一内容的可读报告 |

## 3. 判定规则与结果

一行判为 `candidate-supported` 的条件（全部满足）：

1. 该行点名文件（`tests` 列表中的**任一**文件，不只第一个）在本基线上以干净计数退出（0 fail / 0 skip）；
2. 该文件内**至少一条已执行且通过**的断言，其名称与条款文本共享具区别性的词元（≥6 字符，或两个独立 4–5 字符词元）；
   或该断言名出现在该行 `finding` 中被引号括起的历史映射里（既有审计知识，精确子串匹配）。

| 判定 | 行数 |
| --- | ---: |
| `candidate-supported` | **99** |
| `insufficient-evidence` | **106** |
| `failed` | **0** |

106 行的构成：99 行「文件干净但没有任何已执行断言点名该条款」、6 行「点名文件本身不是批次可运行文件」、1 行「文件含 env-gated 跳过」。

## 4. 明确不证明的事

- **`candidate-supported` 不等于 PASS。** 它证明「某条已执行且通过的断言与条款共享具区别性的词元」，不证明该断言**完整覆盖**条款的全部语义。这一层仍需要逐行判读，正是下一步。
- **106 行没有判定为通过，不是判定为失败。** 它们需要逐行人工复核：要么条款由带编码前缀的断言名覆盖（例如 `INSP-12`、`P5C-R06`），要么点名文件确实不论证该条款（即撤回 PASS 时记录的那一类缺陷），两者都必须由人确认。
- **不做自动改指。** 账本对无命中的行给出跨文件的「建议覆盖断言」，但关键词匹配的跨文件建议噪声很大（抽查中多数是语义巧合），因此只作为复核线索，绝不据此改矩阵或改判。
- 本地真实 Provider 用例按环境跳过，其真实调用证据来自 `evidence/gates-20260914/` 与本轮各候选证据包，不由本账本代替。

## 5. 下一步（本 PR 之外）

1. 逐行复核 106 行：对每行判读其点名文件的已执行断言是否覆盖条款；确认覆盖的补记断言级收据，确认不覆盖的按 S0 规则记录（必要时提出改指）。
2. 6 行「点名文件不可运行」需要重新指认覆盖文件。
3. 全部 205 行闭合后，才能在执行最终主线 CI 之后讨论 `RUNTIME-VERIFY → PASS` 的提升。

