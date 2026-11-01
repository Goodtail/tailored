# session-deck

A Claude Code mod that keeps your session's vital signs in view: which model
you are on, how full the context window is, how much of your usage limit is
left, which git branch and worktree you are in, which pull requests are open,
and how far along Claude's todo list is.

It draws a three-row colored band above the prompt (emoji labels, color-coded
values) and a detail pane (`/deck`). An optional plain-text line under the prompt
is available too.

## What it shows

| Item | Band | Pane |
| --- | :-: | :-: |
| Model | yes | yes |
| Context used (bar, percent, tokens) | yes | yes, with a per-turn history sparkline |
| Usage limits (5-hour, 7-day) used and left, reset time | 5h | all reported |
| Git branch, worktree name, changed-file count | yes | yes |
| Open pull requests (current branch highlighted) | current PR | list of 10 |
| Todo progress (from Claude's todo list) | yes | yes, with the current task |
| Working directory, trimmed from the left to fit (nearest folders stay) | yes (option) | yes |
| This message's spend: model requests, re-sent context, new input, output | yes | |
| API-equivalent cost of the session (what the tokens would cost at API prices) and the last turn's share | yes, in the status line | yes |

A toast appears once when the context passes your warning threshold, and the
status line carries `model · ctx N%`.

## Install

In a Claude Code terminal session:

```
/plugin install session-deck --marketplace Goodtail/session-deck
```

From a shell:

```
claude plugin install session-deck --marketplace Goodtail/session-deck
```

Answer `y` to add the marketplace, then pick a scope. The mod is active at once.
Requires Claude Code v2.1.287 or later.

## Use

- The band appears above the prompt after Claude's first response.
  **Deck** opens the pane, **Hide** removes the band.
- `/deck` opens the pane (and brings back a hidden band).
- **Refresh** in the pane re-reads git and pull requests.

## Options

Set them in the `/plugin` config menu for `session-deck`.

| Option | Default | Meaning |
| --- | --- | --- |
| `position` | `band` | `band` colored rows above the prompt, `status` one plain line under it, or `both`. |
| `showDirectory` | `true` | Show the working directory next to the branch. |
| `showPrs` | `true` | List open pull requests. |
| `warnPercent` | `80` | Context percent that raises the toast. |

## Requirements and privacy

- Pull requests need the [GitHub CLI](https://cli.github.com) (`gh`) signed in;
  without it the PR section says so and everything else still works.
- Usage limits appear only on a subscription plan; with an API key the section
  reports that none is available.
- The mod runs `git` and `gh` on your machine, read-only, and sends nothing to
  any service of its own. Like every mod it runs with your permissions: read the
  code in `hooks/register.tsx` (about 300 lines) or run
  `claude plugin validate .` to list what it calls.

## Develop

```
claude --plugin-dir .       # load it for one session
claude plugin validate .
claude plugin test .
```

## License

MIT
