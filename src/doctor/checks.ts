/**
 * Doctor check functions — each analyzes permissions for a specific class of issues.
 *
 * Every function takes a Permissions object and returns Finding[].
 * Pure functions with no side effects (except findDeadPaths which reads the filesystem).
 */

import type { Permissions } from "../types.js";
import type { Finding } from "./types.js";
import { parseRule, matchesRule, expandBraces } from "../matcher.js";
import { dangerousAllowPatterns } from "./rules.js";
import { sortRules } from "./fixes.js";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";

// --- Helpers ---

/** Extract the path from a file rule like Write(path:src/ols/**) → "src/ols/**". */
function extractFilePath(rule: string): { type: string; path: string } | null {
  const parsed = parseRule(rule);
  if (!parsed || parsed.type === "Bash") return null;
  return { type: parsed.type, path: parsed.pattern };
}

/** Check if two file rule types are compatible (Modify covers Write and Edit). */
function fileTypesOverlap(a: string, b: string): boolean {
  if (a === b) return true;
  if (a === "Modify") return b === "Write" || b === "Edit";
  if (b === "Modify") return a === "Write" || a === "Edit";
  return false;
}

/** Strip trailing glob (/** or /*) to get the directory prefix. */
function dirPrefix(path: string): string {
  return path.replace(/\/\*\*$/, "").replace(/\/\*$/, "");
}

/** Check if child path is under parent path. */
function isSubpathOf(child: string, parent: string): boolean {
  const p = dirPrefix(parent);
  const c = dirPrefix(child);
  if (p === "**" || p === "*") return true;
  return c.startsWith(p + "/") && c !== p;
}

// --- Individual checks ---

/** Check a single rule for dangerous patterns in allow list and malformed syntax. */
export function checkRule(rule: string, list: "allow" | "deny" | "ask"): Finding[] {
  const findings: Finding[] = [];

  const parsed = parseRule(rule);
  if (!parsed) {
    findings.push({
      severity: "error",
      rule,
      list,
      message: "Malformed rule — must be Type(pattern) where Type is Bash, Read, Write, or Edit",
      action: "remove",
    });
    return findings;
  }

  if (list === "allow") {
    for (const check of dangerousAllowPatterns) {
      if (check.pattern.test(rule)) {
        findings.push({
          severity: check.action === "move:deny" ? "error" : "warning",
          rule,
          list,
          message: check.message,
          action: check.action,
        });
      }
    }
  }

  return findings;
}

/** Find duplicate rules within and across lists. */
export function findDuplicates(permissions: Permissions): Finding[] {
  const findings: Finding[] = [];
  const lists = ["allow", "deny", "ask"] as const;

  for (const list of lists) {
    const seen = new Set<string>();
    for (const rule of permissions[list]) {
      if (seen.has(rule)) {
        findings.push({
          severity: "info",
          rule,
          list,
          message: `Duplicate rule in ${list} list`,
          action: "remove",
        });
      }
      seen.add(rule);
    }
  }

  for (const rule of permissions.allow) {
    if (permissions.deny.includes(rule)) {
      findings.push({
        severity: "error",
        rule,
        list: "allow",
        message: "Rule appears in both allow AND deny lists — deny takes priority, allow entry is dead",
        action: "remove",
      });
    }
    if (permissions.ask.includes(rule)) {
      findings.push({
        severity: "warning",
        rule,
        list: "allow",
        message: "Rule appears in both allow AND ask lists — ask takes priority, allow entry is dead",
        action: "remove",
      });
    }
  }

  return findings;
}


/**
 * Detect allow rules that carve exceptions from broader ask rules.
 *
 * A carve-exception is safe if the allow pattern restricts to:
 * - A specific filesystem path (no glob in the argument portion)
 * - A known-safe read-only subcommand/flag
 *
 * Safe carve-exceptions are silently accepted (that's the whole point of
 * allow-overrides-ask). Only risky ones that still permit arbitrary input
 * are flagged with a "remove" action.
 */
export function findAllowOverridingAsk(permissions: Permissions): Finding[] {
  const findings: Finding[] = [];
  const reported = new Set<string>();

  for (const allowRule of permissions.allow) {
    const allowParsed = parseRule(allowRule);
    if (!allowParsed || allowParsed.type !== "Bash") continue;

    for (const askRule of permissions.ask) {
      const askParsed = parseRule(askRule);
      if (!askParsed || askParsed.type !== "Bash") continue;
      if (allowRule === askRule) continue;

      const key = `${allowRule}|${askRule}`;
      if (reported.has(key)) continue;

      const allowTest = allowParsed.pattern
        .replace(/\*\*/g, "test/test")
        .replace(/\*/g, "test");
      const askTest = askParsed.pattern
        .replace(/\*\*/g, "test/test")
        .replace(/\*/g, "test");

      const hasOverlap =
        matchesRule(askRule, "Bash", allowTest) ||
        matchesRule(allowRule, "Bash", askTest);

      if (!hasOverlap) continue;
      reported.add(key);

      // Classify: is this carve-exception safe or risky?
      if (isCarveExceptionSafe(allowParsed.pattern, askParsed.pattern)) continue;

      findings.push({
        severity: "warning",
        rule: allowRule,
        list: "allow",
        message: `Carves risky exception from ask rule ${askRule} — allows arbitrary input, will remove from allow`,
        action: "remove",
      });
    }
  }

  return findings;
}

/**
 * Determine if an allow pattern carving from an ask pattern is safe.
 *
 * Purely structural, no tool-specific knowledge:
 * 1. Filesystem paths in arguments → safe (restricts to known files)
 * 2. More fixed (non-glob) segments than the ask pattern → safe
 *    (narrows to a specific subcommand/mode)
 */
function isCarveExceptionSafe(allowPattern: string, askPattern: string): boolean {
  const allowParts = allowPattern.split(/\s+/);

  // Filesystem paths in arguments are always specific enough
  if (allowParts.slice(1).some((arg) => arg.includes("/"))) return true;

  // Expand braces before counting so {inspect,top} counts as a fixed segment
  const countFixed = (p: string) => {
    const expanded = expandBraces(p)[0]; // first variant is representative
    return expanded.split(/\s+/).filter((s) => !s.includes("*")).length;
  };
  return countFixed(allowPattern) > countFixed(askPattern);
}

/** Find allow file rules shadowed by broader ask rules (dead rules). */
export function findShadowedAllowRules(permissions: Permissions): Finding[] {
  const findings: Finding[] = [];

  for (const allowRule of permissions.allow) {
    const parsed = extractFilePath(allowRule);
    if (!parsed) continue;

    for (const askRule of permissions.ask) {
      const askParsed = extractFilePath(askRule);
      if (!askParsed || !fileTypesOverlap(askParsed.type, parsed.type)) continue;

      if (isSubpathOf(parsed.path, askParsed.path) || parsed.path === askParsed.path) {
        findings.push({
          severity: "warning",
          rule: allowRule,
          list: "allow",
          message: `In allow list but shadowed by ask rule ${askRule} — ask takes priority, will remove from allow`,
          action: "remove",
        });
        break;
      }
    }
  }

  return findings;
}

/** Find redundant subpath rules within the same list. */
export function findRedundantSubpaths(permissions: Permissions): Finding[] {
  const findings: Finding[] = [];
  const lists = ["allow", "deny", "ask"] as const;

  for (const list of lists) {
    const fileRules = permissions[list]
      .map((rule) => ({ rule, parsed: extractFilePath(rule) }))
      .filter((r): r is { rule: string; parsed: { type: string; path: string } } => r.parsed !== null);

    for (const ruleA of fileRules) {
      for (const ruleB of fileRules) {
        if (ruleA.rule === ruleB.rule) continue;
        if (!fileTypesOverlap(ruleA.parsed.type, ruleB.parsed.type)) continue;

        if (isSubpathOf(ruleA.parsed.path, ruleB.parsed.path)) {
          findings.push({
            severity: "info",
            rule: ruleA.rule,
            list,
            message: `Redundant in ${list} list — already covered by ${ruleB.rule}, will remove`,
            action: "remove",
          });
        }
      }
    }
  }

  return findings;
}

/**
 * Suggest consolidation when 3+ file rules in the same list share a common parent.
 * Skips deny — deny rules are surgical guards, consolidating them would
 * over-block (e.g., 3 specific dotfiles → ~/** would block all home reads).
 */
export function findConsolidationCandidates(permissions: Permissions): Finding[] {
  const findings: Finding[] = [];
  const lists = ["allow", "ask"] as const;

  for (const list of lists) {
    const fileRules = permissions[list]
      .map((rule) => ({ rule, parsed: extractFilePath(rule) }))
      .filter((r): r is { rule: string; parsed: { type: string; path: string } } => r.parsed !== null);

    const byType = new Map<string, Array<{ rule: string; path: string }>>();
    for (const { rule, parsed } of fileRules) {
      const group = byType.get(parsed.type) ?? [];
      group.push({ rule, path: parsed.path });
      byType.set(parsed.type, group);
    }

    for (const [toolType, rules] of byType) {
      if (rules.length < 3) continue;

      const byPrefix = new Map<string, Array<{ rule: string; path: string }>>();
      for (const r of rules) {
        const prefix = dirPrefix(r.path).split("/")[0];
        if (!prefix || prefix === "**" || prefix === "*") continue;
        const group = byPrefix.get(prefix) ?? [];
        group.push(r);
        byPrefix.set(prefix, group);
      }

      for (const [prefix, group] of byPrefix) {
        if (group.length < 3) continue;
        const broadRule = `${toolType}(path:${prefix}/**)`;
        if (permissions[list].includes(broadRule)) continue;

        const ruleList = group.map((r) => r.rule).join(", ");
        findings.push({
          severity: "info",
          rule: ruleList,
          list,
          message: `${group.length} ${toolType} rules in ${list} list under ${prefix}/ — consolidate to ${broadRule}`,
          action: `consolidate:${broadRule}`,
        });
      }
    }
  }

  return findings;
}

/**
 * Find file rules whose paths don't exist on disk.
 * Skips deny list (defensive guards), pure globs, and glob-containing prefixes.
 */
export function findDeadPaths(permissions: Permissions, projectRoot: string): Finding[] {
  const findings: Finding[] = [];
  const lists = ["allow", "ask"] as const;

  for (const list of lists) {
    for (const rule of permissions[list]) {
      const parsed = extractFilePath(rule);
      if (!parsed) continue;

      const prefix = dirPrefix(parsed.path);
      if (prefix === "**" || prefix === "*" || prefix === "") continue;
      if (prefix.includes("*")) continue;
      // Skip brace patterns — they expand to multiple paths, not a single filesystem location
      if (prefix.includes("{")) continue;

      if (prefix.startsWith("/")) {
        if (!existsSync(prefix)) {
          findings.push({
            severity: "warning",
            rule,
            list,
            message: `Path does not exist: ${prefix} — stale rule in ${list} list, will remove`,
            action: "remove",
          });
        }
        continue;
      }

      const abs = resolve(projectRoot, prefix);
      if (!existsSync(abs)) {
        findings.push({
          severity: "warning",
          rule,
          list,
          message: `Path does not exist: ${prefix} — stale rule in ${list} list, will remove`,
          action: "remove",
        });
      }
    }
  }

  return findings;
}

/** Flag file rules that use absolute home directory paths instead of ~. */
export function findAbsoluteHomePaths(permissions: Permissions): Finding[] {
  const findings: Finding[] = [];
  const home = homedir();
  const lists = ["allow", "deny", "ask"] as const;

  for (const list of lists) {
    for (const rule of permissions[list]) {
      const parsed = parseRule(rule);
      if (!parsed || parsed.type === "Bash") continue;
      if (!parsed.pattern.startsWith(home)) continue;

      const portable = parsed.pattern.replace(home, "~");
      const newRule = `${parsed.type}(path:${portable})`;
      findings.push({
        severity: "info",
        rule,
        list,
        message: `Absolute home path in ${list} list — replace with portable ${newRule}`,
        action: `replace:${newRule}`,
      });
    }
  }

  return findings;
}

/** Check whether rules are sorted. */
export function checkSorting(permissions: Permissions): Finding[] {
  const findings: Finding[] = [];
  const lists = ["allow", "deny", "ask"] as const;

  for (const list of lists) {
    const sorted = sortRules(permissions[list]);
    const needsSort = permissions[list].some((r, i) => r !== sorted[i]);
    if (needsSort) {
      findings.push({
        severity: "info",
        rule: "",
        list,
        message: `${list} list is not sorted — will be sorted (Read → Write → Edit → Bash, then alphabetical)`,
        action: "sort",
      });
    }
  }

  return findings;
}
