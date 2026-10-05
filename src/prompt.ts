/**
 * Prompt formatting for tool call approval.
 *
 * Builds a readable, segment-annotated prompt for bash commands and
 * a simple path display for file operations.
 */

import { splitBashSegments, fileRedirectTarget } from "./parser.js";
import { matchesAnyRule } from "./matcher.js";
import type { Permissions } from "./types.js";

const MAX_SEGMENT_DISPLAY = 200;
const MAX_TOTAL_DISPLAY = 600;

type SegmentStatus = "allow" | "deny" | "ask" | "unknown";

interface AnnotatedSegment {
  text: string;
  status: SegmentStatus;
}

const statusIcons: Record<SegmentStatus, string> = {
  allow: "✓",
  deny: "✗",
  ask: "?",
  unknown: "?",
};

const statusLabels: Record<SegmentStatus, string> = {
  allow: "",
  deny: "(deny rule)",
  ask: "(always-ask rule)",
  unknown: "",
};

const REDIRECT_LABEL = "(writes to file)";

/** Classify each segment of a bash command against the permission rules. */
export function classifySegments(command: string, permissions: Permissions): AnnotatedSegment[] {
  const segments = splitBashSegments(command);
  return segments.map((text) => {
    let status: SegmentStatus = "unknown";
    if (matchesAnyRule(permissions.deny, "Bash", text)) {
      status = "deny";
    } else if (
      matchesAnyRule(permissions.ask, "Bash", text) &&
      !matchesAnyRule(permissions.allow, "Bash", text)
    ) {
      status = "ask";
    } else if (matchesAnyRule(permissions.allow, "Bash", text)) {
      // Allowed by pattern, but check for file redirects — a command that
      // writes to a file shouldn't be silently approved just because the
      // base command is allowed (e.g., echo * shouldn't auto-allow echo > file)
      const redirectTarget = fileRedirectTarget(text);
      status = redirectTarget ? "unknown" : "allow";
    }
    return { text, status };
  });
}

/** Truncate a string, adding ... if it exceeds maxLen. */
function truncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen - 3) + "...";
}

/**
 * Format a single segment for display. Wraps long arguments onto
 * indented continuation lines for readability.
 */
function formatSegment(text: string, maxLen: number): string {
  // If it fits on one line, just use it
  const trimmed = text.trim();
  if (trimmed.length <= maxLen) return trimmed;

  // Split into command + args, truncate the args portion
  const firstSpace = trimmed.indexOf(" ");
  if (firstSpace === -1) return truncate(trimmed, maxLen);

  const cmd = trimmed.slice(0, firstSpace);
  const args = trimmed.slice(firstSpace + 1);
  return cmd + " " + truncate(args, maxLen - cmd.length - 1);
}

/**
 * Turn a possibly multi-line display string into one or more plain-text lines,
 * each prefixed with the segment's icon.  This handles the case where
 * newline-separated commands end up in a single segment (the parser doesn't
 * split on \n yet) — every visual line gets an icon so nothing looks orphaned.
 * The suffix (label) is appended only to the last sub-line.
 *
 * No ANSI styling — pi's TUI select measures raw string length, so escape
 * codes cause misalignment between lines with different-length sequences.
 */
function prefixedLines(
  display: string,
  icon: string,
  suffix: string,
): string[] {
  const subLines = display.split("\n").map((l) => l.trim()).filter(Boolean);
  return subLines.map((line, i) => {
    const s = i === subLines.length - 1 ? suffix : "";
    return `  ${icon} ${line}${s}`;
  });
}

/**
 * Build the display string for a bash approval prompt.
 * Shows each segment on its own line with a status icon.
 */
export function formatBashPrompt(
  command: string,
  permissions: Permissions,
  reason?: string,
): string {
  const annotated = classifySegments(command, permissions);

  // Single segment — simple display
  if (annotated.length === 1) {
    const seg = annotated[0];
    const icon = statusIcons[seg.status];
    const label = statusLabels[seg.status];
    const redirect = seg.status !== "allow" ? fileRedirectTarget(seg.text) : null;
    const display = formatSegment(seg.text, MAX_TOTAL_DISPLAY);
    const suffix = redirect
      ? `  ${REDIRECT_LABEL}`
      : label ? `  ${label}` : "";
    return prefixedLines(display, icon, suffix).join("\n");
  }

  // Multiple segments — one per line with status
  const lines: string[] = [];
  let totalLen = 0;

  for (const seg of annotated) {
    const icon = statusIcons[seg.status];
    const label = statusLabels[seg.status];
    const budget = Math.min(MAX_SEGMENT_DISPLAY, MAX_TOTAL_DISPLAY - totalLen);

    if (budget <= 20) {
      lines.push("  ...");
      break;
    }

    const display = formatSegment(seg.text, budget);
    const redirect = seg.status !== "allow" ? fileRedirectTarget(seg.text) : null;
    const suffix = redirect
      ? `  ${REDIRECT_LABEL}`
      : label ? `  ${label}` : "";
    lines.push(...prefixedLines(display, icon, suffix));
    totalLen += display.length;
  }

  return lines.join("\n");
}

/**
 * Determine the overall reason label for a bash prompt based on
 * which segments triggered it.
 */
export function bashPromptLabel(command: string, permissions: Permissions): string {
  const annotated = classifySegments(command, permissions);
  const hasAsk = annotated.some((s) => s.status === "ask");
  const hasDeny = annotated.some((s) => s.status === "deny");
  const hasUnknown = annotated.some((s) => s.status === "unknown");

  if (hasDeny) return "Bash command blocked";
  if (hasAsk && !hasUnknown) return "Bash command needs approval";
  if (hasUnknown && !hasAsk) return "Bash command needs approval";
  return "Bash command needs approval";
}
