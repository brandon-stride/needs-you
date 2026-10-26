# needs-you

A Claude Code mod: a docked pane where Claude pins what it needs from the person (decide, do,
know) and takes their answers in place. README.md says what it does; this file says how to work on it.

## Layout

- `.claude-plugin/plugin.json` and `marketplace.json`: the manifest and the one-entry marketplace
  that makes `/plugin install needs-you --marketplace <owner>/<repo>` work.
- `.claude-plugin/types/`: written by the engine when the mod loads (API declarations, tsconfig).
  Git-ignored. `npm run typecheck` only works after a load.
- `hooks/register.tsx`: every hook. `hooks/items.ts`: pure helpers. `hooks/clawd.ts`: the mascot.
- `hooks/needs-you.test.tsx`: `claude plugin test .`. Stubs stand in for the engine.
- `types/index.d.ts`: the `$.state` contract (items, settings, live, interim).
- `scripts/render-media.ts`: regenerates `media/clawd.png` from `clawd.ts`.

## Rules of the road

- After any change: `npm run validate`, `npm test`, `npm run typecheck`. All three must pass.
- Make file edits with the editor tools, not shell heredocs: this keeps the hot-reload watcher and
  the pre-commit type check happy.
- The engine owns a few things a mod cannot change: the close mark on the pane frame, the `⏎` tag
  drawn after an Input's text, the dock width cap (45% of the terminal), the focus inversion on a
  pressed button, and the floor below which an unasked pane open waits (144 columns, 110 once the
  person has opened it by command).
- Pane design decisions that stick: dark palette (`#0d0f12` pane, `#14171c` cards), one colour per
  kind on the card edge, compact filled chips instead of `[ label ]` buttons, no hotkeys on chips (the
  engine prefixes them with `a:`), the mascot only in the minimized view, Escape closes the pane
  while it has focus.
- The pane is a narrow dock (at most 45% of the terminal), so it shows one item at a time in full (the
  card view, the default) with `‹ ›` to step and `≡` for a list of titles; nothing on a card is cut
  short. Pins are kept short at the source instead: `LIMITS` in `items.ts`, refused with the reason
  when over, never clipped. (Brandon, 2026-10-26: asks were cut off and could not be opened.)
- Notes are typed in the main prompt box (`✎ note` fills `[needs-you] #n note: `), not in an Input in the
  pane: the engine draws an Input's `⏎` tag right after the typed text and squeezes a multi-row field
  (checked live 2026-10-26).
- An item answered in the pane leaves at the end of the turn that read it; one answered in chat is
  closed by the model, which sees the waiting items beside each typed message.
- Conventional commits, lowercase, under 70 characters.
