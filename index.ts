/**
 * 🐸 Hypnotoad — pi extension
 *
 * ALL GLORY TO THE HYPNOTOAD.
 *
 * Intercepts all tool calls (bash, read, write, edit) and checks them against
 * allow/deny/ask rules in permissions.yml (or .json).
 *
 * Priority: deny > ask > allow > dev mode > prompt user
 *
 * See README.md for pattern format, configuration, and usage.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { resolve, relative, join, dirname } from "node:path";

import type { Permissions, DevModeState } from "./src/types.js";
import { stripComments, stripCdPrefix, anySegmentHasFileRedirect, splitBashSegments, isShellSetupSegment } from "./src/parser.js";
import {
  matchesAnyRule,
  matchesBashRules,
  anySegmentMatchesBashRules,
  anySegmentMatchesBashRulesExcludingAllowed,
} from "./src/matcher.js";
import { suggestBashPattern, suggestFilePattern } from "./src/suggest.js";
import { formatBashPrompt } from "./src/prompt.js";
import { resolvePermissionsPath, loadPermissions, savePermissions } from "./src/permissions.js";
import { isDevModeBashAllowed, isFileUnderDevPath } from "./src/devmode.js";
import { runDoctor, applyFixes, sortRules, ruleComparator } from "./src/doctor/index.js";
import type { Finding } from "./src/doctor/index.js";

// --- Display helpers ---

/** Human-readable label for a doctor finding's action. */
function formatActionLabel(f: Finding): string {
  if (!f.action) return "(informational)";
  if (f.action === "sort") return "sort rules";
  if (f.action === "remove") return `remove from ${f.list}`;
  if (f.action.startsWith("move:")) {
    const target = f.action.slice(5);
    return `move from ${f.list} to ${target}`;
  }
  if (f.action.startsWith("consolidate:")) {
    const broad = f.action.slice("consolidate:".length);
    return `replace with ${broad} in ${f.list}`;
  }
  if (f.action.startsWith("replace:")) {
    const newRule = f.action.slice("replace:".length);
    return `replace with ${newRule} in ${f.list}`;
  }
  if (f.action.startsWith("split:")) {
    const spec = JSON.parse(f.action.slice("split:".length));
    const parts: string[] = [`remove from ${f.list}`];
    if (spec.allow?.length) parts.push(`add to allow: ${spec.allow.join(", ")}`);
    if (spec.ask?.length) parts.push(`add to ask: ${spec.ask.join(", ")}`);
    return parts.join(", ");
  }
  return f.action;
}

// --- Prompt helpers ---

type PromptResult = "always_allow" | "allow_once" | "deny_once" | "always_deny";

async function promptUser(
  ctx: any,
  icon: string,
  label: string,
  detail: string,
): Promise<PromptResult> {
  if (!ctx.hasUI) return "deny_once";
  const display = detail.length > 300 ? detail.slice(0, 297) + "..." : detail;
  const choice = await ctx.ui.select(
    `${icon} ${label}:\n\n${display}\n`,
    ["Always allow", "Allow once", "Deny once", "Always deny"],
  );
  switch (choice) {
    case "Always allow": return "always_allow";
    case "Allow once": return "allow_once";
    case "Always deny": return "always_deny";
    default: return "deny_once";
  }
}

async function promptAndPersist(
  ctx: any,
  icon: string,
  label: string,
  detail: string,
  toolType: string,
  suggestedPattern: string,
  permissions: Permissions,
  permissionsPath: string,
): Promise<boolean> {
  const result = await promptUser(ctx, icon, label, detail);

  if (result === "allow_once") return true;
  if (result === "deny_once") return false;

  const list = result === "always_allow" ? "allow" : "deny";
  const rulePrefix = toolType === "Bash" ? "Bash(" : `${toolType}(path:`;
  const ruleSuffix = ")";
  const defaultPattern = suggestedPattern;

  const editChoice = await ctx.ui.select(
    `Save as ${list} rule:\n\n  ${rulePrefix}${defaultPattern}${ruleSuffix}\n`,
    ["Confirm", "Edit", "Cancel (just this once)"],
  );

  if (editChoice === "Cancel (just this once)") {
    return result === "always_allow";
  }

  let finalPattern = defaultPattern;
  if (editChoice === "Edit") {
    const edited = await ctx.ui.editor(
      `Edit ${list} pattern:`,
      `${rulePrefix}${defaultPattern}${ruleSuffix}`,
    );
    if (!edited || !edited.trim()) {
      return result === "always_allow";
    }
    const wrapped = edited.trim();
    const wrapMatch = wrapped.match(/^(Bash|Read|Write|Edit)\((?:path:)?(.+)\)$/);
    if (wrapMatch) {
      const fullRule = wrapped;
      if (!permissions[list].includes(fullRule)) {
        permissions[list].push(fullRule);
        savePermissions(permissionsPath, permissions);
      }
      return result === "always_allow";
    }
    finalPattern = wrapped;
  }

  const fullRule = `${rulePrefix}${finalPattern}${ruleSuffix}`;
  if (!permissions[list].includes(fullRule)) {
    permissions[list].push(fullRule);
    savePermissions(permissionsPath, permissions);
  }

  return result === "always_allow";
}

// --- File tool handler (shared logic for read/write/edit) ---

async function handleFileTool(
  toolType: "Read" | "Write" | "Edit",
  filePath: string,
  icon: string,
  permissions: Permissions,
  permissionsPath: string,
  devMode: DevModeState,
  projectRoot: string,
  ctx: any,
): Promise<{ block: true; reason: string } | undefined> {
  const abs = resolve(projectRoot, filePath);
  const rel = relative(projectRoot, abs);
  const matchPath = rel.startsWith("..") ? abs : rel;

  // Deny — immediate block
  if (matchesAnyRule(permissions.deny, toolType, matchPath)) {
    return { block: true, reason: `${toolType} blocked: ${filePath}` };
  }

  // Ask — always prompt (no remembering)
  if (matchesAnyRule(permissions.ask, toolType, matchPath)) {
    const allowed = await promptAndPersist(
      ctx, icon, `${toolType} needs approval`, filePath,
      toolType, suggestFilePattern(filePath, projectRoot),
      permissions, permissionsPath,
    );
    if (!allowed) return { block: true, reason: `${toolType} blocked: ${filePath}` };
    return undefined;
  }

  // Allow — pass silently
  if (matchesAnyRule(permissions.allow, toolType, matchPath)) return undefined;

  // Dev mode — auto-approve writes/edits under dev path
  if (toolType !== "Read" && devMode.active && isFileUnderDevPath(filePath, devMode, projectRoot)) {
    return undefined;
  }

  // No match — prompt
  const allowed = await promptAndPersist(
    ctx, icon, `${toolType} needs approval`, filePath,
    toolType, suggestFilePattern(filePath, projectRoot),
    permissions, permissionsPath,
  );
  if (!allowed) return { block: true, reason: `${toolType} blocked by user: ${filePath}` };
  return undefined;
}

// --- Extension entry point ---

export default function (pi: ExtensionAPI) {
  const projectRoot = process.cwd();
  const extensionDir = dirname(import.meta.url.replace("file://", ""));
  const defaultsPath = join(extensionDir, "defaults.yml");
  const permissionsPath = resolvePermissionsPath(projectRoot, defaultsPath);

  let permissions = loadPermissions(permissionsPath);
  const devMode: DevModeState = { active: false, path: "" };

  // --- System prompt injection ---

  pi.on("before_agent_start", async (event) => {
    if (!permissions.systemPrompt) return undefined;
    return {
      systemPrompt: event.systemPrompt + "\n\n" + permissions.systemPrompt,
    };
  });

  // --- Commands ---

  pi.registerCommand("hypnotoad", {
    description: "Manage permissions. Usage: /hypnotoad [reload|doctor|sort|devmode]",
    handler: async (args, ctx) => {
      const sub = args?.trim();

      if (sub?.startsWith("devmode")) {
        const devArgs = sub.slice(7).trim();
        if (devMode.active) {
          devMode.active = false;
          ctx.ui.notify("🔒 Dev mode OFF", "info");
          return;
        }
        devMode.path = devArgs
          ? resolve(projectRoot, devArgs)
          : projectRoot;
        devMode.active = true;
        ctx.ui.notify(
          `🔧 Dev mode ON — auto-approving edits & dev commands under:\n  ${devMode.path}\n\nGit commit/push/rebase/reset/merge still require approval.`,
          "info",
        );
        return;
      }

      if (sub === "reload") {
        permissions = loadPermissions(permissionsPath);
        ctx.ui.notify("Permissions reloaded from disk", "info");
        return;
      }

      if (sub === "sort") {
        permissions.allow = sortRules(permissions.allow);
        permissions.deny = sortRules(permissions.deny);
        permissions.ask = sortRules(permissions.ask);
        savePermissions(permissionsPath, permissions, { replace: true, sortFn: ruleComparator });
        ctx.ui.notify("Rules sorted and saved", "info");
        return;
      }

      if (sub === "doctor") {
        // Reload from disk so we operate on the latest state
        permissions = loadPermissions(permissionsPath);
        const findings = runDoctor(permissions, projectRoot);

        if (findings.length === 0) {
          ctx.ui.notify("✅ Permissions look good — no issues found", "info");
          return;
        }

        // Display findings
        const icons = { error: "❌", warning: "⚠️", info: "ℹ️" };
        const lines = findings.map((f, i) => {
          const icon = icons[f.severity];
          const ruleText = f.rule ? `  ${f.rule}` : "";
          const actionText = f.action && f.action !== "sort"
            ? ` [${f.action}]`
            : "";
          return `  ${i + 1}. ${icon} ${f.message}${ruleText}${actionText}`;
        });

        const display = [
          `🩺 Permissions doctor found ${findings.length} issue(s):`,
          "",
          ...lines,
        ].join("\n");

        const choice = await ctx.ui.select(
          `${display}\n`,
          ["Apply all fixes", "Review one by one", "Cancel"],
        );

        if (choice === "Cancel") return;

        const approved = new Set<number>();

        if (choice === "Apply all fixes") {
          findings.forEach((_, i) => approved.add(i));
        } else {
          // Review one by one
          for (let i = 0; i < findings.length; i++) {
            const f = findings[i];
            if (!f.action) continue; // no-action findings filtered by smarter checks
            const icon = icons[f.severity];
            const actionLabel = formatActionLabel(f);
            const desc = f.rule
              ? `${icon} ${f.message}\n  Rule: ${f.rule}\n  Action: ${actionLabel}`
              : `${icon} ${f.message}\n  Action: ${actionLabel}`;
            const keep = await ctx.ui.select(
              `${desc}\n`,
              ["Apply", "Skip", "Abort review"],
            );
            if (keep === "Apply") approved.add(i);
            if (keep === "Abort review") break;
          }
        }

        if (approved.size === 0) {
          ctx.ui.notify("No changes applied", "info");
          return;
        }

        const changeCount = applyFixes(permissions, findings, approved);
        savePermissions(permissionsPath, permissions, { replace: true, sortFn: ruleComparator });
        ctx.ui.notify(
          `✅ Applied ${changeCount} change(s) and saved to ${permissionsPath}`,
          "info",
        );
        return;
      }

      // Default: show rules
      const summary = [
        `📁 ${permissionsPath}`,
        "",
        `Allow (${permissions.allow.length} rules):`,
        ...permissions.allow.map((r) => `  ✓ ${r}`),
        "",
        `Deny (${permissions.deny.length} rules):`,
        ...permissions.deny.map((r) => `  ✗ ${r}`),
        "",
        `Ask (${permissions.ask.length} rules):`,
        ...permissions.ask.map((r) => `  ? ${r}`),
      ].join("\n");
      ctx.ui.notify(summary, "info");
    },
  });

  // --- Tool call handler ---

  pi.on("tool_call", async (event, ctx) => {
    // --- read ---
    if (isToolCallEventType("read", event)) {
      return handleFileTool("Read", event.input.path, "📖", permissions, permissionsPath, devMode, projectRoot, ctx);
    }

    // --- write ---
    if (isToolCallEventType("write", event)) {
      return handleFileTool("Write", event.input.path, "✏️", permissions, permissionsPath, devMode, projectRoot, ctx);
    }

    // --- edit ---
    if (isToolCallEventType("edit", event)) {
      return handleFileTool("Edit", (event.input as { path: string }).path, "✏️", permissions, permissionsPath, devMode, projectRoot, ctx);
    }

    // --- bash ---
    if (event.toolName === "bash") {
      const rawCommand = stripComments((event.input as { command: string }).command);
      const command = stripCdPrefix(rawCommand);

      // Shell syntax (​: , [ , true, false, cd, env assignments) — always allowed
      const segments = splitBashSegments(command);
      if (segments.every((seg) => isShellSetupSegment(seg))) {
        return undefined;
      }

      // Deny — any segment matching deny blocks the whole command
      if (anySegmentMatchesBashRules(permissions.deny, command, projectRoot)) {
        return { block: true, reason: "Blocked: dangerous command pattern" };
      }

      // Ask — any segment matching ask forces a prompt, UNLESS that segment
      // also matches an allow rule (specific allow overrides broad ask)
      if (anySegmentMatchesBashRulesExcludingAllowed(permissions.ask, permissions.allow, command, projectRoot)) {
        if (!ctx.hasUI) return { block: true, reason: "Blocked: no UI for approval" };
        const display = formatBashPrompt(command, permissions, projectRoot);
        const choice = await ctx.ui.select(
          `🔔 Bash command needs approval:\n\n${display}\n`,
          ["Allow", "Block"],
        );
        if (choice !== "Allow") return { block: true, reason: "Blocked by user" };
        return undefined;
      }

      // Allow — all segments must match AND no segment writes to a file
      if (matchesBashRules(permissions.allow, command, projectRoot) && !anySegmentHasFileRedirect(command)) {
        return undefined;
      }

      // Dev mode override
      if (devMode.active && isDevModeBashAllowed(command, permissions.allow)) return undefined;

      // No match — 4-choice prompt with pattern suggestion
      const display = formatBashPrompt(command, permissions, projectRoot);
      const allowed = await promptAndPersist(
        ctx, "🐚", "Bash command needs approval", display,
        "Bash", suggestBashPattern(command),
        permissions, permissionsPath,
      );
      if (!allowed) return { block: true, reason: "Blocked by user" };
      return undefined;
    }

    return undefined;
  });
}
