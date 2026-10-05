/**
 * Permission file loading and persistence.
 *
 * YAML format with # comments for documenting rule intent.
 *
 * Resolution order:
 *   1. .pi/permissions.yml (project-level)
 *   2. ~/.pi/agent/permissions.yml (user-level, created from defaults on first run)
 */

import type { Permissions } from "./types.js";
import { parseYaml, serializeYaml, mergeRuleIntoYaml, syncYamlWithPermissions, sortYamlPreservingComments } from "./yaml.js";
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

const EMPTY: Permissions = { allow: [], deny: [], ask: [] };

const USER_PATH = join(homedir(), ".pi", "agent", "permissions.yml");

/** Resolve the permissions.yml path. */
export function resolvePermissionsPath(projectRoot: string, defaultsPath: string): string {
  // 1. Project-level
  const projectPath = join(projectRoot, ".pi", "permissions.yml");
  if (existsSync(projectPath)) return projectPath;

  // 2. User-level — create from defaults if missing
  if (existsSync(USER_PATH)) return USER_PATH;

  try {
    mkdirSync(dirname(USER_PATH), { recursive: true });
    copyFileSync(defaultsPath, USER_PATH);
  } catch {
    // Best effort
  }

  return USER_PATH;
}

/** Load permissions from disk. Returns empty permissions on any error. */
export function loadPermissions(path: string): Permissions {
  try {
    const raw = readFileSync(path, "utf-8");
    return parseYaml(raw);
  } catch {
    return { ...EMPTY };
  }
}

/**
 * Save permissions to disk.
 *
 * By default uses text-level merge to preserve YAML comments.
 * Pass `replace: true` to write the in-memory state exactly
 * (used after doctor sort/cleanup).
 */
/**
 * Save permissions to disk.
 *
 * - Default: text-level merge to preserve YAML comments.
 * - `replace: true`: full rewrite from in-memory state.
 * - `replace: true` + `sortFn`: rewrite preserving comments, sorting
 *   entries with their sticky comment blocks.
 */
export function savePermissions(
  path: string,
  permissions: Permissions,
  options?: { replace?: boolean; sortFn?: (a: string, b: string) => number },
): void {
  let merged = { ...permissions };

  if (!options?.replace) {
    try {
      const raw = readFileSync(path, "utf-8");
      const disk = parseYaml(raw);

      // Text-level merge to preserve comments
      let modified = raw;
      let changed = false;
      for (const list of ["allow", "deny", "ask"] as const) {
        for (const rule of permissions[list]) {
          if (!disk[list].includes(rule)) {
            const result = mergeRuleIntoYaml(modified, list, rule);
            if (result) {
              modified = result;
              changed = true;
            }
          }
        }
        const set = new Set([...disk[list], ...permissions[list]]);
        merged[list] = [...set];
      }

      if (changed) {
        writeFileSync(path, modified, "utf-8");
      }

      permissions.allow = merged.allow;
      permissions.deny = merged.deny;
      permissions.ask = merged.ask;
      return;
    } catch {
      // Fall through to full rewrite
    }
  }

  // Replace mode or merge fallback
  try {
    mkdirSync(dirname(path), { recursive: true });

    // If the file exists and a sort function is provided, sync the
    // in-memory state (removals/additions) into the raw text, then sort
    // preserving comments (each comment block stays with its rule).
    if (options?.sortFn && existsSync(path)) {
      const raw = readFileSync(path, "utf-8");
      const synced = syncYamlWithPermissions(raw, merged);
      const sorted = sortYamlPreservingComments(synced, options.sortFn);
      writeFileSync(path, sorted, "utf-8");
    } else {
      writeFileSync(path, serializeYaml(merged), "utf-8");
    }
  } catch {
    // Best effort
  }

  permissions.allow = merged.allow;
  permissions.deny = merged.deny;
  permissions.ask = merged.ask;
}
