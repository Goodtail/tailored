# agent-watch

A Claude Code mod to watch your helpers work. It shows what each subagent costs
and which files were read or changed, and by whom.

## What it shows

- **Helpers.** For each subagent: its name, model, how many model requests it made,
  tokens (context re-read, new input, output), how long it ran, and an estimated cost.
- **Files.** A list of files that were touched, newest first. `👁` marks a file that was
  only read (purple), `✎` marks one that was changed (yellow) with the lines added and
  removed, and who touched it (`main` or a helper's name).
- **A line above the prompt** while helpers exist:
  `🧬 2/3 helpers [██████░░] · 1 running · ≈$0.42 · ✎ 5 files`.
  It goes away five minutes after the last helper finishes.
- **A toast** when a helper finishes: its name, estimated cost and how many files it changed.

## Install

In a Claude Code terminal session:

```
/plugin install agent-watch --marketplace Goodtail/tailored
```

Then run `/agents` to open the pane. `/agents clear` resets what it remembers.

## Options

Set them with `/plugin configure agent-watch@tailored`.

| Option | Default | Meaning |
| --- | --- | --- |
| `showProgressLine` | `true` | The line above the prompt while helpers exist. |
| `toastWhenHelperFinishes` | `true` | A toast with the helper's name, cost and changed files. |
| `maxFiles` | `40` | How many files the pane lists. |

## How accurate is it

- **Cost is an estimate.** It uses API list prices for the helper's model. A cache read is
  priced at the published cache price (a tenth of the input price where none is published),
  and a cache write at 1.25 times the input price. Treat it as a guide to which helper was
  expensive, not as a bill. A model the mod does not know shows `≈$?`.
- **Only Read, Edit, Write and NotebookEdit calls are seen.** A file changed through a Bash
  command (`sed -i`, a formatter, a build) is not noticed.
- **Counts start when the mod loads.** Helpers and files from before are not shown.
- The main conversation's cost is not listed here; it is in the session's own cost.

## Develop

```
claude --plugin-dir .
claude plugin validate .
claude plugin test .
```

## License

MIT
