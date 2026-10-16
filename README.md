# claude-mods

A monorepo for Claude Code mods: plugins built on Claude Code's function-hooks API, published together as one plugin marketplace. New mods are added here as folders under `plugins/`.

notes-compaction and shepherdr are Claude Code ports of Pi extensions by [howaboua](https://github.com/IgorWarzocha): [pi-notes-compaction](https://github.com/IgorWarzocha/howaboua-pi-stuff/tree/main/packages/pi-notes-compaction) and [pi-shepherdr](https://github.com/IgorWarzocha/howaboua-pi-stuff/tree/main/packages/pi-shepherdr) from the [howaboua-pi-stuff](https://github.com/IgorWarzocha/howaboua-pi-stuff) monorepo. The ideas and designs are theirs; this repo adapts them to Claude Code's function-hooks API.

| Mod | What it does |
| --- | --- |
| [notes-compaction](plugins/notes-compaction) | Checkpoint notes and fresh context windows that continue from them |
| [shepherdr](plugins/shepherdr) | Spawn, delegate to and monitor Pi agents in Herdr, with results pushed back into the session |
| [review-pane](plugins/review-pane) | Review the working diff in Neovim beside Claude Code, or the last response in a pane: annotate lines, ask questions inline and prepare a follow-up prompt |

## Install

At the Claude Code prompt:

```
/plugin install <mod> --marketplace ramtinJ95/claude-mods
```

Answer `y` to add the marketplace and choose the user scope to load the mod in every session.

## Develop

Run a mod from its folder; edits reload between turns:

```
claude --plugin-dir plugins/<mod>
```

Check it with `claude plugin validate plugins/<mod>`, and the marketplace with `claude plugin validate .`.

To add a mod, create `plugins/<mod>/` and list it in `.claude-plugin/marketplace.json` and the table above. Changes reach `main` through pull requests only. [AGENTS.md](AGENTS.md) holds the conventions agents follow when working here.
