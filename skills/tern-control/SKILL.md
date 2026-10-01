---
name: tern-control
description: Use when an agent running inside Tern must see or read peer agent sessions, inspect or capture another Tern block, arrange sessions, tabs or splits, send input to a block, or wait on a block's command. Do not use for status, progress, alerts, titles or session resume; Oh My Pi already reports those to Tern natively.
version: 0.1.0
---

# Tern Control

Typed tools for a live Tern daemon. Prefer them over shelling out to `tern`.

| Tool | Purpose | Approval |
| --- | --- | --- |
| `tern_agents` | `list` live agent sessions with session, tab, block, cwd and pid; `digest` one omp or pi block's recent messages | read |
| `tern_state` | `ls`, `inspect`, `process`, `capture` | read |
| `tern_events` | Bounded daemon event window as JSON lines | read |
| `tern_layout` | `new_session`, `new_tab`, `split`, `move`, `pip`, `dock`, `rename`, `keep_open`, `focus`, `close`, `kill_session` | exec |
| `tern_terminal` | `send_text`, `paste`, `send_keys`, `run`, `wait` | exec |

## Workflow

1. `tern_state ls` (or `tern_agents list`) to get numeric block ids. Prefer ids over titles; titles change as programs run.
2. Mutate with explicit `block` or `session` targets. New blocks never take focus; call `focus` only when the user asks to see something.
3. A block whose command exits successfully closes. Set `keep_open: true` when its output must stay readable.
4. Before sending input, `tern_state capture` the block. After `run`, `tern_terminal wait` with `until: "prompt"` or `"exit"`, then capture again.
5. Verify layout changes with `tern_state ls`.

## Peer agents

- `tern_agents list` covers the caller's own Tern session and leaves out the calling pane. Pass `all: true` for every session.
- `digest` reads only user and assistant text, never thinking or tool payloads. A fresh omp that has not received a prompt has no transcript yet; that is not an error.
- Read peers; do not type into another agent's pane unless the user asks. Use the harness's own task tools to delegate work.

## Boundaries

- `close` and `kill_session` refuse the calling agent's own pane and session.
- `send_keys` takes space-separated combos such as `ctrl+c`, `escape`, `enter`; anything else is rejected.
- `wait` reports a timeout as a result with `timedOut: true`, not as a failure. Decide whether to keep waiting or interrupt.
- Kill only sessions this agent created, unless the user names the target.
