/**
 * Prompt formatting for tool call approval.
 *
 * Builds a readable, segment-annotated prompt for bash commands and
 * a simple path display for file operations.
 */

import { splitBashSegments, fileRedirectTarget, isShellSetupSegment } from "./parser.js";
import { matchesAnyRule } from "./matcher.js";
import { normalizeCommand } from "./normalizer.js";
import type { Permissions } from "./types.js";

const MAX_SEGMENT_DISPLAY = 200;
const MAX_TOTAL_DISPLAY = 600;

type SegmentStatus = "allow" | "deny" | "ask" | "unknown";

interface AnnotatedSegment {
  text: string;
  status: SegmentStatus;
}

// ANSI color helpers
const YELLOW = "\x1b[33m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const RESET = "\x1b[0m";

const statusColors: Record<SegmentStatus, string> = {
  allow: GREEN,
  deny: RED,
  ask: YELLOW,
  unknown: YELLOW,
};

const statusIcons: Record<SegmentStatus, string> = {
  allow: "\u2713",
  deny: "\u2717",
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
export function classifySegments(command: string, permissions: Permissions, projectRoot?: string): AnnotatedSegment[] {
  const segments = splitBashSegments(command);
  return segments.map((text) => {
    let status: SegmentStatus = "unknown";
    if (matchesAnyRule(permissions.deny, "Bash", text, projectRoot)) {
      status = "deny";
    } else if (
      matchesAnyRule(permissions.ask, "Bash", text, projectRoot) &&
      !matchesAnyRule(permissions.allow, "Bash", text, projectRoot)
    ) {
      status = "ask";
    } else if (matchesAnyRule(permissions.allow, "Bash", text, projectRoot)) {
      // Allowed by pattern, but check for file redirects — a command that
      // writes to a file shouldn't be silently approved just because the
      // base command is allowed (e.g., echo * shouldn't auto-allow echo > file)
      const redirectTarget = fileRedirectTarget(text);
      status = redirectTarget ? "unknown" : "allow";
    } else if (
      segments.length > 1 &&
      (isShellSetupSegment(text) || isShellSetupSegment(normalizeCommand(text, projectRoot)))
    ) {
      status = "allow";
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
 * ANSI styling is applied via statusIcons for visual distinction.
 * pi's TUI uses visibleWidth() to measure, so escape codes are safe.
 */
function prefixedLines(
  display: string,
  icon: string,
  suffix: string,
  color: string = "",
  indent: number = 0,
): string[] {
  const pad = "  ".repeat(indent);
  const subLines = display.split("\n").map((l) => l.trim()).filter(Boolean);
  return subLines.map((line, i) => {
    const s = i === subLines.length - 1 ? suffix : "";
    if (color) {
      return `  ${color}${icon} ${pad}${line}${s}${RESET}`;
    }
    return `  ${icon} ${pad}${line}${s}`;
  });
}

// Keywords that increase nesting AFTER the line
const INDENT_AFTER = /^\s*(for\b|while\b|until\b|if\b|case\b|do\b|then\b|else\b|elif\b)/;
// Keywords that decrease nesting BEFORE the line
const DEDENT_BEFORE = /^\s*(done|fi|esac|else|elif|do|then)\s*$/;

/** Compute indentation level for each segment in a multi-line script. */
function computeIndents(segments: { text: string }[]): number[] {
  const indents: number[] = [];
  let level = 0;
  for (const seg of segments) {
    const trimmed = seg.text.trim();
    if (DEDENT_BEFORE.test(trimmed)) level = Math.max(0, level - 1);
    indents.push(level);
    if (INDENT_AFTER.test(trimmed)) level++;
  }
  return indents;
}

/**
 * Build the display string for a bash approval prompt.
 * Shows each segment on its own line with a status icon.
 */
export function formatBashPrompt(
  command: string,
  permissions: Permissions,
  projectRoot?: string,
): string {
  const annotated = classifySegments(command, permissions, projectRoot);

  // Single segment — simple display
  if (annotated.length === 1) {
    const seg = annotated[0];
    const icon = statusIcons[seg.status];
    const label = statusLabels[seg.status];
    const color = statusColors[seg.status];
    const redirect = seg.status !== "allow" ? fileRedirectTarget(seg.text) : null;
    const display = formatSegment(seg.text, MAX_TOTAL_DISPLAY);
    const suffix = redirect
      ? `  ${REDIRECT_LABEL}`
      : label ? `  ${label}` : "";
    return prefixedLines(display, icon, suffix, color).join("\n");
  }

  // Multiple segments — one per line with status and indentation
  const lines: string[] = [];
  let totalLen = 0;
  const indents = computeIndents(annotated);

  for (let idx = 0; idx < annotated.length; idx++) {
    const seg = annotated[idx];
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
    const color = statusColors[seg.status];
    lines.push(...prefixedLines(display, icon, suffix, color, indents[idx]));
    totalLen += display.length;
  }

  return lines.join("\n");
}

/**
 * Determine the overall reason label for a bash prompt based on
 * which segments triggered it.
 */
export function bashPromptLabel(command: string, permissions: Permissions, projectRoot?: string): string {
  const annotated = classifySegments(command, permissions, projectRoot);
  const hasAsk = annotated.some((s) => s.status === "ask");
  const hasDeny = annotated.some((s) => s.status === "deny");
  const hasUnknown = annotated.some((s) => s.status === "unknown");

  if (hasDeny) return "Bash command blocked";
  if (hasAsk && !hasUnknown) return "Bash command needs approval";
  if (hasUnknown && !hasAsk) return "Bash command needs approval";
  return "Bash command needs approval";
}
