import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  splitBashSegments,
  stripComments,
  stripCdPrefix,
  isCdSegment,
  isShellSetupSegment,
  fileRedirectTarget,
  anySegmentHasFileRedirect,
} from "../src/parser.js";

describe("splitBashSegments", () => {
  test("single command", () => {
    assert.deepStrictEqual(splitBashSegments("echo hello"), ["echo hello"]);
  });

  test("splits on &&", () => {
    assert.deepStrictEqual(
      splitBashSegments("echo a && echo b"),
      ["echo a", "echo b"],
    );
  });

  test("splits on ||", () => {
    assert.deepStrictEqual(
      splitBashSegments("echo a || echo b"),
      ["echo a", "echo b"],
    );
  });

  test("splits on ;", () => {
    assert.deepStrictEqual(
      splitBashSegments("echo a; echo b"),
      ["echo a", "echo b"],
    );
  });

  test("splits on |", () => {
    assert.deepStrictEqual(
      splitBashSegments("cat file | grep foo"),
      ["cat file", "grep foo"],
    );
  });

  test("splits on background &", () => {
    assert.deepStrictEqual(
      splitBashSegments("sleep 10 & echo started"),
      ["sleep 10", "echo started"],
    );
  });

  test("does not split &> (redirect, not background)", () => {
    const segs = splitBashSegments("make test &> /dev/null");
    assert.strictEqual(segs.length, 1);
  });

  test("does not split 2>&1 (fd redirect)", () => {
    const segs = splitBashSegments("make test 2>&1");
    assert.strictEqual(segs.length, 1);
    assert.strictEqual(segs[0], "make test 2>&1");
  });

  test("preserves operators inside single quotes", () => {
    assert.deepStrictEqual(
      splitBashSegments("echo 'a && b' && echo c"),
      ["echo 'a && b'", "echo c"],
    );
  });

  test("preserves operators inside double quotes", () => {
    assert.deepStrictEqual(
      splitBashSegments('echo "a | b" | grep foo'),
      ['echo "a | b"', "grep foo"],
    );
  });

  test("preserves operators inside $() command substitution", () => {
    assert.deepStrictEqual(
      splitBashSegments("$(curl http://example.com | grep foo) && echo done"),
      ["$(curl http://example.com | grep foo)", "echo done"],
    );
  });

  test("preserves operators inside nested $()", () => {
    assert.deepStrictEqual(
      splitBashSegments("$(echo $(cat file | head -1)) && echo done"),
      ["$(echo $(cat file | head -1))", "echo done"],
    );
  });

  test("preserves operators inside backticks", () => {
    assert.deepStrictEqual(
      splitBashSegments("`curl http://example.com | grep foo` && echo done"),
      ["`curl http://example.com | grep foo`", "echo done"],
    );
  });

  test("preserves operators inside () subshell", () => {
    assert.deepStrictEqual(
      splitBashSegments("(echo a | echo b) && echo c"),
      ["(echo a | echo b)", "echo c"],
    );
  });

  test("preserves operators inside <() process substitution", () => {
    assert.deepStrictEqual(
      splitBashSegments("diff <(sort a) <(sort b) && echo same"),
      ["diff <(sort a) <(sort b)", "echo same"],
    );
  });

  test("handles backslash escapes", () => {
    assert.deepStrictEqual(
      splitBashSegments("echo a\\&\\& b && echo c"),
      ["echo a\\&\\& b", "echo c"],
    );
  });

  test("complex real-world chain", () => {
    const cmd = 'make test 2>&1 | tail -6 && echo "=== dry runs ===" && make -n target >/dev/null 2>&1 && echo ok';
    const segs = splitBashSegments(cmd);
    assert.strictEqual(segs.length, 5);
    assert.strictEqual(segs[0], "make test 2>&1");
    assert.strictEqual(segs[1], "tail -6");
    assert.strictEqual(segs[2], 'echo "=== dry runs ==="');
    assert.strictEqual(segs[3], "make -n target >/dev/null 2>&1");
    assert.strictEqual(segs[4], "echo ok");
  });

  test("trims whitespace and filters empty segments", () => {
    assert.deepStrictEqual(
      splitBashSegments("  echo a &&  && echo b  "),
      ["echo a", "echo b"],
    );
  });

  test("gofmt + env var + make chain from real session", () => {
    const cmd = "gofmt -w file.go && KUBECONFIG=/dev/null GOFLAGS=-race make test 2>&1 | tail -15";
    const segs = splitBashSegments(cmd);
    assert.strictEqual(segs.length, 3);
    assert.strictEqual(segs[0], "gofmt -w file.go");
    assert.strictEqual(segs[1], "KUBECONFIG=/dev/null GOFLAGS=-race make test 2>&1");
    assert.strictEqual(segs[2], "tail -15");
  });

  test("set -o pipefail in chain", () => {
    const cmd = "set -o pipefail && go run tool ./cli 2>&1 | tail -n 28";
    const segs = splitBashSegments(cmd);
    assert.strictEqual(segs[0], "set -o pipefail");
  });

  test("test -z with $() containing |", () => {
    const cmd = 'test -z "$(gofmt -l file.go)" && git status';
    const segs = splitBashSegments(cmd);
    assert.strictEqual(segs.length, 2);
    assert.strictEqual(segs[0], 'test -z "$(gofmt -l file.go)"');
    assert.strictEqual(segs[1], "git status");
  });
});

describe("stripComments", () => {
  test("removes comment lines", () => {
    assert.strictEqual(
      stripComments("# this is a comment\necho hello"),
      "echo hello",
    );
  });

  test("keeps non-comment lines", () => {
    assert.strictEqual(stripComments("echo hello"), "echo hello");
  });

  test("removes multiple comment lines", () => {
    assert.strictEqual(
      stripComments("# comment 1\n# comment 2\necho hello"),
      "echo hello",
    );
  });
});

describe("stripCdPrefix", () => {
  test("strips cd && prefix", () => {
    assert.strictEqual(
      stripCdPrefix("cd /some/path && echo hello"),
      "echo hello",
    );
  });

  test("strips cd ; prefix", () => {
    assert.strictEqual(
      stripCdPrefix("cd /some/path; echo hello"),
      "echo hello",
    );
  });

  test("leaves commands without cd prefix", () => {
    assert.strictEqual(stripCdPrefix("echo hello"), "echo hello");
  });

  test("strips cd with ~ path", () => {
    assert.strictEqual(
      stripCdPrefix("cd ~/project && make test"),
      "make test",
    );
  });
});

describe("isCdSegment", () => {
  test("matches cd with literal path", () => {
    assert.ok(isCdSegment("cd /some/path"));
  });

  test("matches cd with relative path", () => {
    assert.ok(isCdSegment("cd src/project"));
  });

  test("matches cd with quoted path", () => {
    assert.ok(isCdSegment("cd 'some path'"));
  });

  test("rejects cd with shell expansion", () => {
    assert.ok(!isCdSegment("cd $(echo /tmp)"));
  });

  test("rejects bare cd", () => {
    assert.ok(!isCdSegment("cd"));
  });
});

describe("isShellSetupSegment", () => {
  test("cd is setup", () => {
    assert.ok(isShellSetupSegment("cd /path"));
  });

  test("set -o pipefail is setup", () => {
    assert.ok(isShellSetupSegment("set -o pipefail"));
  });

  test("set -euo pipefail is setup", () => {
    assert.ok(isShellSetupSegment("set -euo pipefail"));
  });

  test("export VAR=val is setup", () => {
    assert.ok(isShellSetupSegment("export KUBECONFIG=/dev/null"));
  });

  test("source .env is setup", () => {
    assert.ok(isShellSetupSegment("source .env"));
  });

  test(". .env is setup", () => {
    assert.ok(isShellSetupSegment(". .env"));
  });

  test("true is setup", () => {
    assert.ok(isShellSetupSegment("true"));
  });

  test("false is setup", () => {
    assert.ok(isShellSetupSegment("false"));
  });

  test(": is setup", () => {
    assert.ok(isShellSetupSegment(":"));
  });

  test("bare env var assignment is setup", () => {
    assert.ok(isShellSetupSegment("KUBECONFIG=/dev/null"));
  });

  test("multiple env var assignments is setup", () => {
    assert.ok(isShellSetupSegment("FOO=bar BAZ=qux"));
  });

  test("echo is NOT setup", () => {
    assert.ok(!isShellSetupSegment("echo hello"));
  });

  test("make is NOT setup", () => {
    assert.ok(!isShellSetupSegment("make test"));
  });

  test("env var + command is NOT setup", () => {
    assert.ok(!isShellSetupSegment("FOO=bar make test"));
  });
});

describe("fileRedirectTarget", () => {
  test("no redirect returns null", () => {
    assert.strictEqual(fileRedirectTarget("echo hello"), null);
  });

  test("detects > file", () => {
    assert.strictEqual(fileRedirectTarget("echo secret > /etc/passwd"), "/etc/passwd");
  });

  test("detects >> file", () => {
    assert.strictEqual(fileRedirectTarget("echo log >> build.log"), "build.log");
  });

  test("detects &> file", () => {
    assert.strictEqual(fileRedirectTarget("cat file &> output.txt"), "output.txt");
  });

  test("ignores >/dev/null", () => {
    assert.strictEqual(fileRedirectTarget("make build >/dev/null 2>&1"), null);
  });

  test("ignores 2>&1", () => {
    assert.strictEqual(fileRedirectTarget("make test 2>&1"), null);
  });

  test("ignores &>/dev/null", () => {
    assert.strictEqual(fileRedirectTarget("grep foo &>/dev/null"), null);
  });

  test("ignores > inside double quotes", () => {
    assert.strictEqual(fileRedirectTarget('echo "hello > world"'), null);
  });

  test("ignores > inside single quotes", () => {
    assert.strictEqual(fileRedirectTarget("echo 'hello > world'"), null);
  });

  test("ignores > inside $()", () => {
    assert.strictEqual(fileRedirectTarget("echo $(cat > /tmp/x)"), null);
  });

  test("ignores > inside backticks", () => {
    assert.strictEqual(fileRedirectTarget("echo `cat > /tmp/x`"), null);
  });
});

describe("anySegmentHasFileRedirect", () => {
  test("no redirects in chain", () => {
    assert.ok(!anySegmentHasFileRedirect("echo a && echo b | grep c"));
  });

  test("redirect in one segment", () => {
    assert.ok(anySegmentHasFileRedirect("echo a > file.txt && echo b"));
  });

  test("only /dev/null redirects", () => {
    assert.ok(!anySegmentHasFileRedirect("make test >/dev/null 2>&1 | tail -5"));
  });
});
