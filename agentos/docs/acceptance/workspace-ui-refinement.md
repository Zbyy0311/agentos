# Workspace UI Refinement 验收记录

状态：工程验收完成，人工 Visual Gate 仍待指定验收负责人确认。

范围：仅 `apps/web` 与本记录/计划文档；未修改 Server、API、事件协议或 `/runtime` 的共享布局行为。

## 版本与证据

- 基线：`35cb39d9`（`feat(web): prioritize workspace canvas layout`）。
- 实施分支：`codex/liquid-glass-v2`。
- 预览地址：`http://localhost:3001/workspace/ws_01M2W2YS5C45WVPW30SQW25HJ3`。
- 浏览器验收：Browser 插件当前不可用，按前端测试技能要求使用 Playwright 1.55 + 本机 Chrome：`C:\Program Files\Google\Chrome\Application\chrome.exe`。
- 截图目录：`C:\Users\Administrator\.codex\visualizations\2026\09\19\01a0b7ea-4ff1-7fd0-85f9-30d8a74647c7`。

## 验收等级

- **MUST**：违反即不能交付。
- **SHOULD**：默认应满足；若偏离必须记录理由并由验收负责人批准。
- **TARGET**：优化目标，不作为单独的机械 CI 门禁。

## Phase A/B/C/E 结果

| 项目 | 等级 | 结果 | 证据 |
|---|---|---|---|
| 主工作区无整体横向滚动 | MUST | PASS | Playwright 617/856/1014/1260/1364/1440/1920px 均为 `scrollWidth - clientWidth = 0` |
| Agent 导航不完全消失 | MUST | PASS | 617px 实测保留 64px 图标栏；按钮有名称/tooltip/选中状态 |
| 会话栏、Inspector 独立隐藏且不占宽 | MUST | PASS | 1014px 实测 history/Inspector 为 0；群聊不渲染会话栏且私聊可恢复偏好 |
| 主区适配实际容器宽度 | MUST | PASS | 1014px=806px、1260px=824px、1440px=716px；1364px 达到 640px 下限 |
| 低于 712px 不强制 640px | MUST | PASS | 617px 主区 545px，页面无横向滚动 |
| Inspector 覆盖面板可恢复 | MUST | PASS | 617px 打开/关闭、Escape、焦点恢复通过浏览器验收；遮罩和焦点陷阱由 `WorkspacePanelOverlay` 提供 |
| 组件与消息内容不被裁切 | MUST | PASS | Agent/System surface 使用完整消息宽度；User bubble 限制为 80%/760px；Code/Diff 容器独立滚动 |
| Composer 与 Mention 宽度一致 | MUST | PASS | 群聊 Mention 位于 Composer 内部，透明背景，无额外底板；1014px 无横向溢出 |
| 玻璃层降级 | MUST | PASS | `fallback: 'css'`、`maxDpr: 2`、`live: 'auto'`、`respectReducedTransparency: true`；无 WebGL2 时保留 CSS fallback |
| 深色/浅色主题 | MUST | PASS | `final-dark-1440.png`、`final-light-1440.png`；主题切换后 `html[data-theme]` 与玻璃参数同步 |
| R0 边界 | SHOULD | PASS | pointercancel 恢复原偏好；resize 期间不写 localStorage；快捷键忽略输入框、IME、模态、重复 keydown |
| 历史布局持久化 | SHOULD | PASS | 按 workspace + v2 key 保存；旧版本/损坏 JSON 回退默认值，不进入无出口 focus mode |
| 页面视觉密度 | SHOULD | 待人工确认 | 自动化与截图已降低重复 Header/空卡；Runtime 结果与 Inspector 的信息密度仍需产品验收负责人确认 |
| 常规几何误差 | TARGET | 已记录 | 几何值按实际布局读取，不将 DPR/字体 rounding 误差作为硬门禁 |

## 实测布局矩阵

以下为同一页面、同一无痕浏览器上下文的 DOM 实测像素；`main` 为主工作区宽度，`overflow` 为页面横向溢出量。

| viewport | Agent rail | Conversations | Workspace | Inspector | overflow |
|---:|---:|---:|---:|---:|---:|
| 617 | 64 | 0 | 545 | 0 | 0 |
| 856 | 200 | 0 | 648 | 0 | 0 |
| 1014 | 200 | 0 | 806 | 0 | 0 |
| 1260 | 200 | 220 | 824 | 0 | 0 |
| 1364 | 200 | 220 | 640 | 280 | 0 |
| 1440 | 200 | 220 | 716 | 280 | 0 |
| 1920 | 200 | 220 | 1196 | 280 | 0 |

## Visual Gate

人工确认项不能由自动化全绿替代；当前记录为“待确认”，并保留截图证据：

1. 信息主次：Workspace > Message Result > Inspector > Navigation。
2. Surface 层级：背景、内容、浮层玻璃可区分，Composer/Header 不遮挡正文。
3. Card 密度：不出现无意义的 Card-in-Card；需确认 Runtime 结果与 Inspector 的重复步骤是否符合产品预期。
4. Accent：橙色仅用于品牌、主操作、选中和必要状态。
5. 阅读：正文、代码、Diff 不因装饰性 UI 缩窄。
6. Empty state：无执行证据时 Inspector 显示“尚未开始”，不伪造 0/— 结果卡。
7. Runtime：执行中、等待补充、失败、取消、审批状态可区分。

## 自动化与构建

- `pnpm --filter @agentos/web test`：**228 passed, 0 failed**。
- `pnpm --filter @agentos/web exec tsc --noEmit`：PASS。
- `pnpm --filter @agentos/web build`：PASS；`/workspace/[id]` 323 kB，First Load JS 414 kB；`/runtime` 路由正常生成。
- `git diff --check`：PASS。
- `prefers-reduced-motion: reduce`：浏览器实测匹配，动画/过渡计算为 `0.00001s`，动画只运行一次。
- WebGL context：库选项集中限制在 6 个实例预算以内，单实例 DPR 上限为 2；未进行 DevTools 级长时间 FPS 基准。

## 截图

- [深色 1440px](/C:/Users/Administrator/.codex/visualizations/2026/09/19/01a0b7ea-4ff1-7fd0-85f9-30d8a74647c7/final-dark-1440.png)
- [浅色 1440px](/C:/Users/Administrator/.codex/visualizations/2026/09/19/01a0b7ea-4ff1-7fd0-85f9-30d8a74647c7/final-light-1440.png)
- [浅色 617px 窄屏](/C:/Users/Administrator/.codex/visualizations/2026/09/19/01a0b7ea-4ff1-7fd0-85f9-30d8a74647c7/final-light-617.png)
- [群聊 Mention 1014px](/C:/Users/Administrator/.codex/visualizations/2026/09/19/01a0b7ea-4ff1-7fd0-85f9-30d8a74647c7/final-group-1014.png)

## 未执行/已知限制

- 未启动真实 Provider 新 Run；Runtime 投影单元测试使用跨 Run/Agent/attempt 夹具，浏览器截图使用本地已有结构化 Run 数据，不能替代真实流式验收。
- 未完成 DevTools 60 秒滚动 + 流式输出 FPS 对照；因此性能 TARGET 只能记录为未执行。
- 当前自动化环境未提供 `prefers-reduced-transparency` 的标准 Playwright 模拟开关；实现保留库的 `respectReducedTransparency`，需在支持该媒体特征的真实浏览器/系统设置下补验。
- Visual Gate 的最终通过/偏差批准需要用户或指定验收负责人签字；本记录不把截图自动标记为人工通过。

## 回滚

视觉切片主要集中在 `globals.css`、workspace page、ChatPanel、ExecutionInspector 与 layout/glass/presence helpers；R4 投影边界见下一份记录。回滚应按提交粒度执行，不使用 `git reset --hard` 覆盖用户未提交文件。
