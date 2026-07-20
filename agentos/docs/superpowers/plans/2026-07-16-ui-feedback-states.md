# UI Feedback States Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the corrected UI feedback design for the workspace composer: can-send-driven button disabling, queue-safe loading feedback, a page-level stacked ToastStack, and separated connection, execution, and validation errors.

**Architecture:** Keep `ChatPanel` responsible for composer and inline rendering only. Keep Toast state, error classification, timer lifecycle, and the page-level `ToastStack` in the workspace page and a focused UI component. Add pure helpers for validation/error classification so behavior can be tested without rendering React.

**Tech Stack:** Next.js 14, React 18, TypeScript, Tailwind utility classes, existing CSS variables and Node test runner through `tsx`.

## Global Constraints

- `canSendMessage(draft, attachments)` is the only source of the real send-button disabled state.
- `sending` shows spinner and `aria-busy`, but does not disable a button that has queueable content.
- ToastStack is page-level and is not passed through `ChatPanel` as a `toasts` prop.
- Connection errors stay inline; execution errors use error Toasts; validation errors stay field-level.
- Do not add a third-party Toast or animation dependency.
- Preserve image attachments, queue behavior, automatic reconnect, cancellation, resizable layout, and existing CSS variables.
- Do not commit changes unless the user explicitly requests a commit.

---

### Task 1: Add pure UI feedback helpers and tests

**Files:**
- Create: `apps/web/src/lib/uiFeedback.ts`
- Test: `apps/web/src/lib/uiFeedback.test.ts`

**Interfaces:**
- Produces `ToastTone`, `ToastItem`, `UiErrorKind`, `SendButtonState`, `classifyUiError(error)`, `getComposerValidationError(content, attachmentCount)`, and `getSendButtonState(input)` for the page and ToastStack.

- [ ] **Step 1: Write the failing tests**

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyUiError, getComposerValidationError } from './uiFeedback.ts';

test('classifies connection failures separately from execution failures', () => {
  assert.equal(classifyUiError(Object.assign(new Error('stream ended'), { name: 'UnexpectedStreamEndError' })), 'connection');
  assert.equal(classifyUiError(new Error('agent execution failed')), 'execution');
});

test('returns a field validation message only when the composer is empty', () => {
  assert.equal(getComposerValidationError('  ', 0), '请输入消息或添加图片');
  assert.equal(getComposerValidationError('', 1), '');
  assert.equal(getComposerValidationError('开始执行', 0), '');
});

test('keeps a queueable send button interactive while sending', () => {
  assert.deepEqual(getSendButtonState({ canSend: true, sending: true }), { disabled: false, showSpinner: true, ariaBusy: true, label: '加入队列' });
  assert.deepEqual(getSendButtonState({ canSend: false, sending: true }), { disabled: true, showSpinner: true, ariaBusy: true, label: '加入队列' });
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

```powershell
pnpm --filter @agentos/server exec node --import tsx --test ../../apps/web/src/lib/uiFeedback.test.ts
```

Expected: FAIL because `uiFeedback.ts` does not exist.

- [ ] **Step 3: Implement the minimal helpers**

```ts
export type ToastTone = 'success' | 'warning' | 'error';
export type UiErrorKind = 'connection' | 'execution' | 'validation';

export interface ToastItem {
  id: string;
  tone: ToastTone;
  message: string;
  durationMs: number;
}

export interface SendButtonState {
  disabled: boolean;
  showSpinner: boolean;
  ariaBusy: boolean;
  label: string;
}

export const TOAST_DURATION_MS = 3200;

export function classifyUiError(error: unknown): UiErrorKind {
  const name = error instanceof Error ? error.name : '';
  return name === 'UnexpectedStreamEndError' || name === 'StreamHttpError' ? 'connection' : 'execution';
}

export function getComposerValidationError(content: string, attachmentCount: number): string {
  return content.trim() || attachmentCount > 0 ? '' : '请输入消息或添加图片';
}

export function getSendButtonState(input: { canSend: boolean; sending: boolean }): SendButtonState {
  return {
    disabled: !input.canSend,
    showSpinner: input.sending,
    ariaBusy: input.sending,
    label: input.sending ? '加入队列' : '发送消息',
  };
}
```

- [ ] **Step 4: Run the focused test and verify it passes**

Run the same command. Expected: 2 tests pass.

---

### Task 2: Build the page-level ToastStack

**Files:**
- Create: `apps/web/src/components/feedback/ToastStack.tsx`
- Modify: `apps/web/src/app/globals.css`

**Interfaces:**
- Consumes `toasts: ToastItem[]` and `onDismiss(id: string): void`.
- Produces a fixed right-bottom stack with `role="status"`, tone-specific styling, dismiss buttons, and CSS enter/exit animation classes.

- [ ] **Step 1: Add CSS animation rules**

Add `toast-enter` and `toast-exit` keyframes/classes to `globals.css`. The exit animation must finish before `onDismiss` removes the item.

- [ ] **Step 2: Implement `ToastStack`**

Use a `Map<string, { exitTimer: number; dismissTimer: number }>` ref so existing Toast timers are not restarted when a new Toast is appended. Start exit at `durationMs - 180`, add the id to a local exiting set, then call `onDismiss` after 180 ms. Clear all timers on unmount.

```tsx
type ToastStackProps = { toasts: ToastItem[]; onDismiss(id: string): void };

export function ToastStack({ toasts, onDismiss }: ToastStackProps) {
  const [exiting, setExiting] = useState<Set<string>>(new Set());
  const timersRef = useRef(new Map<string, { exitTimer: number; dismissTimer: number }>());

  useEffect(() => {
    const activeIds = new Set(toasts.map(toast => toast.id));
    for (const [id, timers] of timersRef.current) {
      if (!activeIds.has(id)) {
        window.clearTimeout(timers.exitTimer);
        window.clearTimeout(timers.dismissTimer);
        timersRef.current.delete(id);
      }
    }
    for (const toast of toasts) {
      if (timersRef.current.has(toast.id)) continue;
      const exitTimer = window.setTimeout(() => {
        setExiting(current => new Set(current).add(toast.id));
        const dismissTimer = window.setTimeout(() => onDismiss(toast.id), 180);
        timersRef.current.set(toast.id, { exitTimer, dismissTimer });
      }, Math.max(0, toast.durationMs - 180));
      timersRef.current.set(toast.id, { exitTimer, dismissTimer: 0 });
    }
    return () => {};
  }, [onDismiss, toasts]);

  return <div className="pointer-events-none fixed bottom-6 right-6 z-[80] flex w-[min(24rem,calc(100vw-2rem))] flex-col gap-2" role="status" aria-live="polite">
    {toasts.map(toast => <div key={toast.id} className={`pointer-events-auto toast-enter ${exiting.has(toast.id) ? 'toast-exit' : ''}`}>
      <button type="button" aria-label="关闭通知" onClick={() => onDismiss(toast.id)}>×</button>
      <span>{toast.message}</span>
    </div>)}
  </div>;
}
```

- [ ] **Step 3: Verify the component source and CSS compile**

Run:

```powershell
pnpm --filter @agentos/web build
```

Expected: the build reaches type checking without missing-component or CSS syntax errors.

---

### Task 3: Update ChatPanel composer feedback

**Files:**
- Modify: `apps/web/src/components/chat/ChatPanel.tsx`

**Interfaces:**
- Add `validationError?: string` to `ChatPanelProps`.
- Keep `connectionNotice` as inline conversation content; do not add `toasts`.

- [ ] **Step 1: Confirm the pure send-state contract before editing JSX**

Run the Task 1 focused test again. Expected: the queueable state is `{ disabled: false, showSpinner: true, ariaBusy: true, label: '加入队列' }`, while the empty state remains disabled.

- [ ] **Step 2: Implement the corrected button state**

Compute:

```tsx
const canSend = canSendMessage(draft, attachments);
const sendLabel = sending ? '加入队列' : '发送消息';
```

Use `disabled={!canSend}`, `aria-busy={sending}`, `aria-label={sendLabel}`, and show a spinner only while `sending`. Apply `disabled:cursor-not-allowed disabled:opacity-50`; do not apply `cursor-not-allowed` or reduced opacity merely because `sending` is true.

- [ ] **Step 3: Render field-level validation**

Render `validationError` immediately below the textarea/attachment area with `role="alert"` and the existing `ui-error`/border tokens. Keep `attachmentError` visible as its own field error.

- [ ] **Step 4: Run the web build**

Run `pnpm --filter @agentos/web build`. Expected: PASS.

---

### Task 4: Integrate Toasts and error classification in the workspace page

**Files:**
- Modify: `apps/web/src/app/workspace/[id]/page.tsx`

**Interfaces:**
- Own `ToastItem[]`, timers, `pushToast`, and `dismissToast`.
- Pass only `validationError` and `connectionNotice` into `ChatPanel`.
- Render `<ToastStack toasts={toasts} onDismiss={dismissToast} />` as a sibling of `ChatPanel` in the workspace root.

- [ ] **Step 1: Replace the single action notice state**

Remove `actionNotice` state and its single-message timeout effect. Add a stable id counter/ref, `toasts` state, and timer cleanup. `pushToast(tone, message)` appends a `ToastItem` and caps the visible stack at four items; `dismissToast` removes one item and clears its timer.

- [ ] **Step 2: Route existing success notices to success Toasts**

Replace conversation copy, memory generation, queue admission, connection recovery, and deletion success calls with `pushToast('success', message)`. Do not use Toasts for the inline reconnect progress notice.

- [ ] **Step 3: Route errors by type**

Use `getComposerValidationError` before the silent `canSendMessage` return and set `validationError` for empty composer input. Keep `attachmentError` field-level. For `UnexpectedStreamEndError` and `StreamHttpError`, update `connectionNotice`; for non-cancel execution failures, call `pushToast('error', message)`. User cancellation must clear the error state without adding an error Toast.

- [ ] **Step 4: Render the page-level stack and pass the field error**

Render `ToastStack` outside `ChatPanel`, pass `validationError={validationError}`, and remove the old bottom-center `actionNotice` JSX.

- [ ] **Step 5: Run focused tests and build**

Run:

```powershell
pnpm --filter @agentos/server exec node --import tsx --test ../../apps/web/src/lib/uiFeedback.test.ts
pnpm --filter @agentos/web build
```

Expected: helper tests and production build pass.

---

### Task 5: Full verification and browser QA

**Files:**
- Verify: `apps/web/src/app/workspace/[id]/page.tsx`
- Verify: `apps/web/src/components/chat/ChatPanel.tsx`
- Verify: `apps/web/src/components/feedback/ToastStack.tsx`
- Verify: `apps/web/src/lib/uiFeedback.test.ts`

- [ ] **Step 1: Run the complete relevant test set**

```powershell
pnpm --filter @agentos/server exec node --import tsx --test ../../apps/web/src/lib/uiFeedback.test.ts ../../apps/web/src/lib/composerInteraction.test.ts ../../apps/web/src/lib/streamReconnect.test.ts
pnpm --filter @agentos/web build
git -c safe.directory=E:/workspace/Multi-Agent diff --check
```

Expected: all tests pass, the web build succeeds, and diff check reports no whitespace errors.

- [ ] **Step 2: Perform browser QA**

With the workspace page open, verify:

1. Empty composer: send button is visibly disabled with reduced opacity and forbidden cursor.
2. While a run is active with draft text: send button shows spinner, remains clickable, and queues the message.
3. Trigger two success notices: they appear as separate right-bottom Toasts and disappear independently.
4. Trigger an execution error: it appears as an error Toast, not a duplicate inline error.
5. Submit an empty composer or invalid attachment: the error appears under the composer as a field-level alert.
6. Disconnect/reconnect: connection progress remains inline in the conversation area.

---

### Execution record

- Implemented all tasks in this plan on 2026-07-16.
- Verification passed: 10 focused frontend/helper tests, 95 server tests, `pnpm --filter @agentos/web build`, and `git diff --check`.
- Browser QA passed with local Playwright for empty/send states, field-level validation, right-side Toast display/auto-dismiss, and 760px layout.
- The in-app browser was also checked first; its separate network context could not reach the local API process, so the final interactive checks used the local Playwright fallback.
