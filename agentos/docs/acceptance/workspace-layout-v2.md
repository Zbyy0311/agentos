# 主工作区布局优化验收记录（UI-LG / Layout v2）

日期：2026-09-19；分支：`codex/liquid-glass-v2`；范围：`apps/web` 的 `/workspace/[id]`；`/runtime` 未改版。

## 交付内容

- Agent 导航默认 200px，可在 180–300px 间调整，低于 140px 收起为 64px 图标栏；图标栏保留 Agent、群聊和设置入口，并提供 `title`、ARIA 名称及选中状态。
- 会话列表默认 220px，可在 180–320px 间调整，支持独立完全隐藏；Inspector 默认 280px，可在 240–400px 间调整，支持独立完全隐藏。
- 拖拽分隔条与键盘分隔条均可调整；第一栏、第二栏和第四栏的收起阈值分别为 140px、140px、200px。
- 窄窗口自动按 Inspector → 会话列表 → Agent 图标栏的顺序释放主区空间；临时退出停靠不覆盖用户偏好。空间不足时从头部按钮以覆盖面板打开，支持关闭按钮、遮罩、Escape 和焦点恢复。
- 专注模式是快捷预设：进入时保存三栏状态，退出时恢复；手动改变任一栏位会退出专注模式并保留当前调整。
- `Ctrl/⌘+B` 切换会话列表，`Ctrl/⌘+Shift+L` 切换 Inspector；输入控件、IME 组合和模态窗口中不拦截。
- 布局宽度、独立开关和专注恢复信息按工作区保存于版本化 localStorage；存储异常时回退默认值。
- 主区、头部、Composer 和液态玻璃绘制层限制横向溢出；代码块与 Diff 提供换行/滚动切换。

## 真实浏览器验收

验证方式：Chrome channel + Playwright，生产预览 `http://localhost:3001`。当前环境未提供 Browser 专用插件，因此使用本机真实 Chrome 内核完成截图和交互检查。

| 视口宽度 | Agent 导航 | 会话列表 | 主区 | Inspector | 结果 |
|---:|---:|---:|---:|---:|---|
| 617px | 64px 图标栏 | 隐藏 | 545px | 隐藏 | 通过 |
| 856px | 200px | 隐藏 | 648px | 隐藏 | 通过 |
| 1014px | 200px | 隐藏 | 806px | 隐藏 | 通过 |
| 1260px | 200px | 220px | 824px | 临时退出停靠 | 通过 |
| 1364px | 200px | 220px | 640px | 280px | 通过 |
| 1440px | 200px | 220px | 716px | 280px | 通过 |
| 1920px | 200px | 220px | 1196px | 280px | 通过 |

已检查：

- 深色与浅色主题截图；液态玻璃头部、Composer 仍可读，窄屏玻璃 canvas 不产生页面横向滚动。
- 宽屏独立关闭会话列表/Inspector 后，隐藏栏及分隔条不占宽度。
- 1014px 下打开会话列表或 Inspector 使用覆盖面板，不挤压主区；Escape、遮罩和关闭按钮可关闭，焦点回到对应头部按钮。
- 专注模式进入/退出恢复原三栏组合；专注状态下手动打开 Inspector 会退出专注并保留新布局。
- 拖拽收起 Agent 导航、会话列表、Inspector；键盘 Home/End 收起与恢复宽度。
- 刷新后恢复隐藏状态和宽度；窗口从 1440px 缩到 1260px 时只临时隐藏 Inspector，恢复到 1440px 后自动回到原停靠状态；用户主动隐藏的会话列表在窗口变宽后保持隐藏。
- 私聊与群聊切换：群聊不显示第二栏，回到私聊恢复会话列表偏好。
- `body` 与 `documentElement` 的 scrollWidth 在所有验收视口均未超过视口宽度。

截图证据：

- `C:\Users\Administrator\.codex\visualizations\2026\09\19\01a0b7ea-4ff1-7fd0-85f9-30d8a74647c7\workspace-layout-dark.png`
- `C:\Users\Administrator\.codex\visualizations\2026\09\19\01a0b7ea-4ff1-7fd0-85f9-30d8a74647c7\workspace-layout-light.png`
- `C:\Users\Administrator\.codex\visualizations\2026\09\19\01a0b7ea-4ff1-7fd0-85f9-30d8a74647c7\workspace-layout-history-overlay.png`

## 自动化验证

- `pnpm --filter @agentos/web test`：223 passed / 0 failed。
- `pnpm --filter @agentos/web exec tsc --noEmit`：通过。
- `pnpm --filter @agentos/web build`：通过，Next.js 生产构建完成。
- 布局纯函数覆盖：四栏最小宽度、按优先级退出停靠、独立开关、群聊偏好、存储归一化、三个收起阈值。

## 已知限制

- Liquid Glass 依赖 WebGL2；不支持或用户启用 reduced transparency 时沿用库的 CSS 毛玻璃降级。玻璃绘制不承担代码、Diff、表单控件的内容排版。
- 代码、表格和 Diff 的横向滚动仍限定在各自内容容器内；代码换行由内容块内的切换按钮控制。
- 本轮仅调整 `/workspace/[id]` 的客户端布局状态，不修改 Server、API、消息/执行契约和 `/runtime` 共享布局行为。
