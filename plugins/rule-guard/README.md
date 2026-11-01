# rule-guard

A Claude Code mod that enforces your rules on Bash commands in code, instead of
asking the model nicely in `CLAUDE.md`. A rule in a prompt is followed most of
the time; a rule here is checked on every command before it runs, with plain
pattern matching and no model call.

## What it guards

| Guard | Default | What it does |
| --- | :-: | --- |
| AI attribution | on | Refuses `git commit`, `git tag`, `gh pr`, `gh issue` and `gh release` commands whose text has a `Co-Authored-By: Claude` trailer or a `Generated with Claude Code` footer. Claude is told to remove the line and run the command again. |
| Destructive commands | on | Asks you first before `rm -rf` on a broad target, `git push --force`, `git reset --hard`, `git clean -f`, `DROP TABLE/DATABASE` and `chmod -R 777`. With nobody to ask (`claude -p`), the command is refused. |
| Your own pattern | off | Refuses commands that match a regular expression you give, optionally only when the session's folder path contains a fragment you name (for example only inside a company repository). |

## Install

In a Claude Code terminal session:

```
/plugin install rule-guard --marketplace Goodtail/tailored
```

Then set the options in `/plugin configure rule-guard@goodtail-mods`.

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `blockAiAttribution` | `true` | The AI attribution guard. |
| `confirmDestructive` | `true` | Ask before destructive commands. |
| `customDenyPattern` | empty | A regular expression; a matching command is refused. Example: `9VP73Q9QX3`. |
| `customDenyScope` | empty | Comma-separated path fragments (`/company/`, a project name). The custom pattern applies only when the session's folder contains one. Empty means everywhere. |
| `customDenyMessage` | a default | What Claude is told when the custom pattern blocks a command. |

## Limits

- It reads the command text only. A commit message kept in a file
  (`git commit -F message.txt`) is not read, so the file's content is not checked.
- Pattern matching can be got around by a command written another way. Treat it
  as a seatbelt, not a sandbox.
- Like every mod it runs with your permissions. The code is one short file,
  `hooks/register.ts`; `claude plugin validate .` lists what it calls.

## Develop

```
claude --plugin-dir .
claude plugin validate .
claude plugin test .
```

## License

MIT
