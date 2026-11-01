# tailored

[Claude Code mods](https://code.claude.com/docs/en/plugins/mods/overview) by Goodtail.
Add this repository once as a marketplace, then install only the mods you want.

```
/plugin marketplace add Goodtail/tailored
/plugin install session-deck@tailored
/plugin install rule-guard@tailored
```

Or in one line each, from a Claude Code session:

```
/plugin install session-deck --marketplace Goodtail/tailored
/plugin install rule-guard --marketplace Goodtail/tailored
```

| Mod | What it does |
| --- | --- |
| [session-deck](plugins/session-deck) | A live deck above the prompt and in a `/deck` pane: model, context, usage limits, prompt-cache countdown, git branch and worktree, pull requests, todos and what each message cost in tokens. |
| [rule-guard](plugins/rule-guard) | Enforces your rules on Bash commands in code: no AI attribution in commits, a question before destructive commands, and block patterns you choose, optionally only under certain folders. |

A mod runs with your permissions. Read its code, or run `claude plugin validate plugins/<mod>`
to list what it calls, before you install it.

## Adding a mod

Put it in `plugins/<name>/` with its own `.claude-plugin/plugin.json`, add an entry to
`.claude-plugin/marketplace.json`, and keep a `README.md` beside it.

## License

MIT
