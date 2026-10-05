import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  globToRegex,
  parseRule,
  matchesRule,
  matchesAnyRule,
  matchesBashRules,
  anySegmentMatchesBashRules,
  anySegmentMatchesBashRulesExcludingAllowed,
} from "../src/matcher.js";

describe("globToRegex", () => {
  test("literal match", () => {
    assert.ok(globToRegex("echo").test("echo"));
    assert.ok(!globToRegex("echo").test("echo hello"));
  });

  test("* matches anything", () => {
    assert.ok(globToRegex("echo *").test("echo hello"));
    assert.ok(globToRegex("echo *").test("echo hello world"));
  });

  test("trailing * is optional (bare command matches)", () => {
    assert.ok(globToRegex("sort *").test("sort"));
    assert.ok(globToRegex("sort *").test("sort -r"));
  });

  test("** matches across separators", () => {
    assert.ok(globToRegex("wiki/**").test("wiki/foo/bar.md"));
  });

  test("escapes regex special chars", () => {
    assert.ok(globToRegex("file.txt").test("file.txt"));
    assert.ok(!globToRegex("file.txt").test("fileTtxt"));
  });

  test("mid-pattern *", () => {
    assert.ok(globToRegex("git * --all").test("git fetch --all"));
    assert.ok(!globToRegex("git * --all").test("git fetch"));
  });
});

describe("parseRule", () => {
  test("parses Bash rule", () => {
    const r = parseRule("Bash(git push *)");
    assert.deepStrictEqual(r, { type: "Bash", pattern: "git push *" });
  });

  test("parses Read rule with path: prefix", () => {
    const r = parseRule("Read(path:wiki/**)");
    assert.deepStrictEqual(r, { type: "Read", pattern: "wiki/**" });
  });

  test("parses Write rule", () => {
    const r = parseRule("Write(path:src/**)");
    assert.deepStrictEqual(r, { type: "Write", pattern: "src/**" });
  });

  test("parses Edit rule", () => {
    const r = parseRule("Edit(path:*.ts)");
    assert.deepStrictEqual(r, { type: "Edit", pattern: "*.ts" });
  });

  test("returns null for invalid rule", () => {
    assert.strictEqual(parseRule("invalid"), null);
    assert.strictEqual(parseRule("Unknown(foo)"), null);
  });
});

describe("matchesRule", () => {
  test("bash command matches", () => {
    assert.ok(matchesRule("Bash(git status *)", "Bash", "git status --short"));
  });

  test("bash command does not match wrong pattern", () => {
    assert.ok(!matchesRule("Bash(git push *)", "Bash", "git status"));
  });

  test("bash normalizes before matching (env vars stripped)", () => {
    assert.ok(matchesRule("Bash(make *)", "Bash", "KUBECONFIG=/dev/null make test"));
  });

  test("bash normalizes before matching (git flags stripped)", () => {
    assert.ok(matchesRule("Bash(git fetch *)", "Bash", "git -C /path fetch --all"));
  });

  test("file rule matches with path: prefix", () => {
    assert.ok(matchesRule("Read(path:wiki/**)", "Read", "wiki/foo/bar.md"));
  });

  test("file rule strips ./", () => {
    assert.ok(matchesRule("Read(path:wiki/**)", "Read", "./wiki/foo.md"));
  });

  test("type mismatch returns false", () => {
    assert.ok(!matchesRule("Read(path:**)", "Write", "foo.txt"));
  });
});

describe("matchesAnyRule", () => {
  const rules = ["Bash(echo *)", "Bash(grep *)", "Bash(git status *)"];

  test("matches when any rule fits", () => {
    assert.ok(matchesAnyRule(rules, "Bash", "echo hello"));
  });

  test("no match returns false", () => {
    assert.ok(!matchesAnyRule(rules, "Bash", "rm -rf /"));
  });
});

describe("matchesBashRules", () => {
  const allow = [
    "Bash(gofmt *)", "Bash(make *)", "Bash(go test *)", "Bash(go run *)",
    "Bash(go vet *)", "Bash(git diff *)", "Bash(tail *)", "Bash(head *)",
    "Bash(echo *)", "Bash(grep *)", "Bash(git status)",
  ];

  test("single allowed command", () => {
    assert.ok(matchesBashRules(allow, "echo hello"));
  });

  test("all segments allowed", () => {
    assert.ok(matchesBashRules(allow, "echo a && grep foo | tail -5"));
  });

  test("fails when one segment is unknown", () => {
    assert.ok(!matchesBashRules(allow, "echo a && unknown-cmd"));
  });

  test("cd in chain is exempt", () => {
    assert.ok(matchesBashRules(allow, "gofmt -w file.go && cd /path && go test ./..."));
  });

  test("standalone cd is NOT exempt (not in a chain)", () => {
    assert.ok(!matchesBashRules(allow, "cd /path"));
  });

  test("set -o pipefail in chain is exempt", () => {
    assert.ok(matchesBashRules(allow, "set -o pipefail && go run tool ./cli 2>&1 | tail -28"));
  });

  test("export in chain is exempt", () => {
    assert.ok(matchesBashRules(allow, "export FOO=bar && make test"));
  });

  test("env var prefix is stripped before matching", () => {
    assert.ok(matchesBashRules(allow, "KUBECONFIG=/dev/null GOFLAGS=-race make test 2>&1 | tail -15"));
  });

  test("gofmt chain with env vars (real session)", () => {
    assert.ok(matchesBashRules(
      allow,
      "gofmt -w file.go && KUBECONFIG=/dev/null GOFLAGS=-race make test 2>&1 | tail -15",
    ));
  });

  test("gofmt + cd + set + go run chain (real session)", () => {
    assert.ok(matchesBashRules(
      allow,
      "gofmt -w file.go && cd src/project && set -o pipefail && go run tool ./cli 2>&1 | tail -28",
    ));
  });

  test("git -C flag normalized (real session)", () => {
    assert.ok(matchesBashRules(
      allow,
      "gofmt -w file.go && git -C src/project diff --check",
    ));
  });
});

describe("anySegmentMatchesBashRules", () => {
  const deny = ["Bash(rm -rf *)", "Bash(sudo *)"];

  test("detects denied segment in chain", () => {
    assert.ok(anySegmentMatchesBashRules(deny, "echo hello && sudo rm -rf /"));
  });

  test("no denied segments", () => {
    assert.ok(!anySegmentMatchesBashRules(deny, "echo hello && make test"));
  });

  test("deny with env var prefix", () => {
    assert.ok(anySegmentMatchesBashRules(deny, "FOO=bar sudo make install"));
  });
});

describe("anySegmentMatchesBashRulesExcludingAllowed", () => {
  const ask = ["Bash(python3 *)"];
  const allow = ["Bash(python3 .pi/skills/briefing/scripts/*)", "Bash(python3 -c *)"];

  test("returns true when ask matches but allow does not", () => {
    assert.ok(anySegmentMatchesBashRulesExcludingAllowed(
      ask, allow, "python3 some-random-script.py",
    ));
  });

  test("returns false when segment matches both ask and allow", () => {
    assert.ok(!anySegmentMatchesBashRulesExcludingAllowed(
      ask, allow, "python3 .pi/skills/briefing/scripts/accepted-events.py",
    ));
  });

  test("returns false when no ask match at all", () => {
    assert.ok(!anySegmentMatchesBashRulesExcludingAllowed(
      ask, allow, "echo hello",
    ));
  });

  test("handles chains: one segment ask-only, another allowed", () => {
    // python3 -c * matches both ask+allow → excluded
    // python3 unknown.py matches ask but not allow → triggers
    assert.ok(anySegmentMatchesBashRulesExcludingAllowed(
      ask, allow, 'python3 -c "print(1)" && python3 unknown.py',
    ));
  });

  test("handles chains: all segments have allow overrides", () => {
    assert.ok(!anySegmentMatchesBashRulesExcludingAllowed(
      ask, allow, 'python3 -c "print(1)" && python3 .pi/skills/briefing/scripts/foo.py',
    ));
  });

  test("brace expansion matches any alternative", () => {
    assert.ok(matchesRule("Bash(oc adm {inspect,top} *)", "Bash", "oc adm inspect node01"));
    assert.ok(matchesRule("Bash(oc adm {inspect,top} *)", "Bash", "oc adm top pods"));
    assert.ok(!matchesRule("Bash(oc adm {inspect,top} *)", "Bash", "oc adm drain node01"));
  });

  test("brace expansion with no braces returns original", () => {
    assert.ok(matchesRule("Bash(echo *)", "Bash", "echo hello"));
  });

  test("brace expansion in file paths", () => {
    assert.ok(matchesRule("Write(path:src/{api,pkg}/**)", "Write", "src/api/handler.go"));
    assert.ok(matchesRule("Write(path:src/{api,pkg}/**)", "Write", "src/pkg/util.go"));
    assert.ok(!matchesRule("Write(path:src/{api,pkg}/**)", "Write", "src/cmd/main.go"));
  });

  test("Modify matches both Write and Edit", () => {
    assert.ok(matchesRule("Modify(path:src/**)", "Write", "src/main.go"));
    assert.ok(matchesRule("Modify(path:src/**)", "Edit", "src/main.go"));
    assert.ok(!matchesRule("Modify(path:src/**)", "Read", "src/main.go"));
    assert.ok(!matchesRule("Modify(path:src/**)", "Bash", "echo hello"));
  });

  test("Modify with braces", () => {
    assert.ok(matchesRule("Modify(path:{src,wiki}/**)", "Write", "src/main.go"));
    assert.ok(matchesRule("Modify(path:{src,wiki}/**)", "Edit", "wiki/index.md"));
    assert.ok(!matchesRule("Modify(path:{src,wiki}/**)", "Write", "logs/file.txt"));
  });

  test("tilde expansion in file rule matching", () => {
    const rules = ["Read(path:~/.bashrc)"];
    const home = require("node:os").homedir();
    assert.ok(matchesRule(rules[0], "Read", `${home}/.bashrc`));
  });
});
