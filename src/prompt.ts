/**
 * Prompt formatting for tool call approval.
 *
 * Builds a readable, segment-annotated prompt for bash commands and
 * a simple path display for file operations.
 */

import { splitBashSegments, fileRedirectTarget, isShellSetupSegment } from "./parser.js";
import { matchesAnyRule, findMatchingRule } from "./matcher.js";
import { normalizeCommand } from "./normalizer.js";
import { stripBashScaffolding } from "./bash-normalizer.js";
import type { Permissions } from "./types.js";

const MAX_SEGMENT_DISPLAY = 300;
const MAX_TOTAL_DISPLAY = 1500;

type SegmentStatus = "allow" | "deny" | "ask" | "unknown";

interface AnnotatedSegment {
  text: string;
  status: SegmentStatus;
  /** The rule pattern that matched (for ask/deny display). */
  matchedRule?: string;
  /** The scaffolding prefix stripped during normalization (shown dimmed). */
  scaffolding?: string;
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

const DIM = "\x1b[2m";

const REDIRECT_LABEL = "(writes to file)";

/** Build a human-readable suffix showing which rule matched. */
function ruleSuffix(seg: AnnotatedSegment): string {
  if (!seg.matchedRule) return "";
  // Extract the pattern from "Bash(make *)" → "make *"
  const inner = seg.matchedRule.match(/^\w+\((.+)\)$/);
  const pattern = inner ? inner[1] : seg.matchedRule;
  return `  (${seg.status}: ${pattern})`;
}

/** Classify each segment of a bash command against the permission rules. */
export function classifySegments(command: string, permissions: Permissions, projectRoot?: string): AnnotatedSegment[] {
  const segments = splitBashSegments(command);
  return segments.map((text) => {
    let status: SegmentStatus = "unknown";
    let matchedRule: string | undefined;
    if (matchesAnyRule(permissions.deny, "Bash", text, projectRoot)) {
      status = "deny";
      matchedRule = findMatchingRule(permissions.deny, "Bash", text, projectRoot) ?? undefined;
    } else if (
      matchesAnyRule(permissions.ask, "Bash", text, projectRoot) &&
      !matchesAnyRule(permissions.allow, "Bash", text, projectRoot)
    ) {
      status = "ask";
      matchedRule = findMatchingRule(permissions.ask, "Bash", text, projectRoot) ?? undefined;
    } else if (matchesAnyRule(permissions.allow, "Bash", text, projectRoot)) {
      const redirectTarget = fileRedirectTarget(text);
      status = redirectTarget ? "unknown" : "allow";
    } else if (
      segments.length > 1 &&
      (isShellSetupSegment(text) || isShellSetupSegment(normalizeCommand(text, projectRoot)))
    ) {
      status = "allow";
    }

    // Detect scaffolding prefix (env vars, !, keywords) that was stripped
    let scaffolding: string | undefined;
    const normalized = stripBashScaffolding(text);
    if (normalized !== text.trim() && normalized.length > 0) {
      const idx = text.indexOf(normalized);
      if (idx > 0) scaffolding = text.slice(0, idx);
    }

    return { text, status, matchedRule, scaffolding };
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
 * Turn a possibly multi-line display string into one or more plain-text lines.
 * The first line gets the segment icon; continuation lines (e.g. from a
 * multi-line git commit message) are indented to align with the first line's
 * text, without repeating the icon.
 * The suffix (label) is appended only to the last sub-line.
 */
interface PrefixedLineOpts {
  display: string;
  icon: string;
  suffix: string;
  color?: string;
  indent?: number;
  /** Scaffolding prefix shown dimmed before the real command. */
  scaffolding?: string;
}

function prefixedLines(opts: PrefixedLineOpts): string[] {
  const { display, icon, suffix, color = "", indent = 0, scaffolding } = opts;
  const pad = "  ".repeat(indent);
  // Preserve original indentation — only trim the first line
  const rawLines = display.split("\n");
  const firstLine = rawLines[0]?.trim() ?? "";
  // Continuation lines: keep original whitespace for code blocks
  const contLines = rawLines.slice(1).filter((l) => l.trim().length > 0);
  const allLines = [firstLine, ...contLines];
  // "  ? " = 4 chars; continuation lines get the same left margin
  const continuationPad = "    " + pad;

  // If there's scaffolding, split the first line into dimmed prefix + colored command
  let scaffoldingPrefix = "";
  let commandText = firstLine;
  if (scaffolding && firstLine.startsWith(scaffolding.trim())) {
    scaffoldingPrefix = scaffolding.trim() + " ";
    commandText = firstLine.slice(scaffoldingPrefix.length);
  }

  return allLines.map((line, i) => {
    const s = i === allLines.length - 1 ? suffix : "";
    if (i === 0) {
      if (scaffoldingPrefix && color) {
        return `  ${color}${icon} ${pad}${RESET}${DIM}${scaffoldingPrefix}${RESET}${color}${commandText}${s}${RESET}`;
      }
      if (color) return `  ${color}${icon} ${pad}${firstLine}${s}${RESET}`;
      return `  ${icon} ${pad}${firstLine}${s}`;
    }
    // Continuation: preserve original whitespace
    if (color) return `  ${color}${continuationPad}${line}${s}${RESET}`;
    return `  ${continuationPad}${line}${s}`;
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
    const color = statusColors[seg.status];
    const redirect = seg.status !== "allow" ? fileRedirectTarget(seg.text) : null;
    const display = formatSegment(seg.text, MAX_TOTAL_DISPLAY);
    const suffix = redirect
      ? `  ${REDIRECT_LABEL}`
      : ruleSuffix(seg);
    return prefixedLines({ display, icon, suffix, color, scaffolding: seg.scaffolding }).join("\n");
  }

  // Multiple segments — one per line with status and indentation.
  // Non-allow segments (the ones the user needs to review) get priority
  // in the display budget so they're never truncated by long allow segments.
  const indents = computeIndents(annotated);

  // Reserve budget for non-allow segments first
  const nonAllowBudget = annotated
    .filter((s) => s.status !== "allow")
    .reduce((sum, s) => sum + Math.min(s.text.length, MAX_SEGMENT_DISPLAY), 0);
  const allowBudget = Math.max(300, MAX_TOTAL_DISPLAY - nonAllowBudget);

  const lines: string[] = [];
  let allowLen = 0;
  let nonAllowLen = 0;

  for (let idx = 0; idx < annotated.length; idx++) {
    const seg = annotated[idx];
    const icon = statusIcons[seg.status];
    const isAllow = seg.status === "allow";

    // Allow segments share a capped budget; non-allow segments get full space
    let budget: number;
    if (isAllow) {
      budget = Math.min(MAX_SEGMENT_DISPLAY, allowBudget - allowLen);
    } else {
      budget = Math.min(MAX_SEGMENT_DISPLAY, MAX_TOTAL_DISPLAY - nonAllowLen);
    }

    if (budget <= 20) {
      if (!isAllow) lines.push("  ...");
      continue;
    }

    const display = formatSegment(seg.text, budget);
    const redirect = seg.status !== "allow" ? fileRedirectTarget(seg.text) : null;
    const suffix = redirect
      ? `  ${REDIRECT_LABEL}`
      : ruleSuffix(seg);
    const color = statusColors[seg.status];
    lines.push(...prefixedLines({ display, icon, suffix, color, indent: indents[idx], scaffolding: seg.scaffolding }));

    if (isAllow) allowLen += display.length;
    else nonAllowLen += display.length;
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
