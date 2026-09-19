# LG-0 Liquid Glass 视觉阶段入口审计

日期:2026-09-19
分支:`codex/liquid-glass-foundation`(从 `origin-https/main` c66a3adb,即 PR #189 lite-final-closeout 合并基线切出)

## 授权记录

用户在对话中审阅并确认 UI-LG 阶段方案(悬浮层优先范围、直接使用 npm 包、增加克制环境光背景),随后明确指令 "PLEASE IMPLEMENT THIS PLAN"。本指令即为本阶段的实施授权,不再单独等待授权回合。

## 依赖决策

- `apple-liquid-glass-webgl@^2.5.0`(MIT,零运行时依赖,ESM-only,自带 TypeScript 类型)。
- 渲染:WebGL2 shader(squircle SDF 厚度场 → Snell 折射 + 弯月边缘 + 色散 + Fresnel 边缘光)。
- 无 WebGL2 时库内建 `fallback: 'css'`,元素获得 `data-liquid-glass="webgl" | "fallback"` 属性用于样式分流。

## main 基线实况盘点(与计划的差异)

计划评审基于 docs 分支工作树;切到 main 基线后实测差异如下,实施按实况执行:

| 计划目标 | main 基线实况 | 处理 |
| --- | --- | --- |
| ModalShell 对话框 | main 无共享 ModalShell,弹窗为各自内联实现 | 对四个实际弹窗(GroupRenameModal / NewWorkspaceModal / ImagePreviewModal / ArtifactPreviewDialog)的面板元素接入 |
| 移动端 drawer / workspace-mobile-panel-actions | main 不存在这些类(属未合并分支内容) | 本阶段跳过 |
| ChatPanel signal-chat-header / signal-composer | 存在 | 接入,并改为悬浮 overlay 以折射滚动消息流 |
| 落地页 signal-header | 存在 | 接入 |
| ToastStack | 存在,`data-toast-stack` + `.toast-item` | 容器单实例 + targets 分组,共用一个 WebGL context |

存量 `backdrop-filter` 清单:globals.css 2 处(`.signal-header` blur(18px)、`.signal-chat-header` blur(16px)),弹窗 overlay 内联 `backdrop-blur-sm` 若干。全部保留为 fallback 视觉。

## 关键技术约束(来自库文档与实测)

1. `backdrop: 'auto'` 重绘**不捕获 `::before`/`::after`、阴影、CSS filter、SVG、表单控件**。因此环境光层必须是真实 DOM 元素上的真实 `background`,不能用伪元素——这是折射可见的前提。
2. 环境光层的“极缓慢漂移”动画无法被 auto backdrop 感知(background-position 动画不触发重绘),启用 `live: true` 逐帧重绘代价不符“克制”目标。**调整为静态环境光场**,作为对计划的偏离记录在此。
3. 每个实例一个 WebGL context(浏览器上限约 16):预算 ≤ 6;同屏实际最大 4(会话头部、输入框、Toast 组、一个弹窗)。
4. 库仅在 `useEffect` 内动态 `import()`,SSR/`next build` 路径不触碰;现有 node:test 用 renderToStaticMarkup,不会执行 effect。
5. 主题:监听 `documentElement[data-theme]` MutationObserver,变化时 `instance.update()` 切换 tintTone/参数。
6. 无障碍:`respectReducedTransparency` 保持默认 true;不引入 press/bloom 交互动效;既有 reduced-motion 与“状态不只靠颜色”等不变量不受影响。
7. 布局回归风险:会话头部/输入框从文档流改为绝对定位悬浮,用 ResizeObserver 测量补偿滚动区 padding。既有 ChatPanel 相关 node 测试与 Playwright 断点截图覆盖。

## 同屏 WebGL context 预算

| 页面 | 实例 | 数量 |
| --- | --- | --- |
| 会话页 | chat-header + composer + toast 组 + 弹窗(打开时) | ≤ 4 |
| 落地页 | page-header + NewWorkspaceModal(打开时) | ≤ 2 |

## 回滚

切片提交;fallback(data-liquid-glass="fallback" 或无 WebGL2)视觉与现状一致,任何一步可直接 revert。
