# Changelog

## [0.1.0] - 2026-10-01

### Added

- `tern_agents`: live agent-session discovery across Tern blocks with exact session, tab, block, cwd and pid; caller-scoped by default with the calling pane excluded; bounded user and assistant digests for Oh My Pi and Pi blocks, read from the transcript the block's process holds open.
- `tern_state`: `ls`, `inspect`, `process`, and `capture` with scrollback, ANSI or HTML output and a line cap.
- `tern_layout`: sessions, tabs, splits, move, picture-in-picture, dock, rename, keep-open, focus, close, and kill, with self-target refusal for close and kill.
- `tern_terminal`: typed text, bracketed paste, validated key combos, run, and wait with exit status and timeout reporting.
- `tern_events`: bounded daemon event collection with client churn filtered out.
- `tern-control` skill.
