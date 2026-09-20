# Workspace layout architecture addendum — 2026-09-20

This records the user-approved September 19 workspace layout implemented in
`codex/liquid-glass-v2`. It supersedes the width guidance in section 6 of
`docs/Runtime-Specification lite/12-UI-Architecture.md` for `/workspace/[id]`.
The original specification remains byte-for-byte frozen because the Lite
scope/evidence gate hashes its contents. This addendum does not reclassify any
frozen acceptance result or change the `/runtime` layout contract.

| Panel | Default | Expanded range | Collapsed |
| --- | --- | --- | --- |
| Agents | 200 px | 180–300 px | 64 px icon rail, never hidden |
| Conversations | 220 px | 180–320 px | Fully hidden, no separator width |
| Main Canvas | Remaining space | 640 px desktop target | Always visible |
| Inspector | 280 px | 240–400 px | Fully hidden, no separator width |

An expanded panel separator contributes 8 px to the width budget. When space
is insufficient, Inspector and then Conversations leave the dock; Agents then
reduces to its icon rail. Below 712 px, Canvas uses the remaining space instead
of enforcing 640 px. Panels can be opened as overlays when docking would squeeze
the Canvas. Group conversations omit Conversations and retain the direct-chat
preference for switching back.

Panel states are independent. Header toggles restore hidden panels without
reserved expansion strips. Focus mode is a convenience preset (icon rail and
no other docked panels), with restoration of the preceding layout on exit.
Widths and visibility are versioned, per-workspace browser-local preferences;
temporary width-pressure changes do not overwrite them. These are UI state,
not Runtime Events.

`Ctrl/⌘+B` toggles Conversations; `Ctrl/⌘+Shift+L` toggles Inspector outside
editable controls, IME composition, and modal dialogs. Separators are keyboard
accessible. Full implementation and acceptance details remain in
[workspace-layout-v2.md](workspace-layout-v2.md) and
[workspace-ui-refinement.md](workspace-ui-refinement.md).
