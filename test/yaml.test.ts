import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { parseYaml, serializeYaml, mergeRuleIntoYaml, sortYamlPreservingComments, syncYamlWithPermissions } from "../src/yaml.js";
import { ruleComparator } from "../src/doctor/fixes.js";

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

describe("sortYamlPreservingComments", () => {
  test("sorts rules alphabetically, keeping sticky comments", () => {
    const yaml = `allow:
  # Zebra comment
  - "Bash(zebra *)"
  # Alpha comment
  - "Bash(alpha *)"
deny:
  []
ask:
  []
`;
    const sorted = sortYamlPreservingComments(yaml, (a, b) => a.localeCompare(b));
    const lines = sorted.split("\n");
    const alphaComment = lines.findIndex((l) => l.includes("Alpha comment"));
    const alphaRule = lines.findIndex((l) => l.includes("alpha"));
    const zebraComment = lines.findIndex((l) => l.includes("Zebra comment"));
    const zebraRule = lines.findIndex((l) => l.includes("zebra"));
    // Alpha should come before Zebra after sorting
    assert.ok(alphaRule < zebraRule, "alpha rule before zebra");
    // Each comment should stay directly above its rule
    assert.strictEqual(alphaComment, alphaRule - 1, "alpha comment sticky");
    assert.strictEqual(zebraComment, zebraRule - 1, "zebra comment sticky");
  });

  test("blank line + comment above first rule stays sticky to it", () => {
    const yaml = `allow:
  # Section header

  # Beta
  - "Bash(beta *)"
  # Alpha
  - "Bash(alpha *)"
deny:
  []
ask:
  []
`;
    const sorted = sortYamlPreservingComments(yaml, (a, b) => a.localeCompare(b));
    const lines = sorted.split("\n");
    // Alpha (with its comment) should come first, then beta (with its section header + blank + comment)
    const alphaComment = lines.findIndex((l) => l.includes("Alpha"));
    const alphaRule = lines.findIndex((l) => l.includes("alpha"));
    const betaRule = lines.findIndex((l) => l.includes("beta"));
    assert.strictEqual(alphaComment, alphaRule - 1, "alpha comment sticky");
    assert.ok(alphaRule < betaRule, "alpha before beta");
  });

  test("preserves file-level comments before sections", () => {
    const yaml = `# File comment\n\nallow:\n  - "Bash(echo *)"\ndeny:\n  []\nask:\n  []\n`;
    const sorted = sortYamlPreservingComments(yaml, (a, b) => a.localeCompare(b));
    assert.ok(sorted.startsWith("# File comment"));
  });

  test("preserves systemPrompt block untouched", () => {
    const yaml = `allow:
  - "Bash(echo *)"
deny:
  []
ask:
  []
systemPrompt: |
  ## Restrictions
  Do not run rm.
`;
    const sorted = sortYamlPreservingComments(yaml, (a, b) => a.localeCompare(b));
    assert.ok(sorted.includes("systemPrompt: |"));
    assert.ok(sorted.includes("## Restrictions"));
    assert.ok(sorted.includes("Do not run rm."));
  });

  test("sorts across multiple sections independently", () => {
    const yaml = `allow:
  - "Bash(grep *)"
  - "Bash(echo *)"
deny:
  - "Bash(sudo *)"
  - "Bash(rm -rf *)"
ask:
  - "Bash(make *)"
  - "Bash(curl *)"
`;
    const sorted = sortYamlPreservingComments(yaml, (a, b) => a.localeCompare(b));
    const lines = sorted.split("\n");
    // allow: echo before grep
    const echoIdx = lines.findIndex((l) => l.includes("echo"));
    const grepIdx = lines.findIndex((l) => l.includes("grep"));
    assert.ok(echoIdx < grepIdx);
    // deny: rm before sudo
    const rmIdx = lines.findIndex((l) => l.includes("rm -rf"));
    const sudoIdx = lines.findIndex((l) => l.includes("sudo"));
    assert.ok(rmIdx < sudoIdx);
    // ask: curl before make
    const curlIdx = lines.findIndex((l) => l.includes("curl"));
    const makeIdx = lines.findIndex((l) => l.includes("make"));
    assert.ok(curlIdx < makeIdx);
  });

  test("works with ruleComparator (type grouping)", () => {
    const yaml = `allow:
  # Shell
  - "Bash(echo *)"
  # Files
  - "Read(path:**)"
  # Modify
  - "Modify(path:src/**)"
deny:
  []
ask:
  []
`;
    const sorted = sortYamlPreservingComments(yaml, ruleComparator);
    const lines = sorted.split("\n");
    const readIdx = lines.findIndex((l) => l.includes("Read(path:**)"));
    const modifyIdx = lines.findIndex((l) => l.includes("Modify"));
    const bashIdx = lines.findIndex((l) => l.includes("Bash(echo"));
    // ruleComparator groups: Read(0) < Modify(via Write/Edit?) < Bash(3)
    assert.ok(readIdx < bashIdx, "Read before Bash");
  });

  test("multi-line comment block stays with rule", () => {
    const yaml = `allow:
  # First line of comment
  # Second line of comment
  - "Bash(zebra *)"
  # Single comment
  - "Bash(alpha *)"
deny:
  []
ask:
  []
`;
    const sorted = sortYamlPreservingComments(yaml, (a, b) => a.localeCompare(b));
    const lines = sorted.split("\n");
    const alphaIdx = lines.findIndex((l) => l.includes('"Bash(alpha'));
    const firstLineIdx = lines.findIndex((l) => l.includes("First line"));
    const secondLineIdx = lines.findIndex((l) => l.includes("Second line"));
    const zebraIdx = lines.findIndex((l) => l.includes('"Bash(zebra'));
    // Multi-line comment stays with zebra
    assert.strictEqual(firstLineIdx, zebraIdx - 2);
    assert.strictEqual(secondLineIdx, zebraIdx - 1);
    // Alpha comes first
    assert.ok(alphaIdx < zebraIdx);
  });
});

describe("syncYamlWithPermissions", () => {
  test("removes rules not in permissions, keeps comments for remaining", () => {
    const yaml = `allow:
  # Keep this
  - "Bash(echo *)"
  # Remove this
  - "Bash(rm *)"
deny:
  []
ask:
  []
`;
    const result = syncYamlWithPermissions(yaml, {
      allow: ["Bash(echo *)"],
      deny: [],
      ask: [],
    });
    assert.ok(result.includes("Bash(echo *)"));
    assert.ok(result.includes("Keep this"));
    assert.ok(!result.includes("Bash(rm *)"));
    assert.ok(!result.includes("Remove this"));
  });

  test("adds new rules that are in permissions but not on disk", () => {
    const yaml = `allow:
  - "Bash(echo *)"
deny:
  []
ask:
  []
`;
    const result = syncYamlWithPermissions(yaml, {
      allow: ["Bash(echo *)", "Bash(grep *)"],
      deny: [],
      ask: [],
    });
    assert.ok(result.includes("Bash(echo *)"));
    assert.ok(result.includes("Bash(grep *)"));
  });

  test("preserves systemPrompt", () => {
    const yaml = `allow:
  - "Bash(echo *)"
deny:
  []
ask:
  []
systemPrompt: |
  ## Restrictions
  No rm.
`;
    const result = syncYamlWithPermissions(yaml, {
      allow: ["Bash(echo *)"],
      deny: [],
      ask: [],
    });
    assert.ok(result.includes("systemPrompt: |"));
    assert.ok(result.includes("## Restrictions"));
  });
});
