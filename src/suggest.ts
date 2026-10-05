/**
 * Pattern suggestion for "always allow/deny" decisions.
 *
 * Suggests glob patterns based on the command structure:
 * - Tools with subcommands (git, docker, etc.): `tool subcommand *`
 * - Other commands: `tool *`
 * - File paths: directory wildcard or specific path
 */

import { splitBashSegments } from "./parser.js";
import { normalizeCommand } from "./normalizer.js";
import { dirname, resolve, relative } from "node:path";

const knownSubcommandTools = [
  "git", "docker", "kubectl", "oc", "npm", "cargo", "go",
  "gog", "gh", "podman", "helm", "acli",
];

/** Suggest a bash pattern for the first unknown segment of a command. */
export function suggestBashPattern(command: string): string {
  const seg = findFirstUnknownSegment(command) || command.trim();
  const normalized = normalizeCommand(seg);
  const parts = normalized.split(/\s+/);

  if (parts.length <= 1) return normalized;

  if (knownSubcommandTools.includes(parts[0]) && parts.length > 2) {
    return `${parts[0]} ${parts[1]} *`;
  }

  return `${parts[0]} *`;
}

/** Find the first segment that isn't a known-safe builtin. */
export function findFirstUnknownSegment(command: string): string | null {
  const segments = splitBashSegments(command);
  const safePrefixes = /^\s*(cd|export|set|source|\.|true|false|:)\b/;
  for (const seg of segments) {
    if (safePrefixes.test(seg)) continue;
    return seg;
  }
  return null;
}

/** Suggest a file path pattern (directory wildcard for project files, absolute for external). */
export function suggestFilePattern(filePath: string, projectRoot: string): string {
  const abs = resolve(projectRoot, filePath);
  const rel = relative(projectRoot, abs);
  if (rel.startsWith("..") || rel.startsWith("/")) {
    return abs;
  }
  const dir = dirname(rel);
  return dir === "." ? "*" : `${dir}/**`;
}
