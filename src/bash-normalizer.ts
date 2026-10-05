/**
 * Bash shell normalization.
 *
 * Strips shell scaffolding from a command segment so that only the
 * "real" command remains for rule matching. This is the single source
 * of truth for what counts as bash syntax vs. a meaningful command.
 *
 * Shell scaffolding stripped (in order):
 *  1. Leading env-var assignments  — `VAR=val cmd args`     → `cmd args`
 *  2. Pipeline negation            — `! cmd args`           → `cmd args`
 *  3. Compound-command keywords    — `if cmd` / `do cmd`    → `cmd`
 *     (if, elif, while, until, do, then, else)
 *  4. xargs wrapper               — `xargs -0 cmd args`    → `cmd args`
 *     (strips xargs and all its flags)
 *
 * Shell setup segments (no meaningful command to evaluate):
 *  - cd <path>
 *  - set [-+]..., export ..., source/. ...
 *  - bare builtins: true, false, echo (no args)
 *  - control-flow: fi, done, esac, do, then, else (bare)
 *  - loop/branch headers: for VAR in ..., case WORD in ...
 *  - conditionals: [ ... ], [[ ... ]]
 *  - no-op: : (colon)
 *  - bare variable assignments: VAR=val
 */

// ---------------------------------------------------------------------------
// Shell syntax stripping (extract the real command from scaffolding)
// ---------------------------------------------------------------------------

/**
 * Strip leading VAR=value prefixes from a command.
 * `KUBECONFIG=/dev/null GOFLAGS=-race make test` → `make test`
 *
 * Returns the original command if it's ALL assignments (no command follows).
 */
export function stripEnvVarPrefixes(command: string): string {
  const parts = command.trim().split(/\s+/);
  let i = 0;
  while (i < parts.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(parts[i])) {
    i++;
  }
  if (i === 0 || i === parts.length) return command;
  return parts.slice(i).join(" ");
}

/** Strip a leading `!` (pipeline negation — inverts exit code). */
export function stripNegation(command: string): string {
  const trimmed = command.trimStart();
  if (trimmed.startsWith("! ")) return trimmed.slice(2).trimStart();
  return command;
}

/**
 * Strip compound-command keyword prefixes.
 * `if [ -d "$dir" ]` → `[ -d "$dir" ]`
 * `do grep -q foo bar` → `grep -q foo bar`
 *
 * These keywords precede a command but aren't commands themselves.
 * The word-boundary `\b` ensures we don't match command names that
 * happen to start with a keyword (e.g., `ifeq`).
 */
export function stripKeywordPrefix(command: string): string {
  const trimmed = command.trimStart();
  const match = trimmed.match(/^(if|elif|while|until|do|then|else)\b\s+(.+)$/);
  if (match) return match[2].trimStart();
  return command;
}

/**
 * Strip a leading `xargs` wrapper, leaving just the command it runs.
 * `xargs -0 grep -H foo` → `grep -H foo`
 * `xargs -I{} -n1 stat {}` → `stat {}`
 *
 * Handles common xargs flags: -0, -n, -P, -I, -d, -L, -s, etc.
 */
export function stripXargs(command: string): string {
  const trimmed = command.trimStart();
  if (!trimmed.startsWith("xargs ") && trimmed !== "xargs") return command;

  const parts = trimmed.split(/\s+/);
  let i = 1; // skip "xargs"

  const flagsWithArg = new Set([
    "-I", "-d", "-n", "-P", "-L", "-s",
    "--delimiter", "--max-args", "--max-procs",
    "--max-lines", "--max-chars", "--replace",
  ]);
  const standaloneFlags = new Set([
    "-0", "--null", "-r", "--no-run-if-empty",
    "-t", "--verbose", "-p", "--interactive",
    "--process-slot-var",
  ]);

  while (i < parts.length) {
    const token = parts[i];
    if (standaloneFlags.has(token)) {
      i++;
    } else if (flagsWithArg.has(token)) {
      i += 2;
    } else if (token.startsWith("-I") && token.length > 2) {
      i++; // -I{} style (delimiter attached)
    } else {
      break; // actual command starts here
    }
  }

  if (i >= parts.length) return command; // bare xargs with no command
  return parts.slice(i).join(" ");
}

/**
 * Apply all bash shell stripping in order.
 * Returns the "real" command with all scaffolding removed.
 */
export function stripBashScaffolding(command: string): string {
  return stripXargs(stripKeywordPrefix(stripNegation(stripEnvVarPrefixes(command.trim()))));
}

// ---------------------------------------------------------------------------
// Shell setup segment detection
// ---------------------------------------------------------------------------

/** Test whether a segment is a simple `cd <literal-path>`. */
function isCdSegment(segment: string): boolean {
  return /^\s*cd\s+(?:'[^']*'|[^\s"'`$\\;&|<>()\[\]{}*?]+)\s*$/.test(segment);
}

/**
 * Test whether a segment is shell scaffolding that doesn't need its own
 * allow rule when it appears inside a command chain.
 *
 * Returns true for:
 *  - cd <path>, set -o ..., export VAR=..., source file
 *  - bare builtins: true, false, echo
 *  - control-flow keywords: fi, done, esac, do, then, else
 *  - loop/branch headers: for VAR in ..., case WORD in ...
 *  - conditionals: [ ... ], [[ ... ]]
 *  - no-op: :
 *  - bare variable assignments: VAR=val
 */
export function isShellSetupSegment(segment: string): boolean {
  const trimmed = segment.trim();
  if (isCdSegment(trimmed)) return true;
  // set -o pipefail, set -e, set -x, etc.
  if (/^\s*set\s+[-+]/.test(trimmed)) return true;
  // export VAR=val, export -f
  if (/^\s*export\s+/.test(trimmed)) return true;
  // source / . (source a file)
  if (/^\s*(source|\.)\s+/.test(trimmed)) return true;
  // builtins that are no-ops or context
  if (/^\s*(true|false|echo)\s*$/.test(trimmed)) return true;
  // control-flow keywords (bare, no trailing command)
  if (/^\s*(fi|done|esac|do|then|else)\s*$/.test(trimmed)) return true;
  // for VAR in ... / for (( ... )) — loop header
  if (/^\s*for\s+/.test(trimmed)) return true;
  // case WORD in — pattern match header
  if (/^\s*case\s+/.test(trimmed)) return true;
  // [[ ... ]] — bash conditional expression
  if (/^\s*\[\[\s+/.test(trimmed)) return true;
  // [ ... ] — test builtin (pure conditional)
  if (/^\s*\[\s+/.test(trimmed)) return true;
  // : (no-op, can take args which are ignored)
  if (/^\s*:\s*/.test(trimmed)) return true;
  // Bare env var assignment(s): VAR=val VAR2=val2
  if (/^\s*([A-Za-z_][A-Za-z0-9_]*=\S+\s*)+$/.test(trimmed)) return true;
  return false;
}
