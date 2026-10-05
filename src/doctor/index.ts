/**
 * Permissions doctor — sanity check and cleanup for permissions.yml.
 *
 * Analyzes rules for (all checks are structural, no tool-specific knowledge):
 * - Overly broad allow rules (Bash(*), Write(path:**), .ssh/.env/.key paths)
 * - Allow rules that carve exceptions from broader ask rules
 * - Shadowed file allow rules (dead due to broader ask rule)
 * - Redundant subpath rules within the same list
 * - Consolidation candidates (3+ rules under same parent)
 * - Dead file paths (stale rules after renames)
 * - Absolute home paths (should use ~ for portability)
 * - Duplicate or malformed rules
 * - Sorting inconsistencies
 */

import type { Permissions } from "../types.js";
import type { Finding } from "./types.js";
import {
  checkRule,
  findDuplicates,
  findAllowOverridingAsk,
  findShadowedAllowRules,
  findRedundantSubpaths,
  findConsolidationCandidates,
  findDeadPaths,
  findAbsoluteHomePaths,
  checkSorting,
} from "./checks.js";

/** Run all doctor checks and return findings. */
export function runDoctor(permissions: Permissions, projectRoot?: string): Finding[] {
  const findings: Finding[] = [];
  const lists = ["allow", "deny", "ask"] as const;

  for (const list of lists) {
    for (const rule of permissions[list]) {
      findings.push(...checkRule(rule, list));
    }
  }

  findings.push(...findDuplicates(permissions));
  findings.push(...findAllowOverridingAsk(permissions));
  findings.push(...findShadowedAllowRules(permissions));
  findings.push(...findRedundantSubpaths(permissions));
  findings.push(...findConsolidationCandidates(permissions));
  if (projectRoot) {
    findings.push(...findDeadPaths(permissions, projectRoot));
  }
  findings.push(...findAbsoluteHomePaths(permissions));
  findings.push(...checkSorting(permissions));

  return findings;
}

// Re-export public API
export { sortRules, applyFixes } from "./fixes.js";
export type { Finding, Severity } from "./types.js";
