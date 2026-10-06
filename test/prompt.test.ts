import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { classifySegments, formatBashPrompt } from "../src/prompt.js";
import type { Permissions } from "../src/types.js";

const permissions: Permissions = {
  allow: ["Bash(echo *)", "Bash(grep *)", "Bash(git diff *)", "Bash(make *)", "Bash(tail *)"],
  deny: ["Bash(rm -rf *)", "Bash(sudo *)"],
  ask: ["Bash(git commit *)", "Bash(git push *)", "Bash(curl *)"],
};

describe("classifySegments", () => {
  test("allowed segment", () => {
    const segs = classifySegments("echo hello", permissions);
    assert.strictEqual(segs.length, 1);
    assert.strictEqual(segs[0].status, "allow");
  });

  test("denied segment", () => {
    const segs = classifySegments("sudo rm -rf /", permissions);
    assert.strictEqual(segs[0].status, "deny");
  });

  test("ask segment", () => {
    const segs = classifySegments("git commit -m 'msg'", permissions);
    assert.strictEqual(segs[0].status, "ask");
  });

  test("unknown segment", () => {
    const segs = classifySegments("unknown-tool --flag", permissions);
    assert.strictEqual(segs[0].status, "unknown");
  });

  test("mixed chain", () => {
    const segs = classifySegments("echo hello && git commit -m 'msg' && unknown-tool", permissions);
    assert.strictEqual(segs.length, 3);
    assert.strictEqual(segs[0].status, "allow");
    assert.strictEqual(segs[1].status, "ask");
    assert.strictEqual(segs[2].status, "unknown");
  });

  test("allowed command with file redirect becomes unknown", () => {
    const segs = classifySegments("echo secret > /etc/passwd", permissions);
    assert.strictEqual(segs[0].status, "unknown");
  });

  test("allowed command with >/dev/null stays allowed", () => {
    const segs = classifySegments("make test >/dev/null 2>&1", permissions);
    assert.strictEqual(segs[0].status, "allow");
  });

  test("deny takes priority over allow", () => {
    // rm -rf matches deny even though nothing matches allow
    const segs = classifySegments("rm -rf /tmp/foo", permissions);
    assert.strictEqual(segs[0].status, "deny");
  });

  test("allow overrides ask for specific patterns", () => {
    const perms: Permissions = {
      allow: ["Bash(python3 .pi/skills/briefing/scripts/*)"],
      deny: [],
      ask: ["Bash(python3 *)"],
    };
    // Specific script — allow wins
    const segs1 = classifySegments("python3 .pi/skills/briefing/scripts/foo.py", perms);
    assert.strictEqual(segs1[0].status, "allow");
    // Generic python3 — ask wins (no allow match)
    const segs2 = classifySegments("python3 unknown.py", perms);
    assert.strictEqual(segs2[0].status, "ask");
  });
});

describe("formatBashPrompt", () => {
  test("single segment shows icon", () => {
    const output = formatBashPrompt("echo hello", permissions);
    assert.ok(output.includes("✓"));
    assert.ok(output.includes("echo hello"));
  });

  test("multi-segment shows each with icon", () => {
    const output = formatBashPrompt("echo hello && git commit -m 'msg'", permissions);
    assert.ok(output.includes("✓"));
    assert.ok(output.includes("?"));
    assert.ok(output.includes("echo hello"));
    assert.ok(output.includes("git commit"));
  });

  test("deny segment shows ✗", () => {
    const output = formatBashPrompt("echo hello && sudo rm -rf /", permissions);
    assert.ok(output.includes("✗"));
  });

  test("file redirect segment shows writes-to-file label", () => {
    const output = formatBashPrompt("echo secret > /etc/passwd", permissions);
    assert.ok(output.includes("writes to file"));
  });

  test("ask segment shows matched rule", () => {
    const output = formatBashPrompt("git push origin main", permissions);
    assert.ok(output.includes("ask:"), "should show ask status");
    assert.ok(output.includes("git push *"), "should show matching pattern");
  });

  test("truncates very long single segment", () => {
    const longCmd = "echo " + "x".repeat(2000);
    const output = formatBashPrompt(longCmd, permissions);
    assert.ok(output.includes("..."));
    assert.ok(output.length < 2000);
  });

  test("truncates multi-segment when budget exhausted", () => {
    // Build a chain of many segments to exhaust the display budget
    const segments = Array.from({ length: 20 }, (_, i) => `echo ${'arg'.repeat(30)}${i}`);
    const cmd = segments.join(" && ");
    const output = formatBashPrompt(cmd, permissions);
    assert.ok(output.includes("..."));
  });

  test("single long command without spaces truncates correctly", () => {
    const longCmd = "x".repeat(2000);
    const output = formatBashPrompt(longCmd, permissions);
    assert.ok(output.includes("..."));
  });
});
