import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { loadPermissions, savePermissions, resolvePermissionsPath } from "../src/permissions.js";
import { readFileSync, writeFileSync, unlinkSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function yml(...lines: string[]): string {
  return lines.join("\n");
}

describe("loadPermissions", () => {
  test("loads valid permissions file", () => {
    const path = join(tmpdir(), `test-perms-${Date.now()}.yml`);
    writeFileSync(path, yml(
      "allow:",
      '  - "Bash(echo *)"',
      "deny:",
      '  - "Bash(rm -rf *)"',
      "ask:",
      '  - "Bash(git push *)"',
      "systemPrompt: |",
      "  test prompt",
    ));
    const perms = loadPermissions(path);
    assert.deepStrictEqual(perms.allow, ["Bash(echo *)"]);
    assert.deepStrictEqual(perms.deny, ["Bash(rm -rf *)"]);
    assert.deepStrictEqual(perms.ask, ["Bash(git push *)"]);
    assert.strictEqual(perms.systemPrompt, "test prompt");
    unlinkSync(path);
  });

  test("returns empty on missing file", () => {
    const perms = loadPermissions("/nonexistent/path.yml");
    assert.deepStrictEqual(perms.allow, []);
    assert.deepStrictEqual(perms.deny, []);
    assert.deepStrictEqual(perms.ask, []);
  });

  test("returns empty on invalid content", () => {
    const path = join(tmpdir(), `test-perms-bad-${Date.now()}.yml`);
    writeFileSync(path, "not valid yaml content }{}{");
    const perms = loadPermissions(path);
    assert.deepStrictEqual(perms.allow, []);
    unlinkSync(path);
  });

  test("handles partial permissions (missing lists)", () => {
    const path = join(tmpdir(), `test-perms-partial-${Date.now()}.yml`);
    writeFileSync(path, yml("allow:", '  - "Bash(echo *)"'));
    const perms = loadPermissions(path);
    assert.deepStrictEqual(perms.allow, ["Bash(echo *)"]);
    assert.deepStrictEqual(perms.deny, []);
    assert.deepStrictEqual(perms.ask, []);
    unlinkSync(path);
  });
});

describe("resolvePermissionsPath", () => {
  test("uses project-level .pi/permissions.yml", () => {
    const dir = join(tmpdir(), `test-resolve-${Date.now()}`);
    const piDir = join(dir, ".pi");
    mkdirSync(piDir, { recursive: true });
    writeFileSync(join(piDir, "permissions.yml"), "allow:\n  []");
    try {
      const result = resolvePermissionsPath(dir, "/fake/defaults.yml");
      assert.strictEqual(result, join(piDir, "permissions.yml"));
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});

describe("savePermissions", () => {
  test("saves and can reload", () => {
    const path = join(tmpdir(), `test-perms-save-${Date.now()}.yml`);
    const perms = {
      allow: ["Bash(echo *)"],
      deny: ["Bash(rm -rf *)"],
      ask: [],
    };
    savePermissions(path, perms, { replace: true });
    const loaded = loadPermissions(path);
    assert.deepStrictEqual(loaded.allow, ["Bash(echo *)"]);
    assert.deepStrictEqual(loaded.deny, ["Bash(rm -rf *)"]);
    unlinkSync(path);
  });

  test("merge preserves comments and deduplicates", () => {
    const path = join(tmpdir(), `test-perms-merge-${Date.now()}.yml`);
    writeFileSync(path, yml(
      "allow:",
      "  # Read-only commands",
      '  - "Bash(echo *)"',
      '  - "Bash(grep *)"',
      "deny:",
      '  - "Bash(rm -rf *)"',
      "ask:",
      "  []",
    ));
    const perms = {
      allow: ["Bash(echo *)", "Bash(tail *)"],
      deny: [],
      ask: [],
    };
    savePermissions(path, perms);
    const raw = readFileSync(path, "utf-8");
    assert.ok(raw.includes("# Read-only commands"), "comment preserved");
    assert.ok(raw.includes("Bash(tail *)"), "new rule added");
    // No duplicate echo
    const loaded = loadPermissions(path);
    assert.strictEqual(loaded.allow.filter(r => r === "Bash(echo *)").length, 1);
    unlinkSync(path);
  });

  test("replace mode overwrites without merging", () => {
    const path = join(tmpdir(), `test-perms-replace-${Date.now()}.yml`);
    writeFileSync(path, yml(
      "allow:",
      '  - "Bash(echo *)"',
      '  - "Bash(grep *)"',
      "deny:",
      "  []",
      "ask:",
      "  []",
    ));
    const perms = {
      allow: ["Bash(tail *)"],
      deny: [],
      ask: [],
    };
    savePermissions(path, perms, { replace: true });
    const loaded = loadPermissions(path);
    assert.deepStrictEqual(loaded.allow, ["Bash(tail *)"]);
    unlinkSync(path);
  });

  test("preserves systemPrompt", () => {
    const path = join(tmpdir(), `test-perms-prompt-${Date.now()}.yml`);
    const perms = {
      allow: [],
      deny: [],
      ask: [],
      systemPrompt: "test prompt content",
    };
    savePermissions(path, perms, { replace: true });
    const loaded = loadPermissions(path);
    assert.strictEqual(loaded.systemPrompt, "test prompt content");
    unlinkSync(path);
  });

  test("replace + sortFn preserves comments and sorts", () => {
    const path = join(tmpdir(), `test-perms-sort-${Date.now()}.yml`);
    writeFileSync(path, yml(
      "allow:",
      "  # Zebra comment",
      '  - "Bash(zebra *)"',
      "  # Alpha comment",
      '  - "Bash(alpha *)"',
      "deny:",
      "  []",
      "ask:",
      "  []",
    ));
    const perms = {
      allow: ["Bash(zebra *)", "Bash(alpha *)"],
      deny: [],
      ask: [],
    };
    const sortFn = (a: string, b: string) => a.localeCompare(b);
    savePermissions(path, perms, { replace: true, sortFn });
    const raw = readFileSync(path, "utf-8");
    assert.ok(raw.includes("# Zebra comment"), "comment preserved");
    assert.ok(raw.includes("# Alpha comment"), "comment preserved");
    // Alpha should come before Zebra after sorting
    const alphaIdx = raw.indexOf("alpha");
    const zebraIdx = raw.indexOf("zebra");
    assert.ok(alphaIdx < zebraIdx, "sorted correctly");
    unlinkSync(path);
  });

  test("replace + sortFn syncs removals and additions", () => {
    const path = join(tmpdir(), `test-perms-sync-${Date.now()}.yml`);
    writeFileSync(path, yml(
      "allow:",
      "  # Keep this",
      '  - "Bash(echo *)"',
      "  # Remove this",
      '  - "Bash(old-tool *)"',
      "deny:",
      "  []",
      "ask:",
      "  []",
    ));
    const perms = {
      allow: ["Bash(echo *)", "Bash(new-tool *)"],
      deny: [],
      ask: [],
    };
    const sortFn = (a: string, b: string) => a.localeCompare(b);
    savePermissions(path, perms, { replace: true, sortFn });
    const raw = readFileSync(path, "utf-8");
    assert.ok(raw.includes("Bash(echo *)"), "kept rule present");
    assert.ok(raw.includes("# Keep this"), "kept comment present");
    assert.ok(!raw.includes("old-tool"), "removed rule gone");
    assert.ok(!raw.includes("Remove this"), "removed comment gone");
    assert.ok(raw.includes("Bash(new-tool *)"), "new rule added");
    unlinkSync(path);
  });

  test("replace without sortFn does plain serialize (no comments)", () => {
    const path = join(tmpdir(), `test-perms-nosort-${Date.now()}.yml`);
    writeFileSync(path, yml(
      "allow:",
      "  # A comment",
      '  - "Bash(echo *)"',
      "deny:",
      "  []",
      "ask:",
      "  []",
    ));
    const perms = {
      allow: ["Bash(echo *)"],
      deny: [],
      ask: [],
    };
    savePermissions(path, perms, { replace: true });
    const raw = readFileSync(path, "utf-8");
    assert.ok(!raw.includes("# A comment"), "comment not preserved without sortFn");
    unlinkSync(path);
  });
});
