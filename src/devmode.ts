/**
 * Dev mode — session-scoped auto-approval for safe development commands.
 *
 * When active, auto-approves build/test/lint/format commands and file
 * operations under the dev path. Always prompts for git mutating commands
 * (commit, push, rebase, merge, reset, etc.).
 */

import type { DevModeState } from "./types.js";
import { splitBashSegments } from "./parser.js";
import { normalizeCommand } from "./normalizer.js";
import { matchesAnyRule } from "./matcher.js";
import { resolve, relative } from "node:path";

/** Regex patterns for commands safe to auto-approve in dev mode. */
const devSafePatterns = [
  /^\s*(make|cmake|go\s+(build|test|vet|fmt|run|generate|mod)|cargo\s+(build|test|check|clippy|fmt|run))/,
  /^\s*(npm|npx|yarn|pnpm|bun)\s+(test|run|exec|start|build|lint|check|typecheck|tsc)/,
  /^\s*(pytest|python\s+-m\s+(pytest|unittest)|tox|nox|ruff|black|isort|mypy|flake8|pylint)\b/,
  /^\s*(mvn|gradle|ant)\b/,
  /^\s*(mkdir|cp|mv|touch|ln|chmod|install)\b/,
  /^\s*rm\s/,
  /^\s*(prettier|eslint|gofmt|rustfmt|clang-format|shfmt)\b/,
  /^\s*(docker|podman)\s+(build|run|exec|logs|ps|images|inspect|cp)\b/,
  /^\s*(kubectl|oc)\s+(get|describe|logs|exec|port-forward|apply|diff)\b/,
  /^\s*git\s+(add|stash\s*$|stash\s+save|stash\s+push|diff|log|status|show|branch|fetch|pull\b)/,
];

/** Git commands that always require approval, even in dev mode. */
const gitMutatingPatterns = [
  /^\s*git\s+(commit|push|rebase|merge|reset|checkout\s+(-b\s+)?\S|cherry-pick|revert|stash\s+(drop|pop|clear)|clean|gc|filter-branch|worktree\s+(add|remove|prune))\b/,
  /^\s*git\s+(am|format-patch|send-email|archive)\b/,
];

/** Check whether a command is safe to auto-approve in dev mode. */
export function isDevModeBashAllowed(
  command: string,
  allowRules: string[],
): boolean {
  const segments = splitBashSegments(command);
  return segments.every((seg) => {
    const normalized = normalizeCommand(seg);
    if (gitMutatingPatterns.some((p) => p.test(normalized))) return false;
    return (
      matchesAnyRule(allowRules, "Bash", seg) ||
      devSafePatterns.some((p) => p.test(normalized))
    );
  });
}

/** Check whether a file path is under the dev mode path. */
export function isFileUnderDevPath(
  filePath: string,
  devMode: DevModeState,
  projectRoot: string,
): boolean {
  const abs = resolve(projectRoot, filePath);
  const rel = relative(devMode.path, abs);
  return !rel.startsWith("..") && !rel.startsWith("/");
}
