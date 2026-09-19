# Liquid Glass 视觉阶段验收记录(UI-LG)

日期:2026-09-19
分支:`codex/liquid-glass-foundation`(基线 `origin-https/main` c66a3adb)
提交:`8855680b` LG-0 审计 → `26fb8660` LG-1..LG-3 实施 → `f328a2bf` 头部 frost 调优

## 自动化

- Web 测试:203/203 通过(含新增 GLASS-01/02/03/10/11 五项:token 双主题完备性、tintTone 映射、dpr 上限、SSR 渲染无玻璃属性、context 预算常量)。
- Web production build:通过,Next.js 类型检查通过;玻璃库被拆为独立异步 chunk(约 147 KB,按面懒加载,不进首屏)。
- Agent Core 测试:179/179 通过。Process Runtime 测试:240/240 通过。Shared 无测试脚本,由构建覆盖。
- Server 测试:2879/2894 通过,7 个失败均为基线既有环境问题,与本阶段 diff 无关(本分支相对 main 仅含 apps/web 与 docs 改动,server/packages 代码与基线逐字节一致):
  - 2 个 OpenCode CLI 发现断言(actual 'fallback'):本机环境问题,同类修复在未合并分支 5c117112 上。
  - 2 个 Windows 临时目录 ENOTEMPTY 清理失败:既有 known-risk(见 agentos-next-optimization-final.md)。
  - 2 个 worktree 路由/清理门禁测试 + 1 个群聊并行 worktree 测试:Windows worktree 环境类失败。
  - 1 个会话模型偏好持久化测试:复跑间不一致,环境抖动类。

## 浏览器验收(真实 Chrome,生产构建)

验证环境:API 服务器以 `AGENTOS_PROJECT_ROOT=<临时目录>` + `AGENTOS_FORCE_MOCK=true` 运行(真实数据库未触碰,mtime 保持 2026-09-16 不变);Web 以 `next start` 运行于 3001。

- 五个玻璃面全部进入 `data-liquid-glass="webgl"` 模式:落地页头部、新建工作区弹窗、会话头部、输入框、Toast 组。
- 深色/浅色双主题截图确认;主题切换经 MutationObserver 实时更新玻璃参数,全程零 console 错误。
- 会话页滚动折射:消息流在吸附头部下方弯月折射、输入框以磨砂玻璃悬浮;frost 经一轮调优(0.35 至 0.55)后标题与折射内容可读性平衡。
- 移动端断点(420px):布局无回归,侧栏折叠、输入区完整。
- 弹窗玻璃:落地页大标题透过弹窗面板产生明显弯曲折射,边缘弯月高光可见。
- 截图证据(本地未跟踪):`E:\workspace\Multi-Agent\agentos-glass-demo-root\shots\` 01-08 号。

## 对计划的偏离记录

1. main 基线无 ModalShell / 移动端 drawer / workspace-mobile-panel-actions(属未合并分支内容),弹窗玻璃改为对四个实际弹窗组件(GroupRenameModal / NewWorkspaceModal / ImagePreviewModal / ArtifactPreviewDialog)接入。
2. 环境光层为静态:库的 auto backdrop 无法感知 background-position 动画,`live: true` 常绘不符合性能目标。
3. 落地页头部改为 sticky 定位:原非吸附,玻璃无可折射内容;sticky 是实现该效果的必要前置。

## 已知限制

- auto backdrop 不捕获伪元素、阴影、CSS filter、SVG、表单控件;这些层在玻璃折射中缺失属库的设计边界。
- 群聊画布(BoundedGroupView/GroupConversationCanvas)不使用 ChatPanel,本阶段未玻璃化。
- 无 WebGL2 环境回退为既有毛玻璃样式(data-liquid-glass="fallback"),视觉与上一阶段一致。

## 下一步建议

- 推远端建 PR,浏览器人工复核深浅主题滚动折射手感。
- 玻璃参数(tint/frost/refraction)如有手感偏好,集中在 `apps/web/src/lib/glass.ts` 调整。
