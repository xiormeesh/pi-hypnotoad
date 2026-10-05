/**
 * Minimal YAML parser/serializer for permissions files.
 *
 * Handles only the shape we need — no general YAML support:
 *   - Top-level keys mapping to string arrays (allow, deny, ask)
 *   - Top-level key mapping to a block scalar string (systemPrompt)
 *   - # comments (preserved on merge saves, lost on replace saves)
 *
 * Zero dependencies.
 */

import type { Permissions } from "./types.js";

const LISTS = ["allow", "deny", "ask"] as const;

/** Parse a YAML permissions file into a Permissions object. */
export function parseYaml(text: string): Permissions {
  const result: Permissions = { allow: [], deny: [], ask: [] };
  let currentKey: string | null = null;
  let inBlock = false;
  const blockLines: string[] = [];

  for (const line of text.split("\n")) {
    const trimmed = line.trim();

    // Inside a block scalar: collect indented lines, end on unindented non-empty
    if (inBlock) {
      if (trimmed === "" || line.startsWith("  ")) {
        blockLines.push(trimmed === "" ? "" : line.slice(2));
        continue;
      }
      // Non-indented non-empty line ends the block
      // Trim trailing blank lines from the block
      while (blockLines.length > 0 && blockLines[blockLines.length - 1] === "") {
        blockLines.pop();
      }
      result.systemPrompt = blockLines.join("\n");
      inBlock = false;
      currentKey = null;
      // Fall through to process this line normally
    }

    // Skip empty lines and comments
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    // Top-level key (no leading whitespace)
    if (!line.startsWith(" ") && trimmed.includes(":")) {
      const colonIdx = trimmed.indexOf(":");
      const key = trimmed.slice(0, colonIdx);
      const after = trimmed.slice(colonIdx + 1).trim();

      currentKey = key;

      if (after === "|") {
        inBlock = true;
        blockLines.length = 0;
        continue;
      }
      if (after && after !== "|") {
        // Inline string value: key: "value" or key: value
        (result as any)[key] = after.replace(/^["']|["']$/g, "");
        currentKey = null;
      }
      continue;
    }

    // Array item: - "value" or - value (with optional inline # comment)
    if (currentKey && trimmed.startsWith("- ")) {
      let value = trimmed.slice(2).trim();
      // Strip inline comment (but not # inside quotes)
      if (value.startsWith('"') || value.startsWith("'")) {
        const quote = value[0];
        const endQuote = value.lastIndexOf(quote);
        if (endQuote > 0) {
          value = value.slice(1, endQuote);
        }
      } else {
        // Unquoted — strip inline comment
        const hashIdx = value.indexOf(" #");
        if (hashIdx >= 0) value = value.slice(0, hashIdx).trim();
      }

      const list = (result as any)[currentKey];
      if (Array.isArray(list)) {
        list.push(value);
      }
    }
  }

  // Close any open block scalar
  if (inBlock && blockLines.length > 0) {
    while (blockLines.length > 0 && blockLines[blockLines.length - 1] === "") {
      blockLines.pop();
    }
    result.systemPrompt = blockLines.join("\n");
  }

  return result;
}

/** Serialize a Permissions object to YAML. */
export function serializeYaml(permissions: Permissions): string {
  const lines: string[] = [];

  for (const list of LISTS) {
    const rules = permissions[list];
    lines.push(`${list}:`);
    if (rules.length === 0) {
      lines.push("  []");
    } else {
      for (const rule of rules) {
        lines.push(`  - "${rule}"`);
      }
    }
    lines.push("");
  }

  if (permissions.systemPrompt) {
    lines.push("systemPrompt: |");
    for (const line of permissions.systemPrompt.split("\n")) {
      lines.push(`  ${line}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Extract the command prefix from a rule for grouping.
 * E.g., "Bash(git stash drop *)" → "git"
 *       "Bash(acli jira workitem view *)" → "acli jira"
 *       "Read(path:src/**)" → "Read src"
 *       "Modify(path:.pi/**)" → "Modify .pi"
 */
function ruleGroupKey(rule: string): string {
  // File rules: group by tool type + first path segment
  const fileMatch = rule.match(/^(Read|Write|Edit|Modify)\(path:([^*{]+)/);
  if (fileMatch) {
    const seg = fileMatch[2].split("/")[0];
    return `${fileMatch[1]} ${seg}`;
  }
  // Bash rules: group by the command name (first word)
  const bashMatch = rule.match(/^Bash\((.+)\)$/);
  if (bashMatch) {
    const parts = bashMatch[1].split(/\s+/);
    return parts[0] || "";
  }
  return "";
}

/**
 * Sort rules within each section of a YAML file, preserving comments.
 *
 * Comments and blank lines above a rule are "sticky" — they move with
 * the rule when it's sorted.
 *
 * @param rawText   The full YAML file text.
 * @param sortFn    Comparator for rule strings (receives the parsed rule
 *                  value, not the YAML line).
 * @returns         The sorted YAML text.
 */
export function sortYamlPreservingComments(
  rawText: string,
  sortFn: (a: string, b: string) => number,
): string {
  const lines = rawText.split("\n");
  const result: string[] = [];
  const LISTS = ["allow", "deny", "ask"] as const;

  let i = 0;
  while (i < lines.length) {
    const trimmed = lines[i].trim();

    // Check if this line is a section header
    const sectionMatch = LISTS.find(
      (l) => trimmed === `${l}:` || trimmed.startsWith(`${l}:`),
    );

    if (!sectionMatch) {
      result.push(lines[i]);
      i++;
      continue;
    }

    // Found a section — emit the header
    result.push(lines[i]);
    i++;

    // Find the section boundary (next top-level key or EOF)
    let sectionEnd = lines.length;
    for (let j = i; j < lines.length; j++) {
      const t = lines[j].trim();
      if (
        !lines[j].startsWith(" ") &&
        !lines[j].startsWith("#") &&
        t.includes(":") &&
        t !== ""
      ) {
        sectionEnd = j;
        break;
      }
    }

    // Parse section lines into entries: { preamble: string[], rule: string, ruleLine: string }
    // preamble = comment/blank lines above the rule ("sticky" to it)
    type Entry = { preamble: string[]; rule: string; ruleLine: string };
    const entries: Entry[] = [];
    let preamble: string[] = [];

    for (let j = i; j < sectionEnd; j++) {
      const t = lines[j].trim();
      if (t.startsWith("- ")) {
        // This is a rule line — extract the value
        let value = t.slice(2).trim();
        if (value.startsWith('"') || value.startsWith("'")) {
          const quote = value[0];
          const endQuote = value.lastIndexOf(quote);
          if (endQuote > 0) value = value.slice(1, endQuote);
        } else {
          const hashIdx = value.indexOf(" #");
          if (hashIdx >= 0) value = value.slice(0, hashIdx).trim();
        }

        entries.push({ preamble, rule: value, ruleLine: lines[j] });
        preamble = [];
      } else {
        // Comment or blank line
        preamble.push(lines[j]);
      }
    }

    // Sort the entries
    entries.sort((a, b) => sortFn(a.rule, b.rule));

    // Emit sorted entries with their sticky comments
    for (const entry of entries) {
      for (const line of entry.preamble) result.push(line);
      result.push(entry.ruleLine);
    }

    // Emit any trailing comments/blanks after the last rule
    for (const line of preamble) result.push(line);

    i = sectionEnd;
  }

  return result.join("\n");
}

/**
 * Sync a YAML file's sections with in-memory permissions.
 *
 * - Removes rule lines (and their sticky comments) that are not in the
 *   in-memory lists.
 * - Appends new rules that exist in memory but not on disk.
 *
 * Preserves all other text (comments, blank lines, systemPrompt, etc.).
 */
export function syncYamlWithPermissions(
  rawText: string,
  permissions: Permissions,
): string {
  const lines = rawText.split("\n");
  const result: string[] = [];
  const SECTION_LISTS = ["allow", "deny", "ask"] as const;

  let i = 0;
  while (i < lines.length) {
    const trimmed = lines[i].trim();

    const sectionMatch = SECTION_LISTS.find(
      (l) => trimmed === `${l}:` || trimmed.startsWith(`${l}:`),
    );

    if (!sectionMatch) {
      result.push(lines[i]);
      i++;
      continue;
    }

    // Found a section — emit the header
    result.push(lines[i]);
    i++;

    // Find section end
    let sectionEnd = lines.length;
    for (let j = i; j < sectionEnd; j++) {
      const t = lines[j].trim();
      if (
        !lines[j].startsWith(" ") &&
        !lines[j].startsWith("#") &&
        t.includes(":") &&
        t !== ""
      ) {
        sectionEnd = j;
        break;
      }
    }

    const wantedRules = new Set(permissions[sectionMatch]);
    const seenRules = new Set<string>();
    let preamble: string[] = [];

    // Walk section, keep rules that are in the wanted set
    for (let j = i; j < sectionEnd; j++) {
      const t = lines[j].trim();
      if (t.startsWith("- ")) {
        let value = t.slice(2).trim();
        if (value.startsWith('"') || value.startsWith("'")) {
          const quote = value[0];
          const endQuote = value.lastIndexOf(quote);
          if (endQuote > 0) value = value.slice(1, endQuote);
        } else {
          const hashIdx = value.indexOf(" #");
          if (hashIdx >= 0) value = value.slice(0, hashIdx).trim();
        }

        if (wantedRules.has(value)) {
          // Keep: emit preamble + rule
          for (const line of preamble) result.push(line);
          result.push(lines[j]);
          seenRules.add(value);
        }
        // Either way, reset preamble
        preamble = [];
      } else {
        preamble.push(lines[j]);
      }
    }

    // Append rules that are new (not on disk)
    for (const rule of permissions[sectionMatch]) {
      if (!seenRules.has(rule)) {
        result.push(`  - "${rule}"`);
      }
    }

    // Emit any trailing comments/blanks
    for (const line of preamble) result.push(line);

    i = sectionEnd;
  }

  return result.join("\n");
}

/**
 * Merge a new rule into a YAML file's raw text, preserving comments.
 *
 * Tries to insert near existing rules that share the same command prefix
 * (e.g., a new git rule goes next to other git rules). Falls back to
 * appending at the end of the section.
 *
 * Returns the modified text, or null if the section wasn't found.
 */
export function mergeRuleIntoYaml(
  rawText: string,
  list: "allow" | "deny" | "ask",
  rule: string,
): string | null {
  const lines = rawText.split("\n");
  const sectionStart = lines.findIndex(
    (l) => l.trim() === `${list}:` || l.trim().startsWith(`${list}:`),
  );
  if (sectionStart < 0) return null;

  // Find the section boundary (next top-level key or EOF)
  let sectionEnd = lines.length;
  for (let i = sectionStart + 1; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!lines[i].startsWith(" ") && !lines[i].startsWith("#") && trimmed.includes(":") && trimmed !== "") {
      sectionEnd = i;
      break;
    }
  }

  // Find the best insertion point — after the last rule with the same group key
  const newKey = ruleGroupKey(rule);
  let bestIdx = -1;
  let lastItemIdx = sectionStart;

  for (let i = sectionStart + 1; i < sectionEnd; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed.startsWith("- ")) continue;

    lastItemIdx = i;

    // Extract the rule value from the YAML line
    let value = trimmed.slice(2).trim();
    if (value.startsWith('"') || value.startsWith("'")) {
      const quote = value[0];
      const endQuote = value.lastIndexOf(quote);
      if (endQuote > 0) value = value.slice(1, endQuote);
    }

    if (newKey && ruleGroupKey(value) === newKey) {
      bestIdx = i;
    }
  }

  // Insert after the best match, or after the last item in the section
  const insertAfter = bestIdx >= 0 ? bestIdx : lastItemIdx;
  const newLine = `  - "${rule}"`;
  lines.splice(insertAfter + 1, 0, newLine);
  return lines.join("\n");
}
