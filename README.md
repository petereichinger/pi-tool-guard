# pi-tool-guard

A small [pi](https://pi.dev) extension that adds a tool guard:

- Files inside the current working directory can be read, written, edited, and created without prompting.
- `write` / `edit` outside the current working directory require confirmation unless they are under a scoped write-directory allow rule.
- Agent bash tool calls are parsed with `tree-sitter-bash` and each individual command is labelled harmless or potentially harmful.
- Bash allow/deny rules apply to each parsed sub-command, not to the full bash line as one string.
- Fully harmless agent bash lines are allowed automatically unless a deny rule matches one of their parsed sub-commands.
- Potentially harmful sub-commands require confirmation, with the dialog showing which parts are harmless, already allowed, or still need approval.
- User-entered `!` / `!!` bash commands are not intercepted by this extension.
- Agent bash tool calls can be allowed or denied with regex rules at four levels: global config, repo config, directory config, and current session.
- Write confirmations can allow the current operation once or add a scoped write-directory rule for the target file's folder or a custom path.

> This is a convenience guard, not a security sandbox. Pi extensions run with your full user permissions. For hard isolation, use OS permissions, containers, VMs, or sandboxing.

## Install

After this repo is pushed to GitHub:

```bash
pi install git:github.com/petereichinger/pi-tool-guard
```

Or try it once without installing:

```bash
pi -e git:github.com/petereichinger/pi-tool-guard
```

## Local development

```bash
pi -e /path/to/pi-tool-guard
```

This extension depends on `tree-sitter` and `tree-sitter-bash`. In plain Node.js, normal package resolution is usually enough. In pi's compiled runtime, bare package resolution for extension dependencies can fail even when the packages are installed. The extension therefore falls back to direct `node_modules` entry paths for those parser packages.

## Commands

### Allow and deny rules

Rules default to session scope. Rules are matched against each parsed bash sub-command, not the whole compound line. Operators such as `&&`, `||`, and `|` are only display context in the dialog; exact and regex rules match the underlying sub-command text itself. Session rules are stored in the current pi session log, so they survive `/reload` and quitting/resuming that session, but they do not become project-wide or global defaults. Pass `directory`, `repo`, or `global` as the first argument to persist a rule outside the session.

```text
/guard-allow [session|directory|repo|global] <regex>
/guard-allow-exact [session|directory|repo|global] <command>
/guard-deny [session|directory|repo|global] <regex>
/guard-deny-exact [session|directory|repo|global] <command>
```

If the scope is omitted, it defaults to `session`.

Examples:

```text
/guard-allow ^ssh\b
/guard-allow ^git\s+(status|diff|log)\b
/guard-allow-exact ssh myhost uptime
/guard-deny ^sudo\b
/guard-allow directory ^npm\s+test$
/guard-allow repo ^git\s+push\b
/guard-deny global ^sudo\b
```

### Persistent session, directory, repo, and global rules

Session bash rules and session write-directory allows are saved as custom entries in the current pi session file. Directory-scoped rules are saved in `.pi/tool-guard.json` under the current pi working directory. Repo-scoped rules are saved in the Git common dir as `pi-tool-guard.json`, which means they are shared by all worktrees of the same repository. In the main worktree that is usually `.git/pi-tool-guard.json`. Global rules are saved in `~/.pi/agent/extensions/tool-guard.json`, or under the directory pointed to by `PI_CODING_AGENT_DIR` when that environment variable is set. For compatibility, older `simple-permissions` config/session entries are still read.

Use the optional scope argument to persist rules:

```text
/guard-allow directory <regex>
/guard-allow-exact directory <command>
/guard-allow repo <regex>
/guard-allow-exact repo <command>
/guard-deny global <regex>
/guard-deny-exact global <command>
```

If you are not inside a Git repository, repo scope is unavailable.

The bash confirmation dialog can also save allow rules for each dangerous sub-command at any available scope: session, directory, repo, or global.

### Listing and clearing rules

```text
/guard-list [all|session|directory|repo|global]
/guard-clear [session|directory|repo|global] [all|allow|deny|write|number] [all|number]
```

For backwards compatibility, `/guard-clear 2` removes session allow rule #2. Write-directory allows are cleared with `/guard-clear session write all`, `/guard-clear session write 1`, `/guard-clear directory write all`, or `/guard-clear global write 1`. Persistent bash rules are cleared with commands such as `/guard-clear directory allow 2`, `/guard-clear repo allow all`, or `/guard-clear global deny all`.

## Persistent config format

Persistent config files use the same JSON shape. Bash rules can be plain regex strings or objects with a `source` regex and optional `description`; exact-command commands store anchored escaped regexes. Each bash rule is matched against an individual parsed bash sub-command. Write-directory rules can be plain path strings or objects with a `path` and optional `description`.

```json
{
  "version": 1,
  "bash": {
    "allow": [
      { "source": "^npm\\s+test$", "description": "Project test command" }
    ],
    "deny": [
      { "source": "^sudo\\b", "description": "Never allow sudo here" }
    ]
  },
  "write": {
    "allowDirectories": [
      { "path": "/tmp/my-agent-output", "description": "Scratch output" }
    ]
  }
}
```

Bash deny rules win over allow rules. For bash allows, more-specific scopes are checked before broader scopes: session, directory, repo, then global. Matching happens per parsed sub-command. Write-directory allows apply to writes at or under the configured path.

## Write confirmation dialog

When a write/edit outside the current working directory is requested, the dialog uses a two-stage flow:

- Stage 1: `Allow once`, `Deny`, or `Add rule`
- `Add rule` switches into rule-saving mode
- In that mode you choose scope (`session`, `directory`, `repo`, or `global`) and folder-vs-custom path, then save
- `Folder of this file` allows the target file's containing folder
- `Custom path` prompts for a path and only saves it if it contains the requested target

## Bash risk analysis and confirmation dialog

Agent bash tool calls are parsed with Tree-sitter, so compound lines such as `ls && rm -rf tmp` or `git status | grep foo` are analyzed command-by-command instead of as one opaque string.

Known read-only commands such as `ls`, `cat`, `grep`, `rg`, safe `find`, safe `sed`, and read-only `git` subcommands are treated as harmless unless they write through shell redirection. Unknown commands and known mutating patterns are treated as potentially harmful.

When a potentially harmful agent bash tool call is requested, the dialog shows each analyzed command part and separates parser errors with a divider instead of folding them into the command list. Rule saving happens per dangerous parsed sub-command: if some dangerous parts are already allowed by rules, only the remaining dangerous parts are prompted for. For each prompted sub-command, the dialog uses a two-stage flow:

- Stage 1: `Allow once`, `Deny`, or `Save allow rule`
- `Allow once` approves the whole bash command once
- `Save allow rule` switches into per-sub-command rule-saving mode, highlighting one dangerous sub-command at a time
- In that mode you choose scope (`session`, `directory`, `repo`, or `global`) and exact-vs-regex for the highlighted sub-command, then continue to the next remaining dangerous sub-command
- If you choose regex, it then prompts for the regex text

## Important caveats

- The policy's CWD is the directory where pi is running. If you start pi in `~/Projects`, then every project under `~/Projects` is considered inside CWD. Start pi inside a specific repo if you want narrower access.
- Pi does not currently have a separate built-in delete-file tool. Agent deletes usually happen through the `bash` tool (`rm`, etc.), so they are covered by the bash risk analysis and confirmation path rather than path-specific delete analysis. Manually entered `!` / `!!` shell escapes are treated as direct user intent and are not gated by this extension.
- `read`, `ls`, `grep`, and `find` are allowed anywhere by this extension. If you want read/list restrictions too, extend the policy to gate those tools.
- Other custom extensions/tools may mutate files internally and bypass this policy. Only run trusted extensions.
- Bash risk analysis is conservative, not a sandbox or proof of safety. Unknown commands are considered potentially harmful, while allow rules can bypass analysis.
- Regex allow rules are powerful. For example, `/guard-allow ^ssh\b` allows any parsed bash sub-command beginning with `ssh` for the current pi session, including inside compound lines and after `/reload` or resuming that session.
- Directory/repo/global persistent rules are normal JSON files. Review them before sharing a project, especially directory rules under `.pi/` and repo rules under the shared Git metadata directory. Session rules live in the pi session file.
- Deny rules are hard blocks and override matching allow rules at any scope.
