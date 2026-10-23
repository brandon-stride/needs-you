# needs-you (Claude Code mod)

A docked side pane where Claude pins what it needs from Brandon: a decision, something to do
outside the chat, or something to know. He answers in the pane (tick, option chip, note, chat)
and the answer lands in the session as a `[needs-you] #n …` message. Focus mode hides tool rows
and folds working narration in the transcript.

## Layout

- `.claude-plugin/plugin.json`: manifest. `.claude-plugin/types/` is written by the engine when the
  mod loads (API declarations and a tsconfig); it is git-ignored. `tsc -p .` only works after a load.
- `hooks/register.tsx`: every hook: session start, tools (`mcp__needs-you__pin|resolve|update|list`),
  the system-prompt section, turn tracking, the pane, focus mode, the `/needs-you` command.
- `hooks/items.ts`: pure helpers: parsing, messages, seen/archive rules, the reply catcher.
- `hooks/clawd.ts`: the pixel Clawd mascot (hats, held things, dance frames, reactions) as RGBA for a
  terminal `Image`, with a half-block `Raster` fallback. Drawn only in the minimized (icon) view.
- `hooks/needs-you.test.tsx`: `claude plugin test .`.
- `types/index.d.ts`: the `$.state` contract (items, settings, live, interim).

## Working on it

- Edit, then: `claude plugin validate .` and `claude plugin test .` (both must pass). Type-check
  with `npx -y -p typescript tsc -p .` once the engine has written `.claude-plugin/types/`.
- Run it in a session with `claude --plugin-dir ~/scratch/needs-you`; the folder hot-reloads on save.
- The shell deploy guard on this Mac blocks some python heredoc writes inside `~/.claude*`; use the
  Edit/Write tools for file changes.
- Design decisions that stick (Brandon, 2026-10-23): obsidian palette (pane `#0d0f12`, cards
  `#14171c`), one color per kind on the card edge (amber decide, clay do, sky know), compact filled
  chips instead of the engine's `[ label ]` buttons, no hotkeys on chips (the engine prefixes
  `a:`), no expand/collapse, answered items fold to one line, mascot only in the minimized view,
  Escape closes the pane while it has focus, no "for you to do · you" meta row.
- The engine owns: the tiny close mark on the frame, the `⏎` tag drawn after note text, the dock
  width cap (45% of the terminal), the focus inversion on a pressed button.

## History

Built 2026-10-22 in a scratch session; UI redesigned and 17 review findings fixed 2026-10-23.
Handoffs live in `~/scratch/.planning/handoffs/` until this repo grows its own `.planning/`.
