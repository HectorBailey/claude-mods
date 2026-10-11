# claude-mods

Mods for [Claude Code](https://claude.com/claude-code) by Hector Bailey. A mod changes Claude Code's own interface or behaviour: a side pane, a slash command, a tool Claude can call.

| Mod | What it does |
| --- | --- |
| [decision-log](decision-log/) | Claude logs its judgement calls as it works; approve or reject each one, with a comment, from a side pane. Rejections go straight back to Claude so it revisits them. |

## Install

Type this at the Claude Code prompt, swapping in the mod you want:

```
/plugin install decision-log --marketplace HectorBailey/claude-mods
```

Answer `y` to add the `hectorbailey` marketplace, then choose a scope. User scope loads the mod in every session from then on. The mod is active straight away, with no restart.

## Updating

When a mod here changes, pull the new version and reload:

```bash
claude plugin update decision-log@hectorbailey
```

then run `/reload-plugins` in any open session.

## Requirements

A recent Claude Code (run `claude update`). Mods use Claude Code's function hooks, which are early access: a Claude Code release can change the API, so a mod here may need an update after one.

## Licence

MIT, see [LICENSE](LICENSE).
