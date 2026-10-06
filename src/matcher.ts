/**
 * Rule parsing and pattern matching.
 *
 * Rules follow the format:
 *   Bash(git checkout *)   — matches bash commands
 *   Read(path:wiki/**)     — matches file reads
 *   Write(path:wiki/**)    — matches file writes
 *   Edit(path:wiki/**)     — matches file edits
 *
 * Glob rules:
 *   *  — matches any characters within a single segment
 *   ** — matches across path separators (for file paths)
 */

import type { ParsedRule } from "./types.js";
import { splitBashSegments, isShellSetupSegment } from "./parser.js";
import { normalizeCommand } from "./normalizer.js";
import { homedir } from "node:os";

/**
 * Expand brace groups in a pattern: `{a,b,c}` → multiple patterns.
 * Supports one level of braces (no nesting). Returns the original
 * pattern in an array if no braces are present.
 */
export function expandBraces(pattern: string): string[] {
  const match = pattern.match(/^(.*?)\{([^}]+)\}(.*)$/);
  if (!match) return [pattern];
  const [, prefix, alternatives, suffix] = match;
  return alternatives.split(",").map((alt) => `${prefix}${alt.trim()}${suffix}`);
}

/** Convert a glob pattern to a regex. Trailing ` *` becomes optional so `sort *` matches bare `sort`. */
export function globToRegex(pattern: string): RegExp {
  let re = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\u0000DOUBLESTAR\u0000")
    .replace(/\*/g, ".*")
    .replace(/\u0000DOUBLESTAR\u0000/g, ".*");
  if (re.endsWith(" .*")) {
    re = re.slice(0, -3) + "(?: .*)?";
  }
  return new RegExp("^" + re + "$");
}

/** Parse a rule string like `Bash(git push *)` into its type and pattern. */
export function parseRule(rule: string): ParsedRule | null {
  const m = rule.match(/^(Bash|Read|Write|Edit|Modify)\((.+)\)$/);
  if (!m) return null;
  const type = m[1];
  let pattern = m[2];
  if (type !== "Bash" && pattern.startsWith("path:")) {
    pattern = pattern.slice(5);
  }
  return { type, pattern };
}

function stripDotSlash(s: string): string {
  return s.startsWith("./") ? s.slice(2) : s;
}

/** Expand leading ~ to the user's home directory. */
function expandTilde(s: string): string {
  if (s === "~") return homedir();
  if (s.startsWith("~/")) return homedir() + s.slice(1);
  return s;
}

/** Test whether a single rule matches a tool type and value. */
export function matchesRule(rule: string, toolType: string, value: string, projectRoot?: string): boolean {
  const parsed = parseRule(rule);
  if (!parsed) return false;
  // Modify matches both Write and Edit
  const typeMatches = parsed.type === toolType
    || (parsed.type === "Modify" && (toolType === "Write" || toolType === "Edit"));
  if (!typeMatches) return false;

  let matchValue = toolType !== "Bash" ? stripDotSlash(value) : value;
  if (toolType === "Bash") {
    matchValue = normalizeCommand(matchValue, projectRoot);
  }

  // Expand braces and tilde, match against any expanded variant
  const rawPattern = toolType !== "Bash" ? expandTilde(stripDotSlash(parsed.pattern)) : parsed.pattern;
  const patterns = expandBraces(rawPattern);
  return patterns.some((p) => globToRegex(p).test(matchValue));
}

/** Test whether any rule in the list matches. */
export function matchesAnyRule(rules: string[], toolType: string, value: string, projectRoot?: string): boolean {
  return rules.some((rule) => matchesRule(rule, toolType, value, projectRoot));
}

/** Find the first matching rule in the list, or null. */
export function findMatchingRule(rules: string[], toolType: string, value: string, projectRoot?: string): string | null {
  return rules.find((rule) => matchesRule(rule, toolType, value, projectRoot)) ?? null;
}

/**
 * For bash commands with chains, check that ALL segments match the rules.
 * Standalone `cd <literal>` segments in a chain are exempt (shell context setup).
 */
export function matchesBashRules(rules: string[], command: string, projectRoot?: string): boolean {
  const segments = splitBashSegments(command);
  return segments.every((seg) =>
    matchesAnyRule(rules, "Bash", seg, projectRoot) ||
    (segments.length > 1 && (isShellSetupSegment(seg) || isShellSetupSegment(normalizeCommand(seg, projectRoot)))),
  );
}

/** Check whether ANY segment in a bash chain matches the rules (used for deny/ask checks). */
export function anySegmentMatchesBashRules(rules: string[], command: string, projectRoot?: string): boolean {
  const segments = splitBashSegments(command);
  return segments.some((seg) => matchesAnyRule(rules, "Bash", seg, projectRoot));
}

/**
 * Check whether ANY segment matches askRules but NOT allowRules.
 * Allows specific allow rules to override broad ask patterns
 * (e.g., `Bash(python3 .pi/skills/foo.py)` in allow overrides `Bash(python3 *)` in ask).
 */
export function anySegmentMatchesBashRulesExcludingAllowed(
  askRules: string[],
  allowRules: string[],
  command: string,
  projectRoot?: string,
): boolean {
  const segments = splitBashSegments(command);
  return segments.some(
    (seg) => matchesAnyRule(askRules, "Bash", seg, projectRoot) && !matchesAnyRule(allowRules, "Bash", seg, projectRoot),
  );
}
