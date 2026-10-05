import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { parseYaml, serializeYaml, mergeRuleIntoYaml } from "../src/yaml.js";

describe("parseYaml", () => {
  test("parses simple lists", () => {
    const yaml = `
allow:
  - "Bash(echo *)"
  - "Bash(grep *)"
deny:
  - "Bash(rm -rf *)"
ask:
  - "Bash(git push *)"
`;
    const perms = parseYaml(yaml);
    assert.deepStrictEqual(perms.allow, ["Bash(echo *)", "Bash(grep *)"]);
    assert.deepStrictEqual(perms.deny, ["Bash(rm -rf *)"]);
    assert.deepStrictEqual(perms.ask, ["Bash(git push *)"]);
  });

  test("ignores comments", () => {
    const yaml = `
allow:
  # Read-only commands
  - "Bash(echo *)"
  # Text processing
  - "Bash(grep *)"
deny:
  - "Bash(rm -rf *)"
ask:
  - "Bash(git push *)"
`;
    const perms = parseYaml(yaml);
    assert.deepStrictEqual(perms.allow, ["Bash(echo *)", "Bash(grep *)"]);
  });

  test("handles empty lists", () => {
    const yaml = `
allow:
  - "Bash(echo *)"
deny:
  []
ask:
  []
`;
    const perms = parseYaml(yaml);
    assert.deepStrictEqual(perms.allow, ["Bash(echo *)"]);
    assert.deepStrictEqual(perms.deny, []);
    assert.deepStrictEqual(perms.ask, []);
  });

  test("parses block scalar systemPrompt", () => {
    const yaml = `
allow:
  - "Bash(echo *)"
deny:
  []
ask:
  []
systemPrompt: |
  ## Restrictions
  Do not run rm -rf.
  Do not run sudo.
`;
    const perms = parseYaml(yaml);
    assert.ok(perms.systemPrompt?.includes("## Restrictions"));
    assert.ok(perms.systemPrompt?.includes("Do not run rm -rf."));
  });

  test("handles unquoted values", () => {
    const yaml = `
allow:
  - Bash(echo *)
deny:
  []
ask:
  []
`;
    const perms = parseYaml(yaml);
    assert.deepStrictEqual(perms.allow, ["Bash(echo *)"]);
  });

  test("handles single-quoted values", () => {
    const yaml = `
allow:
  - 'Bash(echo *)'
deny:
  []
ask:
  []
`;
    const perms = parseYaml(yaml);
    assert.deepStrictEqual(perms.allow, ["Bash(echo *)"]);
  });

  test("handles brace patterns in values", () => {
    const yaml = `
allow:
  - "Bash(git {blame,diff,log} *)"
deny:
  []
ask:
  []
`;
    const perms = parseYaml(yaml);
    assert.deepStrictEqual(perms.allow, ["Bash(git {blame,diff,log} *)"]);
  });

  test("blank lines between groups are fine", () => {
    const yaml = `
allow:
  - "Bash(echo *)"

  - "Bash(grep *)"

deny:
  - "Bash(rm -rf *)"
ask:
  []
`;
    const perms = parseYaml(yaml);
    assert.deepStrictEqual(perms.allow, ["Bash(echo *)", "Bash(grep *)"]);
  });
});

describe("serializeYaml", () => {
  test("round-trips simple permissions", () => {
    const original = {
      allow: ["Bash(echo *)", "Bash(grep *)"],
      deny: ["Bash(rm -rf *)"],
      ask: ["Bash(git push *)"],
    };
    const yaml = serializeYaml(original);
    const parsed = parseYaml(yaml);
    assert.deepStrictEqual(parsed.allow, original.allow);
    assert.deepStrictEqual(parsed.deny, original.deny);
    assert.deepStrictEqual(parsed.ask, original.ask);
  });

  test("round-trips with systemPrompt", () => {
    const original = {
      allow: ["Bash(echo *)"],
      deny: [],
      ask: [],
      systemPrompt: "Line one\nLine two",
    };
    const yaml = serializeYaml(original);
    const parsed = parseYaml(yaml);
    assert.strictEqual(parsed.systemPrompt, original.systemPrompt);
  });

  test("serializes empty lists", () => {
    const yaml = serializeYaml({ allow: [], deny: [], ask: [] });
    assert.ok(yaml.includes("allow:"));
    assert.ok(yaml.includes("deny:"));
    assert.ok(yaml.includes("ask:"));
  });
});

describe("mergeRuleIntoYaml", () => {
  test("appends rule to section preserving comments", () => {
    const yaml = `allow:
  # Read-only
  - "Bash(echo *)"
  - "Bash(grep *)"

deny:
  - "Bash(rm -rf *)"
ask:
  []
`;
    const result = mergeRuleIntoYaml(yaml, "allow", "Bash(tail *)");
    assert.ok(result);
    assert.ok(result.includes('"Bash(tail *)"'));
    assert.ok(result.includes("# Read-only"));
    assert.ok(result.includes('"Bash(echo *)"'));
  });

  test("inserts near matching group (git rules together)", () => {
    const yaml = `allow:
  # Search
  - "Bash(grep *)"

  # Git read-only
  - "Bash(git diff *)"
  - "Bash(git log *)"

  # Build tools
  - "Bash(make *)"
ask:
  []
deny:
  []
`;
    const result = mergeRuleIntoYaml(yaml, "allow", "Bash(git stash drop *)");
    assert.ok(result);
    const lines = result!.split("\n");
    const gitLogIdx = lines.findIndex((l) => l.includes("git log"));
    const newRuleIdx = lines.findIndex((l) => l.includes("git stash drop"));
    const makeIdx = lines.findIndex((l) => l.includes("make"));
    // New git rule should be after git log but before make
    assert.ok(newRuleIdx > gitLogIdx, "after existing git rules");
    assert.ok(newRuleIdx < makeIdx, "before non-git rules");
  });

  test("inserts near matching group (file rules)", () => {
    const yaml = `allow:
  - "Modify(path:src/**)"
  - "Modify(path:wiki/**)"
  - "Bash(echo *)"
deny:
  []
ask:
  []
`;
    const result = mergeRuleIntoYaml(yaml, "allow", "Modify(path:src/pkg/**)");
    assert.ok(result);
    const lines = result!.split("\n");
    const srcIdx = lines.findIndex((l) => l.includes("Modify(path:src/**)"));
    const newIdx = lines.findIndex((l) => l.includes("Modify(path:src/pkg/**)"));
    const echoIdx = lines.findIndex((l) => l.includes("echo"));
    assert.ok(newIdx > srcIdx, "after existing src rule");
    assert.ok(newIdx < echoIdx, "before bash rules");
  });

  test("falls back to end of section when no group match", () => {
    const yaml = `allow:
  - "Bash(echo *)"
  - "Bash(grep *)"
deny:
  - "Bash(rm -rf *)"
ask:
  []
`;
    const result = mergeRuleIntoYaml(yaml, "allow", "Bash(completely-new-tool *)");
    assert.ok(result);
    const lines = result!.split("\n");
    const grepIdx = lines.findIndex((l) => l.includes("grep"));
    const newIdx = lines.findIndex((l) => l.includes("completely-new-tool"));
    assert.ok(newIdx > grepIdx);
  });

  test("appends to deny section", () => {
    const yaml = `allow:
  - "Bash(echo *)"
deny:
  - "Bash(rm -rf *)"
ask:
  - "Bash(git push *)"
`;
    const result = mergeRuleIntoYaml(yaml, "deny", "Bash(sudo *)");
    assert.ok(result);
    assert.ok(result.includes('"Bash(sudo *)"'));
    const lines = result.split("\n");
    const sudoIdx = lines.findIndex((l) => l.includes("Bash(sudo *)"));
    const askIdx = lines.findIndex((l) => l.trim() === "ask:");
    assert.ok(sudoIdx < askIdx);
  });

  test("returns null for missing section", () => {
    const result = mergeRuleIntoYaml("allow:\n  - 'x'\n", "deny", "y");
    assert.strictEqual(result, null);
  });
});
