/**
 * Command normalization.
 *
 * Strips global flags that appear before the subcommand so that
 * "git -C /some/path fetch --all" normalizes to "git fetch --all"
 * and matches the rule Bash(git fetch *).
 */

interface NormalizeSpec {
  /** Flags that consume the next token as their argument. */
  flagsWithArg: string[];
  /** Flags that are standalone (no argument). */
  standaloneFlags: string[];
  /** Flags in --key=value form (matched by prefix). */
  equalsFlags: string[];
}

const normalizeSpecs: Record<string, NormalizeSpec> = {
  git: {
    flagsWithArg: ["-C", "-c", "--git-dir", "--work-tree", "--namespace"],
    standaloneFlags: [
      "--bare", "--no-pager", "--no-replace-objects",
      "--literal-pathspecs", "--glob-pathspecs", "--no-glob-pathspecs",
    ],
    equalsFlags: ["--git-dir=", "--work-tree=", "--namespace="],
  },
  kubectl: {
    flagsWithArg: ["-n", "--namespace", "--context", "--cluster", "--kubeconfig", "-s", "--server"],
    standaloneFlags: [],
    equalsFlags: ["--namespace=", "--context=", "--cluster=", "--kubeconfig=", "--server="],
  },
  oc: {
    flagsWithArg: ["-n", "--namespace", "--context", "--cluster", "--kubeconfig", "-s", "--server"],
    standaloneFlags: [],
    equalsFlags: ["--namespace=", "--context=", "--cluster=", "--kubeconfig=", "--server="],
  },
  docker: {
    flagsWithArg: ["-H", "--host", "--context", "--config", "-l", "--log-level"],
    standaloneFlags: ["-D", "--debug"],
    equalsFlags: ["--host=", "--context=", "--config=", "--log-level="],
  },
};

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

/**
 * Normalize a command by:
 * 1. Stripping leading VAR=value env var prefixes
 * 2. Stripping global flags before the subcommand (git, kubectl, oc, docker)
 *
 * Unknown commands pass through with only env var stripping.
 */
export function normalizeCommand(command: string): string {
  const stripped = stripEnvVarPrefixes(command.trim());
  const parts = stripped.split(/\s+/);
  if (parts.length === 0) return stripped;

  const tool = parts[0];
  const spec = normalizeSpecs[tool];
  if (!spec) return stripped;

  const result = [tool];
  let i = 1;
  while (i < parts.length) {
    const token = parts[i];

    if (spec.equalsFlags.some((f) => token.startsWith(f))) {
      i++;
      continue;
    }

    if (spec.flagsWithArg.includes(token)) {
      i += 2;
      continue;
    }

    if (spec.standaloneFlags.includes(token)) {
      i++;
      continue;
    }

    // Not a global flag — this is the subcommand; take the rest as-is
    result.push(...parts.slice(i));
    break;
  }

  return result.join(" ");
}
