# AGENTS.md

Guidance for coding agents working in this repository.

## Project overview

`pi-tool-guard` is a small pi extension that adds a convenience permission gate for agent activity:

- `write` and `edit` tool calls are allowed inside the current pi working directory.
- `write` and `edit` outside the current working directory ask the user for confirmation.
- `bash` tool calls and user `!` / `!!` shell escapes are parsed with `tree-sitter-bash` and classified command-by-command.
- Known read-only bash commands are allowed automatically.
- Unknown or potentially mutating bash commands require confirmation unless allowed by a session, directory, repo, or global allow rule, unless a deny rule matches.

This is **not** a sandbox. It is a pi extension that runs with normal user permissions.

## Important files

- `extensions/tool-guard.ts` — the extension entry point; keep this as the package-advertised extension file.
- `extensions/tool-guard/main.ts` — main extension wiring and event registration.
- `extensions/tool-guard/commands.ts` — slash command registration.
- `extensions/tool-guard/config-store.ts` — directory/repo/global rule loading and persistence.
- `extensions/tool-guard/session-rules.ts` — session rule loading and persistence.
- `extensions/tool-guard/tree-sitter.ts` — lazy `tree-sitter` / `tree-sitter-bash` loading.
- `extensions/tool-guard/bash-analysis.ts` — bash parsing and risk classification.
- `extensions/tool-guard/bash-evaluation.ts` — allow/deny evaluation for parsed bash sub-commands.
- `extensions/tool-guard/bash-confirm.ts` — bash confirmation flow orchestration.
- `extensions/tool-guard/path-policy.ts` — path canonicalization and inside/outside-CWD checks.
- `extensions/tool-guard/ui.ts` — confirmation UI.
- `extensions/tool-guard/rule-utils.ts` — shared regex/rule helpers.
- `extensions/tool-guard/constants.ts` — rule entry IDs and command classification constants.
- `extensions/tool-guard/types.ts` — shared types.
- `README.md` — user-facing documentation and command examples.
- `package.json` — package metadata and pi extension entry point.

## Local usage

Run pi with this extension from a checkout:

```bash
pi -e /path/to/pi-tool-guard
```

The package advertises the extension via:

```json
{
  "pi": {
    "extensions": ["./extensions/tool-guard.ts"]
  }
}
```

## Extension behavior to preserve

When modifying the extension, preserve these policy expectations unless explicitly asked otherwise:

1. Reads/list/searches are not gated by this extension.
2. Only `write` and `edit` tool calls are path-gated.
3. Paths are canonicalized through existing parents so symlinks cannot make outside-CWD writes look inside CWD.
4. Bash analysis is conservative: unknown commands should be treated as potentially harmful.
5. Shell redirection that writes (`>`, `>>`, `&>`, etc.) makes a command potentially harmful.
6. Session allow/deny rules are persisted as custom entries in the current pi session file, while directory/repo/global allow/deny rules may be persisted in JSON config files.
7. Deny rules override matching allow rules.
8. Non-UI sessions should block operations that require confirmation.

## User commands provided by the extension

- `/guard-allow [session|directory|repo|global] <regex>` — allow matching bash commands; scope defaults to session.
- `/guard-allow-exact [session|directory|repo|global] <command>` — allow one exact bash command; scope defaults to session.
- `/guard-deny [session|directory|repo|global] <regex>` — deny matching bash commands; scope defaults to session.
- `/guard-deny-exact [session|directory|repo|global] <command>` — deny one exact bash command; scope defaults to session.
- `/guard-list [all|session|directory|repo|global]` — list current bash rules.
- `/guard-clear [session|directory|repo|global] [all|allow|deny|number] [all|number]` — clear rules; scope defaults to session.

## Development notes

- The project is ESM (`"type": "module"`).
- Runtime dependencies are `tree-sitter` and `tree-sitter-bash`.
- There are currently no npm test/lint scripts in `package.json`; do not invent them in documentation unless adding them.
- Keep README behavior descriptions in sync with the implementation under `extensions/tool-guard/`.
- Keep the extension entry point in `extensions/tool-guard.ts` pointing at the main implementation under `extensions/tool-guard/main.ts`.
- Prefer responsibility-based modules under `extensions/tool-guard/` instead of growing `extensions/tool-guard.ts` again.
- Be careful when changing bash parsing logic: compound commands should still be analyzed per simple command where possible.
