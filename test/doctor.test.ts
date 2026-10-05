import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { runDoctor, applyFixes, sortRules } from "../src/doctor/index.js";
import type { Permissions } from "../src/types.js";

describe("sortRules", () => {
  test("groups by type: Read → Write → Edit → Bash", () => {
    const rules = [
      "Bash(echo *)",
      "Read(path:**)",
      "Edit(path:wiki/**)",
      "Write(path:src/**)",
    ];
    const sorted = sortRules(rules);
    assert.strictEqual(sorted[0], "Read(path:**)");
    assert.strictEqual(sorted[1], "Write(path:src/**)");
    assert.strictEqual(sorted[2], "Edit(path:wiki/**)");
    assert.strictEqual(sorted[3], "Bash(echo *)");
  });

  test("sorts alphabetically within type", () => {
    const rules = [
      "Bash(grep *)",
      "Bash(echo *)",
      "Bash(awk *)",
    ];
    const sorted = sortRules(rules);
    assert.deepStrictEqual(sorted, [
      "Bash(awk *)",
      "Bash(echo *)",
      "Bash(grep *)",
    ]);
  });

  test("mixed types and alphabetical", () => {
    const rules = [
      "Bash(tail *)",
      "Write(path:wiki/**)",
      "Bash(head *)",
      "Read(path:**)",
      "Edit(path:src/**)",
      "Write(path:logs/**)",
    ];
    const sorted = sortRules(rules);
    assert.deepStrictEqual(sorted, [
      "Read(path:**)",
      "Write(path:logs/**)",
      "Write(path:wiki/**)",
      "Edit(path:src/**)",
      "Bash(head *)",
      "Bash(tail *)",
    ]);
  });
});

describe("runDoctor", () => {
  test("clean permissions produce no findings except sorting", () => {
    const perms: Permissions = {
      allow: ["Bash(echo *)", "Bash(grep *)", "Read(path:**)"],
      deny: ["Bash(rm -rf *)", "Bash(sudo *)"],
      ask: ["Bash(git commit *)", "Bash(git push *)"],
    };
    const findings = runDoctor(perms);
    // May have sorting findings but no errors/warnings
    const serious = findings.filter(f => f.severity !== "info");
    assert.strictEqual(serious.length, 0);
  });

  test("detects Write(path:**) as overly broad", () => {
    const perms: Permissions = {
      allow: ["Write(path:**)"],
      deny: [],
      ask: [],
    };
    const findings = runDoctor(perms);
    assert.ok(findings.some(f => f.rule === "Write(path:**)" && f.severity === "warning"));
  });

  test("detects .ssh files in allow list", () => {
    const perms: Permissions = {
      allow: ["Write(path:**/.ssh/**)"],
      deny: [],
      ask: [],
    };
    const findings = runDoctor(perms);
    assert.ok(findings.some(f => f.rule === "Write(path:**/.ssh/**)" && f.action === "move:deny"));
  });

  test("detects malformed rules", () => {
    const perms: Permissions = {
      allow: ["invalid-rule"],
      deny: [],
      ask: [],
    };
    const findings = runDoctor(perms);
    assert.ok(findings.some(f => f.severity === "error" && f.message.includes("Malformed")));
  });

  test("detects duplicate rules", () => {
    const perms: Permissions = {
      allow: ["Bash(echo *)", "Bash(echo *)"],
      deny: [],
      ask: [],
    };
    const findings = runDoctor(perms);
    assert.ok(findings.some(f => f.message.includes("Duplicate")));
  });

  test("detects rule in both allow and deny", () => {
    const perms: Permissions = {
      allow: ["Bash(rm -rf *)"],
      deny: ["Bash(rm -rf *)"],
      ask: [],
    };
    const findings = runDoctor(perms);
    assert.ok(findings.some(f =>
      f.message.includes("allow AND deny") && f.list === "allow",
    ));
  });

  test("detects rule in both allow and ask", () => {
    const perms: Permissions = {
      allow: ["Bash(git push *)"],
      deny: [],
      ask: ["Bash(git push *)"],
    };
    const findings = runDoctor(perms);
    assert.ok(findings.some(f =>
      f.message.includes("allow AND ask") && f.list === "allow",
    ));
  });

  test("detects allow file rule shadowed by broader ask rule", () => {
    const perms: Permissions = {
      allow: ["Edit(path:.pi/extensions/hypnotoad/src/**)"],
      deny: [],
      ask: ["Edit(path:.pi/extensions/**)"],
    };
    const findings = runDoctor(perms);
    assert.ok(findings.some(f =>
      f.rule === "Edit(path:.pi/extensions/hypnotoad/src/**)" &&
      f.message.includes("shadowed") &&
      f.message.includes("allow list") &&
      f.action === "remove",
    ));
  });

  test("detects redundant subpath within same list", () => {
    const perms: Permissions = {
      allow: [
        "Edit(path:.pi/extensions/permission-gate/**)",
        "Edit(path:.pi/extensions/permission-gate/test/**)",
      ],
      deny: [],
      ask: [],
    };
    const findings = runDoctor(perms);
    assert.ok(findings.some(f =>
      f.rule === "Edit(path:.pi/extensions/permission-gate/test/**)" &&
      f.message.includes("Redundant"),
    ));
  });

  test("suggests consolidation when 3+ rules share a parent", () => {
    const perms: Permissions = {
      allow: [
        "Write(path:src/ols/project-a/**)",
        "Write(path:src/ols/project-b/**)",
        "Write(path:src/ols/project-c/**)",
      ],
      deny: [],
      ask: [],
    };
    const findings = runDoctor(perms);
    assert.ok(findings.some(f =>
      f.message.includes("consolidate to Write(path:src/**)") &&
      f.action === "consolidate:Write(path:src/**)",
    ));
  });

  test("no consolidation for deny list (surgical rules)", () => {
    const perms: Permissions = {
      allow: [],
      deny: [
        "Read(path:~/.bash_profile)",
        "Read(path:~/.bashrc)",
        "Read(path:~/.profile)",
      ],
      ask: [],
    };
    const findings = runDoctor(perms);
    assert.ok(!findings.some(f => f.action?.startsWith("consolidate:")));
  });

  test("no consolidation when broad rule already exists", () => {
    const perms: Permissions = {
      allow: [
        "Write(path:src/**)",
        "Write(path:src/ols/project-a/**)",
        "Write(path:src/ols/project-b/**)",
        "Write(path:src/ols/project-c/**)",
      ],
      deny: [],
      ask: [],
    };
    const findings = runDoctor(perms);
    assert.ok(!findings.some(f => f.action?.startsWith("consolidate:")));
  });

  test("carve-exception: safe with brace-expanded subcommands", () => {
    const perms: Permissions = {
      allow: ["Bash(tool sub {inspect,top} *)"],
      deny: [],
      ask: ["Bash(tool sub *)"],
    };
    const findings = runDoctor(perms);
    assert.ok(!findings.some(f =>
      f.rule === "Bash(tool sub {inspect,top} *)" && f.message.includes("risky"),
    ));
  });

  test("dead paths: skips brace patterns", () => {
    const perms: Permissions = {
      allow: ["Write(path:{.pi/skills,logs/slack,src}/**)"],
      deny: [],
      ask: [],
    };
    const findings = runDoctor(perms, process.cwd());
    assert.ok(!findings.some(f =>
      f.message.includes("does not exist") && f.rule.includes("{"),
    ));
  });

  test("carve-exception: safe when allow has more fixed segments", () => {
    const perms: Permissions = {
      allow: ["Bash(tool sub1 sub2 *)"],
      deny: [],
      ask: ["Bash(tool *)"],
    };
    const findings = runDoctor(perms);
    assert.ok(!findings.some(f =>
      f.rule === "Bash(tool sub1 sub2 *)" && f.message.includes("risky"),
    ));
  });

  test("carve-exception: safe when allow has filesystem path", () => {
    const perms: Permissions = {
      allow: ["Bash(tool scripts/run.sh)"],
      deny: [],
      ask: ["Bash(tool *)"],
    };
    const findings = runDoctor(perms);
    assert.ok(!findings.some(f =>
      f.rule === "Bash(tool scripts/run.sh)" && f.message.includes("risky"),
    ));
  });

  test("carve-exception: risky when allow is broader than ask", () => {
    const perms: Permissions = {
      allow: ["Bash(tool *)"],
      deny: [],
      ask: ["Bash(tool sub *)"],
    };
    const findings = runDoctor(perms);
    assert.ok(findings.some(f =>
      f.rule === "Bash(tool *)" &&
      f.message.includes("risky exception") &&
      f.action === "remove",
    ));
  });

  test("carve-exception: no false positive for unrelated commands", () => {
    const perms: Permissions = {
      allow: ["Bash(echo *)"],
      deny: [],
      ask: ["Bash(tool *)"],
    };
    const findings = runDoctor(perms);
    assert.ok(!findings.some(f =>
      f.rule === "Bash(echo *)" && f.message.includes("risky"),
    ));
  });

  test("detects dead file paths", () => {
    const perms: Permissions = {
      allow: ["Edit(path:nonexistent/folder/**)"],
      deny: [],
      ask: [],
    };
    const findings = runDoctor(perms, process.cwd());
    assert.ok(findings.some(f =>
      f.rule === "Edit(path:nonexistent/folder/**)" &&
      f.message.includes("does not exist") &&
      f.action === "remove",
    ));
  });

  test("does not flag existing paths as dead", () => {
    const perms: Permissions = {
      allow: ["Edit(path:src/**)"],
      deny: [],
      ask: [],
    };
    const findings = runDoctor(perms, process.cwd());
    assert.ok(!findings.some(f =>
      f.rule === "Edit(path:src/**)" && f.message.includes("does not exist"),
    ));
  });

  test("no shadowing false positive for different tool types", () => {
    const perms: Permissions = {
      allow: ["Write(path:.pi/extensions/foo/**)"],
      deny: [],
      ask: ["Edit(path:.pi/extensions/**)"],
    };
    const findings = runDoctor(perms);
    assert.ok(!findings.some(f =>
      f.rule === "Write(path:.pi/extensions/foo/**)" && f.message.includes("Shadowed"),
    ));
  });

  test("flags absolute home paths and suggests ~ replacement", () => {
    const home = require("node:os").homedir();
    const perms: Permissions = {
      allow: [],
      deny: [`Read(path:${home}/.bashrc)`],
      ask: [],
    };
    const findings = runDoctor(perms);
    assert.ok(findings.some(f =>
      f.rule === `Read(path:${home}/.bashrc)` &&
      f.message.includes("~") &&
      f.action === "replace:Read(path:~/.bashrc)",
    ));
  });

  test("does not flag dead paths in deny list", () => {
    const perms: Permissions = {
      allow: [],
      deny: ["Read(path:~/.profile)"],
      ask: [],
    };
    const findings = runDoctor(perms);
    assert.ok(!findings.some(f =>
      f.message.includes("does not exist"),
    ));
  });

  test("does not flag glob patterns as dead paths", () => {
    const perms: Permissions = {
      allow: [],
      deny: ["Write(path:**/.env.*)"],
      ask: [],
    };
    const findings = runDoctor(perms);
    assert.ok(!findings.some(f =>
      f.message.includes("does not exist"),
    ));
  });

  test("detects unsorted lists", () => {
    const perms: Permissions = {
      allow: ["Bash(grep *)", "Bash(echo *)"],
      deny: [],
      ask: [],
    };
    const findings = runDoctor(perms);
    assert.ok(findings.some(f => f.action === "sort"));
  });

});

describe("applyFixes", () => {
  test("removes a rule", () => {
    const perms: Permissions = {
      allow: ["Bash(echo *)", "Bash(echo *)"],
      deny: [],
      ask: [],
    };
    const findings = runDoctor(perms);
    const dupIdx = findings.findIndex(f => f.message.includes("Duplicate"));
    assert.ok(dupIdx >= 0);
    applyFixes(perms, findings, new Set([dupIdx]));
    assert.strictEqual(perms.allow.filter(r => r === "Bash(echo *)").length, 1);
  });

  test("moves a rule from allow to deny", () => {
    const perms: Permissions = {
      allow: ["Write(path:**/.ssh/id_rsa)", "Bash(echo *)"],
      deny: [],
      ask: [],
    };
    const findings = runDoctor(perms);
    const idx = findings.findIndex(f => f.rule === "Write(path:**/.ssh/id_rsa)" && f.action === "move:deny");
    assert.ok(idx >= 0);
    applyFixes(perms, findings, new Set([idx]));
    assert.ok(!perms.allow.includes("Write(path:**/.ssh/id_rsa)"));
    assert.ok(perms.deny.includes("Write(path:**/.ssh/id_rsa)"));
  });

  test("moves a rule from allow to ask", () => {
    const perms: Permissions = {
      allow: ["Write(path:**)", "Bash(echo *)"],
      deny: [],
      ask: [],
    };
    const findings = runDoctor(perms);
    const idx = findings.findIndex(f => f.rule === "Write(path:**)" && f.action === "move:ask");
    assert.ok(idx >= 0);
    applyFixes(perms, findings, new Set([idx]));
    assert.ok(!perms.allow.includes("Write(path:**)"));
    assert.ok(perms.ask.includes("Write(path:**)"));
  });

  test("sorts all lists after applying fixes", () => {
    const perms: Permissions = {
      allow: ["Bash(grep *)", "Bash(echo *)", "Write(path:**/.ssh/config)"],
      deny: [],
      ask: [],
    };
    const findings = runDoctor(perms);
    const allIdxs = new Set(findings.map((_, i) => i));
    applyFixes(perms, findings, allIdxs);
    // After moving .ssh to deny, allow should be sorted
    assert.deepStrictEqual(perms.allow, ["Bash(echo *)", "Bash(grep *)"]);
  });

  test("applies replace: swaps absolute home path for ~ version", () => {
    const home = require("node:os").homedir();
    const perms: Permissions = {
      allow: [],
      deny: [`Read(path:${home}/.bashrc)`],
      ask: [],
    };
    const findings = runDoctor(perms);
    const replaceIdx = findings.findIndex(f => f.action?.startsWith("replace:"));
    assert.ok(replaceIdx >= 0);
    applyFixes(perms, findings, new Set([replaceIdx]));
    assert.ok(!perms.deny.includes(`Read(path:${home}/.bashrc)`));
    assert.ok(perms.deny.includes("Read(path:~/.bashrc)"));
  });

  test("applies consolidation: removes individuals, adds broad rule", () => {
    const perms: Permissions = {
      allow: [
        "Write(path:src/ols/project-a/**)",
        "Write(path:src/ols/project-b/**)",
        "Write(path:src/ols/project-c/**)",
      ],
      deny: [],
      ask: [],
    };
    const findings = runDoctor(perms);
    const consolIdx = findings.findIndex(f => f.action?.startsWith("consolidate:"));
    assert.ok(consolIdx >= 0);
    applyFixes(perms, findings, new Set([consolIdx]));
    assert.ok(perms.allow.includes("Write(path:src/**)"));
    assert.ok(!perms.allow.includes("Write(path:src/ols/project-a/**)"));
    assert.ok(!perms.allow.includes("Write(path:src/ols/project-b/**)"));
    assert.ok(!perms.allow.includes("Write(path:src/ols/project-c/**)"));
  });

  test("no changes when nothing approved", () => {
    const perms: Permissions = {
      allow: ["Bash(sudo *)"],
      deny: [],
      ask: [],
    };
    const findings = runDoctor(perms);
    const changes = applyFixes(perms, findings, new Set());
    assert.strictEqual(changes, 0);
    assert.ok(perms.allow.includes("Bash(sudo *)"));
  });
});
