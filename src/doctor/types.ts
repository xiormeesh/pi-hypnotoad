/** Severity level for a doctor finding. */
export type Severity = "error" | "warning" | "info";

/** A single issue found by the doctor, with optional suggested fix. */
export interface Finding {
  severity: Severity;
  rule: string;
  list: "allow" | "deny" | "ask";
  message: string;
  /**
   * Suggested action:
   * - "remove" — delete the rule from its list
   * - "move:deny" / "move:ask" — move to another list
   * - "replace:NewRule(...)" — swap for a different rule
   * - "split:{allow:[...],ask:[...]}" — replace broad rule with safe+dangerous patterns
   * - "consolidate:NewRule(...)" — merge multiple rules into one
   * - "sort" — sort the list
   * - null — informational, no automated fix
   */
  action: string | null;
}
