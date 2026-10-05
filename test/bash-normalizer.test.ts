import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  stripEnvVarPrefixes,
  stripNegation,
  stripKeywordPrefix,
  stripXargs,
  stripBashScaffolding,
  isShellSetupSegment,
} from "../src/bash-normalizer.js";

describe("stripEnvVarPrefixes", () => {
  test("strips single var", () => {
    assert.strictEqual(stripEnvVarPrefixes("FOO=bar cmd"), "cmd");
  });

  test("strips multiple vars", () => {
    assert.strictEqual(stripEnvVarPrefixes("A=1 B=2 cmd arg"), "cmd arg");
  });

  test("leaves bare assignments unchanged", () => {
    assert.strictEqual(stripEnvVarPrefixes("FOO=bar"), "FOO=bar");
  });

  test("leaves non-assignment commands unchanged", () => {
    assert.strictEqual(stripEnvVarPrefixes("grep FOO=bar file"), "grep FOO=bar file");
  });
});

describe("stripNegation", () => {
  test("strips leading !", () => {
    assert.strictEqual(stripNegation("! grep -q foo"), "grep -q foo");
  });

  test("leaves non-negated unchanged", () => {
    assert.strictEqual(stripNegation("grep -q foo"), "grep -q foo");
  });

  test("does not strip ! without space", () => {
    assert.strictEqual(stripNegation("!important"), "!important");
  });
});

describe("stripKeywordPrefix", () => {
  test("strips if", () => {
    assert.strictEqual(stripKeywordPrefix('if [ -d "$dir" ]'), '[ -d "$dir" ]');
  });

  test("strips elif", () => {
    assert.strictEqual(stripKeywordPrefix('elif [ -f "$f" ]'), '[ -f "$f" ]');
  });

  test("strips while", () => {
    assert.strictEqual(stripKeywordPrefix("while read line"), "read line");
  });

  test("strips until", () => {
    assert.strictEqual(stripKeywordPrefix("until false"), "false");
  });

  test("strips do", () => {
    assert.strictEqual(stripKeywordPrefix("do grep -q foo bar"), "grep -q foo bar");
  });

  test("strips then", () => {
    assert.strictEqual(stripKeywordPrefix("then echo done"), "echo done");
  });

  test("strips else", () => {
    assert.strictEqual(stripKeywordPrefix("else echo fallback"), "echo fallback");
  });

  test("does not strip partial keyword matches", () => {
    assert.strictEqual(stripKeywordPrefix("ifeq something"), "ifeq something");
    assert.strictEqual(stripKeywordPrefix("donut-tool arg"), "donut-tool arg");
    assert.strictEqual(stripKeywordPrefix("theorem-prover"), "theorem-prover");
  });

  test("leaves bare keywords unchanged (no trailing command)", () => {
    assert.strictEqual(stripKeywordPrefix("do"), "do");
    assert.strictEqual(stripKeywordPrefix("then"), "then");
  });
});

describe("stripXargs", () => {
  test("strips bare xargs", () => {
    assert.strictEqual(stripXargs("xargs grep -l foo"), "grep -l foo");
  });

  test("strips xargs -0", () => {
    assert.strictEqual(stripXargs("xargs -0 grep -H pattern"), "grep -H pattern");
  });

  test("strips xargs with -I{}", () => {
    assert.strictEqual(stripXargs("xargs -I{} stat {}"), "stat {}");
  });

  test("strips xargs with -I {}", () => {
    assert.strictEqual(stripXargs("xargs -I {} stat {}"), "stat {}");
  });

  test("strips xargs with -n -P flags", () => {
    assert.strictEqual(stripXargs("xargs -0 -n 1 -P 4 wc -l"), "wc -l");
  });

  test("strips xargs --null --no-run-if-empty", () => {
    assert.strictEqual(stripXargs("xargs --null --no-run-if-empty cat"), "cat");
  });

  test("leaves bare xargs unchanged", () => {
    assert.strictEqual(stripXargs("xargs"), "xargs");
  });

  test("leaves non-xargs unchanged", () => {
    assert.strictEqual(stripXargs("grep foo bar"), "grep foo bar");
  });
});

describe("stripBashScaffolding", () => {
  test("chains all stripping steps", () => {
    assert.strictEqual(
      stripBashScaffolding("FOO=bar ! do xargs -0 grep -l pattern"),
      "grep -l pattern",
    );
  });

  test("strips env + keyword + xargs", () => {
    assert.strictEqual(
      stripBashScaffolding("VAR=val then xargs -n 1 stat"),
      "stat",
    );
  });
});

describe("isShellSetupSegment", () => {
  // --- Control-flow keywords (bare) ---
  test("fi is setup", () => assert.ok(isShellSetupSegment("fi")));
  test("done is setup", () => assert.ok(isShellSetupSegment("done")));
  test("esac is setup", () => assert.ok(isShellSetupSegment("esac")));
  test("do is setup", () => assert.ok(isShellSetupSegment("do")));
  test("then is setup", () => assert.ok(isShellSetupSegment("then")));
  test("else is setup", () => assert.ok(isShellSetupSegment("else")));

  // --- Loop/branch headers ---
  test("for VAR in ... is setup", () => {
    assert.ok(isShellSetupSegment('for d in 2026-09-28 2026-09-29'));
  });

  test("for (( ... )) is setup", () => {
    assert.ok(isShellSetupSegment("for (( i=0; i<10; i++ ))"));
  });

  test("case WORD in is setup", () => {
    assert.ok(isShellSetupSegment('case "$1" in'));
  });

  // --- Conditionals ---
  test("[[ ... ]] is setup", () => {
    assert.ok(isShellSetupSegment('[[ -f "$file" ]]'));
  });

  test("[ ... ] is setup", () => {
    assert.ok(isShellSetupSegment('[ -d "$dir" ]'));
  });

  // --- Classic setup (cd, set, export, etc.) ---
  test("cd is setup", () => assert.ok(isShellSetupSegment("cd /path")));
  test("set -o pipefail is setup", () => assert.ok(isShellSetupSegment("set -o pipefail")));
  test("export VAR=val is setup", () => assert.ok(isShellSetupSegment("export FOO=bar")));
  test("source file is setup", () => assert.ok(isShellSetupSegment("source .env")));
  test("true is setup", () => assert.ok(isShellSetupSegment("true")));
  test("false is setup", () => assert.ok(isShellSetupSegment("false")));
  test(": is setup", () => assert.ok(isShellSetupSegment(":")));
  test("VAR=val is setup", () => assert.ok(isShellSetupSegment("dir=/tmp/foo")));

  // --- Not setup ---
  test("grep is not setup", () => assert.ok(!isShellSetupSegment("grep foo bar")));
  test("rm is not setup", () => assert.ok(!isShellSetupSegment("rm -rf /")));
  test("echo with args is not setup", () => assert.ok(!isShellSetupSegment("echo hello world")));
  test("curl is not setup", () => assert.ok(!isShellSetupSegment("curl https://example.com")));
});
