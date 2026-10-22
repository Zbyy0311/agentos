# T5-2 Runtime Inspector Timeline

The Timeline follows Runtime Inspector sections 39–46. It reads canonical Run
Events and preserves durable sequence order. Summary folds only contiguous
`stream.text_delta` with matching Stage/correlation/visibility/severity; approval,
terminal and error facts remain individual. Detailed and bounded, redacted Raw
views share filters and cursor pagination. Stage/correlation/domain grouping is
a projection, with no execution or lifecycle authority.

The browser owns one serialized cursor for pagination, SSE notifications and gap
backfill. Duplicate notifications do not create duplicate rows. HTTP 410 replaces
the projection through a full synchronization and exposes a retention warning.
Live Tail follows only while the reader is at the bottom; browsing history keeps
the scroll position and offers an explicit jump to the latest event.

Browser testing found that a failed durable subscription could leave SSE open
with a heartbeat. The canonical Run route now closes on observation failure so
the client can reconnect. It also releases the subscription when synchronous
replay fails before its unsubscribe handle is returned. A regression covers both
synchronous and live failure and retains the existing overflow/Run-state guards.

## Verification

- Implementation checkpoint `d0fe23d0`: Inspector server gate 38/38; complete Web
  suite 391/391; server TypeScript build passed.
- The follow-up passed the 36-test Run SSE/stream/Timeline gate and server
  TypeScript build. The combined final seven-file server gate passed **63/63**,
  recorded in `inspector-final-server-gate.log`.
- Edge/Playwright ran the actual unmodified `RunInspectorPanel` against the real
  Inspector routes, SQLite repository and canonical Run SSE. The external harness
  tests Summary/Detailed/Raw, highlighted approval/terminal facts, grouping,
  filtering, live backfill, paused scrolling, explicit jump, deleted Event
  recovery through HTTP 410, and unique rows after resync. Desktop 1440×1000 and
  mobile 390×844 had no horizontal overflow or page exceptions. One expected
  network-console 410 accompanied the deliberate retention fixture.
- Evidence lives outside the checkout in
  `E:/workspace/Multi-Agent-worktrees/agentos-t5-handoff-evidence-20261020/`:
  `inspector-browser-result.json`, `inspector-desktop.png`, `inspector-mobile.png`,
  `inspector-sse-failure-regression.log`, `inspector-server-d0fe.log`, and
  `inspector-web-d0fe.log`. The synthetic runtime data and test servers are
  separate from user workspaces.

Local receipts are not remote CI or merge evidence. Publication requires the
complete exact-head PR checks and separate post-merge main checks.
