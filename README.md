# needs-you

A Claude Code mod: a side pane that collects everything Claude needs from you, so you never fish it
out of the transcript.

Claude gets a `pin` tool and a standing instruction to use it the moment you must decide something,
do something outside the chat, or know something that changes the work. Each pin is a card in the
pane with a color for its kind, the question in plain words, the why, and the ways to answer:

- option chips for a decision, the recommendation starred;
- a `✓ done` / `✓ got it` chip for a task or a heads-up;
- a note line for context or a correction;
- `💬 chat` to bring it into the conversation.

Your answer reaches Claude as a `[needs-you] #n` message, quietly while a turn runs or as a prompt
when the session is idle. Answered cards fold to one line ("sending", then "Claude has it") and
leave once Claude resolves them. Helper agents can pin too; the card says who asked.

Focus mode (on by default) hides tool rows in the transcript and folds Claude's working narration
after a turn, so what is left on screen is the answer and the pane. `/needs-you focus off` turns it
off. `/needs-you add <text>` pins your own reminder; `─` minimizes the pane to a pixel Clawd who
dances while something is waiting; `✕` or Escape closes it until the next pin.

## Run it

```
claude --plugin-dir ~/scratch/needs-you
```

The folder hot-reloads on save. `claude plugin validate .` and `claude plugin test .` check it.
