/**
 * Command normalization.
 *
 * Combines bash shell scaffolding removal (see bash-normalizer.ts) with
 * tool-specific global flag stripping and project-root path resolution.
 *
 * Full pipeline (in order):
 *  1. Bash scaffolding (env vars, !, keywords, xargs)  — bash-normalizer.ts
 *  2. Absolute project-root paths → relative           — this file
 *  3. Tool-specific global flags (git, kubectl, oc, docker) — this file
 */

import {
  stripEnvVarPrefixes,
  stripBashScaffolding,
} from "./bash-normalizer.js";

// Re-export for existing consumers
export { stripEnvVarPrefixes };

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

export function normalizeCommand(command: string, projectRoot?: string): string {
  let stripped = stripBashScaffolding(command);

  // Replace absolute project-root paths with relative equivalents
  // so that "/home/user/project/.pi/skills/foo" matches ".pi/skills/**"
  if (projectRoot) {
    const prefix = projectRoot.endsWith("/") ? projectRoot : projectRoot + "/";
    stripped = stripped.split(/\s+/).map((token) =>
      token.startsWith(prefix) ? token.slice(prefix.length) : token
    ).join(" ");
  }

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
