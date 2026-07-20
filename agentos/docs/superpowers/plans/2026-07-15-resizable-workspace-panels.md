# Resizable Workspace Panels Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add reliable mouse/touch resizing for the workspace and conversation-history panels without compressing the chat composer into an overlapping layout.

**Architecture:** Keep resize state local to `apps/web/src/app/workspace/[id]/page.tsx`. Use a small pure helper for clamping panel widths, pass inline widths into the two existing sidebar components, and render fixed-width pointer handles between siblings. Preserve the existing flex layout, responsive hide rules, and narrow composer container query.

**Tech Stack:** Next.js 14, React 18, TypeScript, native Pointer Events, Node test runner, Browser plugin.

---

### Task 1: Add width calculation contract

**Files:**
- Create: `apps/web/src/lib/resizablePanels.ts`
- Create: `apps/web/src/lib/resizablePanels.test.ts`

- [ ] **Step 1: Write the failing tests**

Cover the three required behaviors: clamping a panel to its own range, preventing a resize from shrinking the chat area below its minimum, and allowing normal values through unchanged.

```ts
test('clamps a panel width to its configured range', () => {
  assert.equal(clampPanelWidth(120, { min: 180, max: 360 }), 180);
  assert.equal(clampPanelWidth(500, { min: 180, max: 360 }), 360);
});

test('keeps the chat area above its minimum while resizing', () => {
  assert.equal(getResizablePanelWidth({ proposed: 420, panelMin: 180, panelMax: 420, availableWidth: 1016, otherPanelWidth: 256, handleWidth: 8, chatMinWidth: 420 }), 332);
});

test('keeps an in-range width unchanged', () => {
  assert.equal(getResizablePanelWidth({ proposed: 280, panelMin: 180, panelMax: 360, availableWidth: 980, otherPanelWidth: 256, handleWidth: 8, chatMinWidth: 420 }), 280);
});
```

- [ ] **Step 2: Run the test and verify it fails for the missing helper**

Run: `node --test apps/web/src/lib/resizablePanels.test.ts`

Expected: FAIL because `resizablePanels.ts` does not exist yet.

- [ ] **Step 3: Implement the minimal pure helpers**

Export `clampPanelWidth` and `getResizablePanelWidth`. The second helper first clamps to the panel range, then limits the result to `availableWidth - otherPanelWidth - handleWidth - chatMinWidth`, never returning below `panelMin` unless the container itself cannot satisfy all declared minima.

- [ ] **Step 4: Run the focused test and verify it passes**

Run: `node --test apps/web/src/lib/resizablePanels.test.ts`

Expected: 3 passing tests, 0 failures.

### Task 2: Add pointer resize handles to the existing layout

**Files:**
- Modify: `apps/web/src/app/workspace/[id]/page.tsx`
- Modify: `apps/web/src/components/chat/AgentList.tsx`
- Modify: `apps/web/src/components/chat/ConversationHistory.tsx`
- Modify: `apps/web/src/app/globals.css`

- [ ] **Step 1: Add width props to the two sidebar components**

Accept an optional `panelWidth` number and apply it as an inline `width` style while retaining `min-width: 0`, `flex-shrink: 0`, and the existing responsive class rules.

- [ ] **Step 2: Add the page-local resize state and pointer lifecycle**

Initialize workspace width at `240`, history width at `256`, and use a single active resize ref with `panel`, `startX`, and `startWidth`. On `pointerdown`, call `setPointerCapture`, install `pointermove`, `pointerup`, and `pointercancel` handlers, and add a temporary `resizing-panels` body class. On cleanup, remove listeners and the class. Use the helper from Task 1 and the three-column container width to clamp the proposed width.

- [ ] **Step 3: Render the two handles**

Insert one handle after each resizable sidebar. Give each handle `data-panel-resize`, a panel identifier, `role="separator"`, `aria-orientation="vertical"`, and a visible label. Hide the history handle when the history sidebar is hidden by the existing mobile breakpoint.

- [ ] **Step 4: Add stable handle styles**

Use a fixed `flex: 0 0 8px` handle width, `touch-action: none`, `cursor: col-resize`, and hover/active colors derived from existing app variables. Do not use negative margins or absolute positioning so the handles cannot cover adjacent content.

- [ ] **Step 5: Run TypeScript/build verification**

Run: `pnpm --filter @agentos/web build`

Expected: Next.js compilation, type checking, and static generation pass.

### Task 3: Browser interaction verification

**Files:**
- No committed files; use the existing local browser session.

- [ ] **Step 1: Reload the target page and verify it is not blank**

Target flow: `http://localhost:3001/workspace/e525c034` -> page loads -> drag the first handle -> drag the second handle -> collapse/expand thinking progress -> verify composer alignment.

- [ ] **Step 2: Drag the first handle and inspect geometry**

Move the handle in both directions. Verify the workspace sidebar width stays between `180px` and `360px`, and verify no horizontal overflow is introduced.

- [ ] **Step 3: Drag the second handle and inspect geometry**

Move the handle in both directions. Verify the history width stays between `180px` and `420px`, chat width remains above its minimum, and the composer controls do not overlap.

- [ ] **Step 4: Check the collapse regression and console**

Expand and collapse the thinking process. Verify the composer row remains aligned with zero horizontal overflow. Check page identity, meaningful DOM content, screenshot evidence, and `tab.dev.logs({ levels: ['error', 'warn'] })`.

### Task 4: Final verification

- [ ] **Step 1: Run the focused helper and existing composer tests**

Run: `node --test apps/web/src/lib/resizablePanels.test.ts apps/web/src/lib/composerInteraction.test.ts`

Expected: all tests pass.

- [ ] **Step 2: Check the final diff for whitespace errors**

Run: `git -c safe.directory=E:/workspace/Multi-Agent -C E:/workspace/Multi-Agent diff --check -- agentos/apps/web/src/lib/resizablePanels.ts agentos/apps/web/src/lib/resizablePanels.test.ts agentos/apps/web/src/app/workspace/[id]/page.tsx agentos/apps/web/src/components/chat/AgentList.tsx agentos/apps/web/src/components/chat/ConversationHistory.tsx agentos/apps/web/src/app/globals.css`

Expected: no output and exit code 0.
