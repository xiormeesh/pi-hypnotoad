/**
 * Bash command parser.
 *
 * Splits chained/piped commands on |, ||, &&, ;, & while respecting:
 * - single and double quotes
 * - backslash escapes
 * - $() command substitutions (nested)
 * - backtick command substitutions
 * - <() and >() process substitutions
 * - () subshells
 */

/**
 * Split a bash command string into segments on |, ||, &&, ;, &.
 * Only splits at the top level — operators inside quotes, $(), ``, <(), >(),
 * or () subshells are left intact.
 */
export function splitBashSegments(command: string): string[] {
  const segments: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  let escaped = false;
  let parenDepth = 0;
  let inBacktick = false;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];

    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }

    if (ch === "\\" && !inSingle) {
      current += ch;
      escaped = true;
      continue;
    }

    if (ch === "'" && !inDouble && !inBacktick) {
      inSingle = !inSingle;
      current += ch;
      continue;
    }

    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      current += ch;
      continue;
    }

    // Everything below only applies outside quotes
    if (!inSingle && !inDouble) {
      // $() command substitution
      if (ch === "$" && command[i + 1] === "(") {
        parenDepth++;
        current += "$(";
        i++;
        continue;
      }

      // <() and >() process substitution
      if ((ch === "<" || ch === ">") && command[i + 1] === "(") {
        parenDepth++;
        current += ch + "(";
        i++;
        continue;
      }

      // Nested ( inside an already-open substitution/subshell
      if (ch === "(") {
        parenDepth++;
        current += ch;
        continue;
      }

      if (ch === ")" && parenDepth > 0) {
        parenDepth--;
        current += ch;
        continue;
      }

      // Backtick substitution (toggle — backticks don't nest)
      if (ch === "`") {
        inBacktick = !inBacktick;
        current += ch;
        continue;
      }

      // Only split on chain operators at the top level
      if (parenDepth === 0 && !inBacktick) {
        // || — logical OR
        if (ch === "|" && command[i + 1] === "|") {
          segments.push(current);
          current = "";
          i++;
          continue;
        }
        // && — logical AND
        if (ch === "&" && command[i + 1] === "&") {
          segments.push(current);
          current = "";
          i++;
          continue;
        }
        // | — pipe
        if (ch === "|") {
          segments.push(current);
          current = "";
          continue;
        }
        // ; — sequential
        if (ch === ";") {
          segments.push(current);
          current = "";
          continue;
        }
        // & — background (but not && or &> or >&)
        if (ch === "&" && command[i + 1] !== "&" && command[i + 1] !== ">") {
          const prev = i > 0 ? command[i - 1] : "";
          if (prev !== ">" && prev !== "<") {
            segments.push(current);
            current = "";
            continue;
          }
        }
      }
    }

    current += ch;
  }

  segments.push(current);
  return segments.map((s) => s.trim()).filter(Boolean);
}

/** Remove bash comment lines (# ...) that models add as annotations. */
export function stripComments(command: string): string {
  return command
    .split("\n")
    .filter((line) => !line.match(/^\s*#/))
    .join("\n")
    .trim();
}

/** Remove leading `cd /path && ` or `cd /path;` prefixes (directory setup, not user intent). */
export function stripCdPrefix(command: string): string {
  return command.replace(/^\s*cd\s+\S+\s*(?:&&|;)\s*/g, "");
}

/** Test whether a segment is a standalone cd to a literal path. */
export function isCdSegment(segment: string): boolean {
  return /^\s*cd\s+(?:'[^']*'|[^\s"'`$\\;&|<>()\[\]{}*?]+)\s*$/.test(segment);
}

// Shell setup detection lives in bash-normalizer.ts — re-export for consumers
export { isShellSetupSegment } from "./bash-normalizer.js";

/**
 * Check whether a bash segment contains an output redirect to a real file.
 * Returns the target path if found, null otherwise.
 *
 * Safe redirects that return null:
 *   >/dev/null, 2>&1, &>/dev/null, 1>&2
 *
 * Dangerous redirects that return the target:
 *   > file.txt, >> output.log, &> build.log
 */
export function fileRedirectTarget(segment: string): string | null {
  let inSingle = false;
  let inDouble = false;
  let escaped = false;
  let parenDepth = 0;
  let inBacktick = false;

  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i];

    if (escaped) { escaped = false; continue; }
    if (ch === "\\" && !inSingle) { escaped = true; continue; }
    if (ch === "'" && !inDouble && !inBacktick) { inSingle = !inSingle; continue; }
    if (ch === '"' && !inSingle) { inDouble = !inDouble; continue; }

    if (inSingle || inDouble) continue;

    // Track nesting — only check top-level redirects
    if (ch === "$" && segment[i + 1] === "(") { parenDepth++; i++; continue; }
    if ((ch === "<" || ch === ">") && segment[i + 1] === "(") { parenDepth++; i++; continue; }
    if (ch === "(" && parenDepth > 0) { parenDepth++; continue; }
    if (ch === ")" && parenDepth > 0) { parenDepth--; continue; }
    if (ch === "`") { inBacktick = !inBacktick; continue; }
    if (parenDepth > 0 || inBacktick) continue;

    // Detect output redirect: >, >>, &>, N>
    if (ch !== ">") continue;

    // Skip < (input redirect) — we only care about >
    // Check what's before: could be digit (N>) or & (&>)
    let j = i + 1;
    if (j < segment.length && segment[j] === ">") j++; // >> or &>>

    // Skip whitespace after redirect operator
    while (j < segment.length && segment[j] === " ") j++;
    if (j >= segment.length) continue;

    // &N is fd redirect (e.g., 2>&1, >&2), not a file
    if (segment[j] === "&") continue;

    // Extract target path
    let target = "";
    while (j < segment.length && !" \t;|&".includes(segment[j])) {
      target += segment[j];
      j++;
    }

    if (!target) continue;
    if (target === "/dev/null") continue;

    return target;
  }

  return null;
}

/** Check whether any segment in a command has a file redirect. */
export function anySegmentHasFileRedirect(command: string): boolean {
  return splitBashSegments(command).some((seg) => fileRedirectTarget(seg) !== null);
}
