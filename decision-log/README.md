# decision-log

A Claude Code mod that makes Claude's judgement calls visible while it works, so you can follow the ramifications of a task as it happens instead of finding them in the diff afterwards.

## What it does

- Gives Claude a `log_decision` tool and a system prompt section asking it to log each choice you did not spell out: picking an approach or library, resolving an ambiguity with an assumption, skipping or stubbing something, changing scope, anything costly to undo.
- Each decision lands in a **Decisions** pane: filter tabs with counts (All, To review, Approved, Rejected; it opens on To review), a one-line-per-decision table, and a detail panel for the selected row with what was chosen, why, what else was considered and the ramifications. Rows and the panel border carry a `●○○` gauge coloured by how hard the decision is to undo (green easy, yellow moderate, red hard), and a bar under the tabs fills green and red as you approve and reject. When nothing is waiting, the pane shows a session overview: your verdict counts, how hard the decisions are to undo, and the most recent ones, kept company by Claude Code's own critter, beside the stats with a word under it saying whether Claude is idle or working: while Claude works it glances about, lets a thought bubble slowly form, then decides with a tick or a cross; otherwise it sits and blinks now and then. Before the first decision it sits in the middle of the pane on its own. While Claude works, a light sweeps along the title bar. In the terminal the title bar and the critter are drawn in coloured block characters and animate only while they are on screen; the desktop app and VS Code get a text version.
- Approve or reject each one, with an optional comment. Claude does not wait for you; it keeps working and you review at your own pace.
- A rejection, or an approval with a comment, is added to the conversation straight away. Mid-turn, Claude reads it at its next step and revisits the decision. If Claude is idle, the pane offers **Ask Claude to revisit now**, or it picks the feedback up with your next message.
- A plain approval sends nothing, so it costs no tokens.
- Hard-to-undo decisions also raise a toast, and the status line shows how many are waiting.

## Using it

- The pane opens by itself on the first decision when the terminal is wide enough (fullscreen, 144+ columns). Otherwise run `/decisions`, which also gives the pane the keyboard.
- `ctrl+x tab` (or a click) gives the pane the keyboard. Then:

  | Key | Does |
  | --- | --- |
  | `n` / `p` | next / previous decision |
  | arrows | walk the tabs, rows and buttons; landing on a row shows it |
  | `a` | approve the selected decision |
  | `r` | reject it |
  | `c` | open a comment box; Enter keeps the comment |
  | `u` | undo your most recent verdict (an accidental approve or reject) |
  | `o` | reopen the selected reviewed decision, back to To review |
  | `Esc` | back to the prompt |

  The hotkeys switch off while the comment box is open, so typing never presses a button.
- After each verdict the selection moves to the next decision still waiting.
- To change your mind later, click a decision in the All, Approved or Rejected tab (or the Recent list) and use **Reopen**, **Approve instead** or **Reject instead**. If Claude was already told about the old verdict (a rejection, or an approval with a comment), it is told about the change; undoing a plain approval tells it nothing.
- `/decisions clear` (or **clear reviewed**) drops reviewed decisions from the list.
- Closing the pane stops it reopening on new decisions until you run `/decisions` again.

Decisions last for the session only.

## Install

Type this at the Claude Code prompt:

```
/plugin install decision-log --marketplace HectorBailey/claude-mods
```

Answer `y` to add the marketplace, then pick a scope (user scope loads it in every session). See the [repository README](../README.md) for updating and requirements.

## Developing

Run Claude Code with the mod loaded straight from this folder; it reloads whenever a file here changes:

```bash
claude --plugin-dir ./decision-log
```

Check and test it with:

```bash
claude plugin validate ./decision-log
claude plugin test ./decision-log
```

## Credits

The critter is a fan homage to Claude Code's mascot, drawn from the block-character logo on its welcome screen. The character belongs to Anthropic and is not covered by this repository's licence.
