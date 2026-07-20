# Theme Preference Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore the user's previously selected light or dark theme when the web app starts.

**Architecture:** Set the `<html>` theme attribute synchronously in the root layout before the first paint by reading browser `localStorage`, using dark as fallback. Initialize `ThemeProvider` from the same stored value, and keep its existing effect responsible for updating the attribute and persisting later changes.

**Tech Stack:** Next.js 14, React 18, TypeScript, existing Web build verification.

## Global Constraints

- Storage key is exactly `agentos-theme`.
- Only `light` and `dark` are valid stored values.
- No account, server, or cross-device synchronization.
- Preserve the existing theme toggle UI and CSS.

---

### Task 1: Add theme preference parsing tests

**Files:**
- Create: `apps/web/src/components/theme/themePreference.ts`
- Create: `apps/web/src/components/theme/themePreference.test.ts`

**Interfaces:**
- Test the pure browser-storage parsing behavior used by the Provider.

- [ ] **Step 1: Write tests for saved light theme and default fallback**

  Add tests that pass saved `light` and `dark` values to `readStoredTheme`, then verify missing and invalid values return `dark`.

- [ ] **Step 2: Run the test to verify it fails**

  Run: `node --import tsx --test apps/web/src/components/theme/themePreference.test.ts`

  Expected: the test initially fails because the parser does not exist yet.

### Task 2: Apply the saved theme before first paint

**Files:**
- Modify: `apps/web/src/components/theme/ThemeProvider.tsx`
- Modify: `apps/web/src/app/layout.tsx`

- [ ] **Step 1: Implement the shared storage parser**

  Export `Theme`, `THEME_STORAGE_KEY`, and `readStoredTheme(storage?)`; accept only `light` and `dark`, returning `dark` for unavailable, missing, invalid, or throwing storage.

- [ ] **Step 2: Replace the fixed initial state with a browser-safe lazy initializer**

  Use `readStoredTheme(window.localStorage)` when `window` exists and `dark` during server rendering. Keep the existing effect that writes the current theme.

- [ ] **Step 3: Set the HTML theme before first paint**

  Add a small inline script in `RootLayout`'s `<head>` that reads `agentos-theme` and sets `document.documentElement.dataset.theme` to `light` or `dark`, defaulting to `dark` inside a `try/catch`.

- [ ] **Step 4: Run the focused tests to verify they pass**

  Run: `pnpm exec vitest run apps/web/src/components/theme/ThemeProvider.test.tsx`

  Expected: all theme preference tests pass.

- [ ] **Step 5: Run the Web build**

  Run: `pnpm --filter @agentos/web build`

  Expected: Next.js build exits with code 0.

### Task 3: Review the final diff and commit the implementation

**Files:**
- Review: `apps/web/src/components/theme/ThemeProvider.tsx`
- Review: `apps/web/src/components/theme/ThemeProvider.test.tsx`

- [ ] **Step 1: Check formatting and diff scope**

  Run: `git diff --check; git diff -- apps/web/src/components/theme/ThemeProvider.tsx apps/web/src/components/theme/ThemeProvider.test.tsx`

  Expected: no whitespace errors and only theme persistence changes are present.

- [ ] **Step 2: Commit the implementation**

  Run: `git add apps/web/src/components/theme/ThemeProvider.tsx apps/web/src/components/theme/ThemeProvider.test.tsx; git commit -m "fix: persist web theme preference"`

  Expected: a new commit is created containing only the implementation and regression tests.
