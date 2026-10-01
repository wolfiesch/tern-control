# tern-control

Typed control and cross-session awareness for coding agents running in [Tern](https://stencil.so), Stencil's terminal.

An unofficial, community-maintained integration. It is not affiliated with Stencil.

## Why this exists

Oh My Pi already speaks Tern natively: busy state, done and attention alerts, titles, and session resume all work without an extension. What an agent still lacks is a typed way to see the panes around it and act on them. This extension adds that.

`tern_agents` lists the agent sessions running in Tern blocks beside the caller, with exact session, tab, block, working directory and process. It reads the transcript each Oh My Pi or Pi block holds open, so a digest always comes from the right session.

| Tool | Capability | Approval |
| --- | --- | --- |
| `tern_agents` | Live agent sessions by Tern session or globally; bounded peer transcript digests | read |
| `tern_state` | Sessions, tabs and blocks; panes and clients; block processes; screen capture | read |
| `tern_events` | Bounded daemon event collection | read |
| `tern_layout` | Sessions, tabs, splits, move, picture-in-picture, dock, rename, keep-open, focus, close, kill | exec |
| `tern_terminal` | Typed text, bracketed paste, key combos, run, wait | exec |

Mutations never take focus unless asked, and `close` and `kill_session` refuse the calling agent's own pane and session.

## Install

### Oh My Pi

```sh
omp install github:wolfiesch/tern-control
```

### Pi

```sh
git clone https://github.com/wolfiesch/tern-control.git
cd tern-control && bun install
ln -s "$PWD/src/index.ts" ~/.pi/agent/extensions/tern.ts
```

Requirements: Tern 0.2.0 or later with its daemon running. The extension finds `tern` on `PATH`, then inside `/Applications/Tern.app`; set `TERN_BIN` to override.

## Development

```sh
bun install
bun run check
bun test
```

Smoke against a live Tern:

```sh
omp --extension ./src/index.ts
```

## License

MIT
