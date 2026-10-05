/**
 * Fixing and sorting logic for doctor findings.
 */

import type { Permissions } from "../types.js";
import type { Finding } from "./types.js";
import { parseRule } from "../matcher.js";

const typeOrder: Record<string, number> = { Read: 0, Write: 1, Edit: 2, Bash: 3 };

/** Comparator: group by type (Read → Write → Edit → Bash), then alphabetically. */
export function ruleComparator(a: string, b: string): number {
  const pa = parseRule(a);
  const pb = parseRule(b);
  const typeA = pa ? (typeOrder[pa.type] ?? 99) : 99;
  const typeB = pb ? (typeOrder[pb.type] ?? 99) : 99;
  if (typeA !== typeB) return typeA - typeB;
  return a.localeCompare(b);
}

/** Sort rules: group by type (Read → Write → Edit → Bash), then alphabetically within each group. */
export function sortRules(rules: string[]): string[] {
  return [...rules].sort(ruleComparator);
}

/** Apply approved fixes to permissions (mutates in place). Returns count of changes. */
export function applyFixes(
  permissions: Permissions,
  findings: Finding[],
  approved: Set<number>,
): number {
  let changes = 0;

  const toRemove: Array<{ list: "allow" | "deny" | "ask"; rule: string }> = [];
  const toAdd: Array<{ list: "allow" | "deny" | "ask"; rule: string }> = [];

  for (const idx of approved) {
    const finding = findings[idx];
    if (!finding) continue;

    if (finding.action === "remove") {
      toRemove.push({ list: finding.list, rule: finding.rule });
      changes++;
    } else if (finding.action?.startsWith("move:")) {
      const targetList = finding.action.slice(5) as "allow" | "deny" | "ask";
      toRemove.push({ list: finding.list, rule: finding.rule });
      toAdd.push({ list: targetList, rule: finding.rule });
      changes++;
    } else if (finding.action?.startsWith("replace:")) {
      const newRule = finding.action.slice("replace:".length);
      toRemove.push({ list: finding.list, rule: finding.rule });
      toAdd.push({ list: finding.list, rule: newRule });
      changes++;
    } else if (finding.action?.startsWith("split:")) {
      const spec = JSON.parse(finding.action.slice("split:".length));
      toRemove.push({ list: finding.list, rule: finding.rule });
      for (const pattern of (spec.allow || [])) {
        toAdd.push({ list: "allow", rule: pattern });
      }
      for (const pattern of (spec.ask || [])) {
        toAdd.push({ list: "ask", rule: pattern });
      }
      changes++;
    } else if (finding.action?.startsWith("consolidate:")) {
      const broadRule = finding.action.slice("consolidate:".length);
      const individualRules = finding.rule.split(", ");
      for (const rule of individualRules) {
        toRemove.push({ list: finding.list, rule: rule.trim() });
      }
      toAdd.push({ list: finding.list, rule: broadRule });
      changes++;
    }
  }

  // Apply removals
  for (const { list, rule } of toRemove) {
    const idx = permissions[list].indexOf(rule);
    if (idx !== -1) permissions[list].splice(idx, 1);
  }

  // Apply additions (avoid duplicates)
  for (const { list, rule } of toAdd) {
    if (!permissions[list].includes(rule)) {
      permissions[list].push(rule);
    }
  }

  // Sort at the end
  const hasSortFinding = findings.some(
    (f, i) => f.action === "sort" && approved.has(i),
  );
  if (hasSortFinding || changes > 0) {
    permissions.allow = sortRules(permissions.allow);
    permissions.deny = sortRules(permissions.deny);
    permissions.ask = sortRules(permissions.ask);
    changes++;
  }

  return changes;
}
