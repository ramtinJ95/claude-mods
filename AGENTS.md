This repo is the monorepo for all Claude Code mods: function-hooks plugins published together as one plugin marketplace. Every new mod lives here.

## Layout

- `plugins/<mod>/` holds one mod: `.claude-plugin/plugin.json`, `hooks/hooks.json` naming one hooks module, the module and its pure helpers, a `README.md`, and an `AGENTS.md` for that mod's editing hazards.
- `.claude-plugin/marketplace.json` lists every mod with `source: "./plugins/<mod>"`. Add a mod there and to the table in `README.md` in the same change.
- Claude Code writes `.claude-plugin/types/` and `tsconfig.json` into a mod folder it loads. They are gitignored; never commit them.

## Building a mod

- The API is early access and moves between releases. The declaration file Claude Code writes beside a loaded mod (`.claude-plugin/types/claude-code/index.d.ts`) is the authority; grep it for the event or `$` call at hand instead of guessing.
- `claude plugin validate plugins/<mod>` must pass, and `claude plugin validate .` for the marketplace. The validator follows `$` only into functions declared at the top level of the hooks module, never across imports: keep every function that takes `$` there and keep imported modules pure. `tool.call` matchers must be string literals.
- Agent-facing text is behavior. Keep tool descriptions, schemas and injected prompts compact and stable; static system-prompt text keeps the prompt cache warm.
- Mods must work for any user. No personal paths, names or machine assumptions. Keep persistent data outside `~/.claude`, which may be a synced dotfiles directory.
- Make failures explicit: a hook that cannot do its job says so (`deny`, `skip`, a toast) instead of silently falling back.

## Verifying

- Test live: `claude --plugin-dir plugins/<mod>` in a scratch directory, ideally a separate instance so compaction or prompts the mod triggers never touch the working session. Edits reload between turns.
- Keep permanent tests to a minimum. Use disposable probes and temporary edits (for example lowered thresholds) during the change, then revert them. Record non-obvious engine behavior in the mod's `AGENTS.md`, not in a test suite.

## Releasing

- `main` is protected: every change goes through a pull request, and merged branches are deleted. Never push to `main` directly.
- Use small conventional commits scoped to the mod (`feat(notes-compaction): ...`).
- Bump `version` in the mod's `plugin.json` for any change to its behavior; installed users pick it up when the marketplace refreshes.
