/**
 * Static rule tables for doctor checks.
 *
 * These are purely STRUCTURAL checks — patterns that are problematic
 * regardless of what tools the user works with. No tool-specific
 * knowledge (git, python, npm, etc.) belongs here; that goes in
 * defaults.yml as deny/ask rules.
 */

/** A pattern that should not appear in the allow list. */
export interface DangerousPattern {
  pattern: RegExp;
  message: string;
  action: string;
}

/**
 * Structural patterns that are dangerous in the allow list regardless of tooling.
 * These are about the gate's integrity, not specific command semantics.
 */
export const dangerousAllowPatterns: DangerousPattern[] = [
  // Patterns that defeat the gate entirely
  { pattern: /^Bash\(\*\)$/, message: "Bash(*) allows ANY command — defeats the gate", action: "remove" },
  { pattern: /^Bash\(\* \*\)$/, message: "Bash(* *) allows ANY command — defeats the gate", action: "remove" },
  { pattern: /^(Write|Edit|Modify)\(path:\*\*\)$/, message: "allows modifying ANY file", action: "move:ask" },

  // Sensitive filesystem paths (OS convention, not tool-specific)
  { pattern: /^(Write|Edit|Modify)\(path:.*\.env\b/, message: ".env files in allow — may contain secrets", action: "move:ask" },
  { pattern: /^(Write|Edit|Modify)\(path:.*\.ssh/, message: ".ssh paths in allow — may contain keys", action: "move:deny" },
  { pattern: /^(Write|Edit|Modify)\(path:.*\.(key|pem)\)/, message: "key/pem files in allow — may contain private keys", action: "move:deny" },
];
