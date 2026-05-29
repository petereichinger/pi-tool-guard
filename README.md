# pi-simple-permissions

A small [pi](https://pi.dev) extension that adds a simple permission gate:

- Files inside the current working directory can be read, written, edited, and created without prompting.
- `write` / `edit` outside the current working directory require confirmation.
- Agent bash commands are parsed with `tree-sitter-bash` and each individual command is labelled harmless or potentially harmful.
- Fully harmless bash lines are allowed automatically.
- Potentially harmful agent bash commands require confirmation, with the dialog showing which part is harmless and which part is not.
- User `!` / `!!` bash commands use the same bash risk analysis.
- Bash commands can be allowed or denied with regex rules at three levels: global config, directory config, and current session.

> This is a convenience guard, not a security sandbox. Pi extensions run with your full user permissions. For hard isolation, use OS permissions, containers, VMs, or sandboxing.

## Install

After this repo is pushed to GitHub:

```bash
pi install git:github.com/petereichinger/pi-simple-permissions
```

Or try it once without installing:

```bash
pi -e git:github.com/petereichinger/pi-simple-permissions
```

## Local development

```bash
pi -e /path/to/pi-simple-permissions
```

## Commands

### Allow and deny rules

Rules default to session scope. Session rules are stored in the current pi session log, so they survive `/reload` and quitting/resuming that session, but they do not become project-wide or global defaults. Pass `directory` or `global` as the first argument to persist a rule outside the session.

```text
/perm-allow [session|directory|global] <regex>
/perm-allow-exact [session|directory|global] <command>
/perm-deny [session|directory|global] <regex>
/perm-deny-exact [session|directory|global] <command>
```

If the scope is omitted, it defaults to `session`.

Examples:

```text
/perm-allow ^ssh\b
/perm-allow ^git\s+(status|diff|log)\b
/perm-allow-exact ssh myhost uptime
/perm-deny ^sudo\b
/perm-allow directory ^npm\s+test$
/perm-deny global ^sudo\b
```

### Persistent session, directory, and global rules

Session rules are saved as custom entries in the current pi session file. Directory rules are saved in `.pi/simple-permissions.json` under the current pi working directory. Global rules are saved in `$XDG_CONFIG_HOME/pi-simple-permissions/config.json`, or `~/.config/pi-simple-permissions/config.json` when `XDG_CONFIG_HOME` is not set.

Use the optional scope argument to persist rules:

```text
/perm-allow directory <regex>
/perm-allow-exact directory <command>
/perm-deny global <regex>
/perm-deny-exact global <command>
```

The bash confirmation dialog can also save allow rules for the current directory.

### Listing and clearing rules

```text
/perm-list [all|session|directory|global]
/perm-clear [session|directory|global] [all|allow|deny|number] [all|number]
```

For backwards compatibility, `/perm-clear 2` removes session allow rule #2. Persistent rules are cleared with commands such as `/perm-clear directory allow 2` or `/perm-clear global deny all`.

## Persistent config format

Both persistent config files use the same JSON shape. Rules can be plain regex strings or objects with a `source` regex and optional `description`; exact-command commands store anchored escaped regexes.

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
  }
}
```

Deny rules win over allow rules. For allows, more-specific scopes are checked before broader scopes: session, directory, then global.

## Bash risk analysis and confirmation dialog

Bash lines are parsed with Tree-sitter, so compound lines such as `ls && rm -rf tmp` or `git status | grep foo` are analyzed command-by-command instead of as one opaque string.

Known read-only commands such as `ls`, `cat`, `grep`, `rg`, safe `find`, safe `sed`, and read-only `git` subcommands are treated as harmless unless they write through shell redirection. Unknown commands and known mutating patterns are treated as potentially harmful.

When a potentially harmful bash command is requested, the dialog shows the full command without truncation, shows each command part, and separates parser errors with a divider instead of folding them into the command list. It lets you:

- Allow once
- Block
- Allow the exact command for this session
- Allow the exact command for this directory
- Add a regex allow rule for this session
- Add a regex allow rule for this directory

## Important caveats

- The policy's CWD is the directory where pi is running. If you start pi in `~/Projects`, then every project under `~/Projects` is considered inside CWD. Start pi inside a specific repo if you want narrower access.
- Pi does not currently have a separate built-in delete-file tool. Deletes usually happen through `bash` (`rm`, etc.), so they are covered by the bash risk analysis and confirmation path rather than path-specific delete analysis.
- `read`, `ls`, `grep`, and `find` are allowed anywhere by this extension. If you want read/list restrictions too, extend the policy to gate those tools.
- Other custom extensions/tools may mutate files internally and bypass this policy. Only run trusted extensions.
- Bash risk analysis is conservative, not a sandbox or proof of safety. Unknown commands are considered potentially harmful, while allow rules can bypass analysis.
- Regex allow rules are powerful. For example, `/perm-allow ^ssh\b` allows any bash command beginning with `ssh` for the current pi session, including after `/reload` or resuming that session.
- Directory/global persistent rules are normal JSON files. Review them before sharing a project, especially directory rules under `.pi/`. Session rules live in the pi session file.
- Deny rules are hard blocks and override matching allow rules at any scope.
