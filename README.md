# pi-simple-permissions

A small [pi](https://pi.dev) extension that adds a simple permission gate:

- Files inside the current working directory can be read, written, edited, and created without prompting.
- `write` / `edit` outside the current working directory require confirmation.
- Agent bash commands are parsed with `tree-sitter-bash` and each individual command is labelled harmless or potentially harmful.
- Fully harmless bash lines are allowed automatically.
- Potentially harmful agent bash commands require confirmation, with the dialog showing which part is harmless and which part is not.
- User `!` / `!!` bash commands use the same bash risk analysis.
- Bash commands can be temporarily allowed for the current session with exact-command or regex rules.

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

### `/perm-allow <regex>`

Allow matching bash commands for the rest of the current session.

Examples:

```text
/perm-allow ^ssh\b
/perm-allow ^git\s+(status|diff|log)\b
/perm-allow ^npm\s+(test|run\s+lint)\b
```

### `/perm-allow-exact <command>`

Allow one exact bash command for the rest of the current session.

```text
/perm-allow-exact ssh myhost uptime
```

### `/perm-list`

List current session bash allow rules.

### `/perm-clear [all|number]`

Clear all rules or a single numbered rule from `/perm-list`.

```text
/perm-clear
/perm-clear all
/perm-clear 2
```

## Bash risk analysis and confirmation dialog

Bash lines are parsed with Tree-sitter, so compound lines such as `ls && rm -rf tmp` or `git status | grep foo` are analyzed command-by-command instead of as one opaque string.

Known read-only commands such as `ls`, `cat`, `grep`, `rg`, safe `find`, safe `sed`, and read-only `git` subcommands are treated as harmless unless they write through shell redirection. Unknown commands and known mutating patterns are treated as potentially harmful.

When a potentially harmful bash command is requested, the dialog shows each command part and lets you:

- Allow once
- Block
- Allow the exact command for this session
- Add a regex allow rule for this session

## Important caveats

- The policy's CWD is the directory where pi is running. If you start pi in `~/Projects`, then every project under `~/Projects` is considered inside CWD. Start pi inside a specific repo if you want narrower access.
- Pi does not currently have a separate built-in delete-file tool. Deletes usually happen through `bash` (`rm`, etc.), so they are covered by the bash risk analysis and confirmation path rather than path-specific delete analysis.
- `read`, `ls`, `grep`, and `find` are allowed anywhere by this extension. If you want read/list restrictions too, extend the policy to gate those tools.
- Other custom extensions/tools may mutate files internally and bypass this policy. Only run trusted extensions.
- Bash risk analysis is conservative, not a sandbox or proof of safety. Unknown commands are considered potentially harmful, while allow rules can bypass analysis.
- Regex allow rules are powerful. For example, `/perm-allow ^ssh\b` allows any bash command beginning with `ssh` for the session.
