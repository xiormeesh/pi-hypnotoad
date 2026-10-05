# 🐸 Hypnotoad

**ALL GLORY TO THE HYPNOTOAD.**

A [pi](https://pi.dev) extension that gates every tool call (bash, read, write, edit) through configurable allow/deny/ask rules with glob patterns. Commands that please the Hypnotoad pass silently. Commands that don't must face judgment.

When a tool call doesn't match any rule, the extension prompts with four choices: always allow, allow once, deny once, always deny. "Always" decisions are persisted to `permissions.yml` so they carry across sessions.

Zero npm dependencies.

## Install

```bash
pi install git:github.com/xiormeesh/pi-hypnotoad
```

Or load from a local checkout:

```bash
pi --extension ./path/to/pi-hypnotoad
```

On first run, if no permissions file exists, the extension creates `~/.pi/agent/permissions.yml` from `defaults.yml` with sensible starter rules. Customize it for your project — the file is well-commented with groups to uncomment.

## Rule format

Rules follow the pattern `Tool(pattern)`:

```
Bash(git checkout *)      — matches bash commands
Read(path:wiki/**)        — matches file reads
Write(path:wiki/**)       — matches file writes
Edit(path:wiki/**)        — matches file edits
Modify(path:wiki/**)      — matches both writes and edits
```

### Globs

- `*` matches any characters within a single segment
- `**` matches across path separators (for file paths)
- A trailing ` *` is optional, so `Bash(sort *)` also matches bare `sort`
- `~` expands to the user's home directory in file paths

### Brace expansion

Rules support `{a,b,c}` brace expansion for compact grouping:

```yaml
# One rule instead of fourteen
- "Bash(git {blame,branch,describe,diff,fetch,log,ls-files,ls-tree,remote,rev-parse,shortlog,show,tag} *)"

# Group related deny patterns
- "Bash({chmod,chown} {777,000} *)"

# Modify = Write + Edit
- "Modify(path:{src,wiki}/**)"
```

Each alternative inside braces is matched independently. Use braces when rules share a common prefix.

### Priority

**deny → ask → allow → dev mode → prompt user**

- **Deny**: checked first — blocks immediately, no prompt
- **Ask**: prompts for approval. However, if a bash segment also matches a specific **allow** rule, the allow wins (specific allow overrides broad ask)
- **Allow**: passes silently
- **Dev mode**: auto-approves safe dev commands when active (see below)
- **No match**: prompts with 4 choices

### Shell syntax

Shell builtins and syntax constructs (`:`, `[`, `true`, `false`, bare `echo`, `cd`, env var assignments) are auto-allowed without needing explicit rules.

## Permissions file

YAML format with `#` comments for documenting rule intent. JSON is also supported for backward compatibility.

```yaml
allow:
  # All file reads (deny/ask rules override for sensitive paths)
  - "Read(path:**)"

  # Git read-only
  - "Bash(git {status,diff,log} *)"

deny:
  - "Bash(rm {-r,-rf,--recursive} *)"
  - "Bash(sudo *)"
  - "Modify(path:**/.ssh/**)"

ask:
  - "Bash(git {commit,push} *)"

systemPrompt: |
  ## Bash restrictions
  ...
```

The optional `systemPrompt` field injects text into the model's system prompt, telling it which commands are blocked so it doesn't attempt them.

### File locations

The extension looks for permissions in this order:

1. `.pi/permissions.yml` in the project directory (project-level)
2. `~/.pi/agent/permissions.yml` (user-level, created from defaults on first run)

Rules are saved to whichever file was loaded. Use `/hypnotoad` to see the active path.

### Comment preservation

YAML comments are preserved when rules are added interactively ("Always allow/deny"). New rules are inserted near existing rules with the same command prefix (e.g., a new `git` rule goes next to other `git` rules). Doctor operations rewrite the file from scratch.

## Bash command handling

### Chained commands

Commands joined by `|`, `||`, `&&`, `;`, or `&` are split into segments. Each segment is matched independently:

- **Allow**: all segments must match
- **Deny**: any segment matching a deny rule blocks the whole command
- **Ask**: any segment matching an ask rule triggers the prompt

The parser handles `$()` command substitutions, backtick substitutions, `<()`/`>()` process substitutions, `()` subshells, and quoted strings — operators inside these constructs are not treated as chain separators.

### File redirect detection

Commands that write to files via shell redirects (`>`, `>>`) are not auto-approved even if the base command is allowed. `echo *` in allow won't silently pass `echo secret > file.txt`.

### Command normalization

Global flags before the subcommand are stripped before matching:

| Tool | Stripped flags |
|---|---|
| `git` | `-C`, `-c`, `--git-dir`, `--work-tree`, `--namespace`, `--bare`, `--no-pager` |
| `kubectl` / `oc` | `-n`, `--namespace`, `--context`, `--cluster`, `--kubeconfig`, `-s`, `--server` |
| `docker` | `-H`, `--host`, `--context`, `--config`, `-l`, `--log-level`, `-D`, `--debug` |

Both `--flag value` and `--flag=value` forms are handled.

### Pattern suggestion

When you choose "Always allow" or "Always deny", a pattern is suggested:

- Tools with subcommands (git, docker, kubectl, npm, cargo, etc.): `tool subcommand *`
- Other commands: `tool *`

You can edit the suggested pattern before saving.

## Dev mode

Toggle with `/devmode [path]`. Auto-approves:

- Build/test commands (make, go test, npm test, pytest, cargo test, etc.)
- File operations (mkdir, cp, mv, touch, etc.)
- Formatters and linters
- Read-only git operations (add, stash, diff, log, status)
- Docker/kubectl read operations

**Always prompts even in dev mode**: git commit, push, rebase, merge, reset, cherry-pick, revert.

## Commands

| Command | Description |
|---|---|
| `/hypnotoad` | Show active rules and config file path |
| `/hypnotoad reload` | Reload rules from disk |
| `/hypnotoad sort` | Sort rules (Read → Write → Edit → Modify → Bash, then alphabetical) |
| `/hypnotoad doctor` | Analyze rules: structural issues, shadowed allows, dead paths, redundant rules, consolidation candidates |
| `/hypnotoad devmode [path]` | Toggle dev mode for unattended file edits & safe dev commands |

## Customization

### Adding rules

Two ways:

1. **Interactive**: use pi normally — when prompted, choose "Always allow/deny" and confirm or edit the pattern
2. **Manual**: edit `permissions.yml` directly, then `/hypnotoad reload`

### Project-level overrides

Create `.pi/permissions.yml` in your project root. The extension uses it instead of the user-level file when present.

## Architecture

```
index.ts               — entry point: event handlers, commands, prompt UI
src/
  parser.ts            — bash command splitting with nesting support
  matcher.ts           — glob/brace expansion, rule parsing, segment matching
  normalizer.ts        — command normalization (stripping global flags)
  suggest.ts           — pattern suggestion for interactive decisions
  permissions.ts       — file loading, saving, path resolution (YAML + JSON)
  yaml.ts              — YAML parser/serializer with comment-preserving merge
  devmode.ts           — dev mode auto-approval logic
  prompt.ts            — approval prompt formatting
  types.ts             — shared interfaces
  doctor/
    index.ts           — runDoctor orchestration + re-exports
    checks.ts          — structural analysis checks
    fixes.ts           — applyFixes + sortRules
    rules.ts           — structural dangerous-pattern definitions
    types.ts           — Finding, Severity types
defaults.yml           — starter rules with comments, copied on first run
```

## Security model

This extension is a **convenience gate for interactive use**, not a security sandbox. It catches intent-level mistakes (wrong git remote, accidental overwrites, destructive commands) that OS-level isolation can't distinguish.

For real isolation against a hostile agent or unattended CI, use containers, VMs, or bwrap. This extension complements sandboxing — even users with OS-level isolation add a permission gate on top for intent-level checks.

The extension **fails closed**: when parsing produces garbage (e.g., an unhandled shell construct), segments won't match allow rules and will fall through to the interactive prompt.
