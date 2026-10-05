import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { isDevModeBashAllowed, isFileUnderDevPath } from "../src/devmode.js";

const allow = ["Bash(echo *)", "Bash(grep *)"];

describe("isDevModeBashAllowed", () => {
  test("allows make", () => {
    assert.ok(isDevModeBashAllowed("make build", allow));
  });

  test("allows go test", () => {
    assert.ok(isDevModeBashAllowed("go test ./...", allow));
  });

  test("allows npm test", () => {
    assert.ok(isDevModeBashAllowed("npm test", allow));
  });

  test("allows pytest", () => {
    assert.ok(isDevModeBashAllowed("pytest -v", allow));
  });

  test("allows cargo build", () => {
    assert.ok(isDevModeBashAllowed("cargo build --release", allow));
  });

  test("allows mkdir", () => {
    assert.ok(isDevModeBashAllowed("mkdir -p src/new", allow));
  });

  test("allows kubectl get", () => {
    assert.ok(isDevModeBashAllowed("kubectl get pods", allow));
  });

  test("allows git add", () => {
    assert.ok(isDevModeBashAllowed("git add file.go", allow));
  });

  test("allows git diff", () => {
    assert.ok(isDevModeBashAllowed("git diff --stat", allow));
  });

  test("blocks git commit", () => {
    assert.ok(!isDevModeBashAllowed("git commit -m 'msg'", allow));
  });

  test("blocks git push", () => {
    assert.ok(!isDevModeBashAllowed("git push origin main", allow));
  });

  test("blocks git rebase", () => {
    assert.ok(!isDevModeBashAllowed("git rebase main", allow));
  });

  test("blocks git merge", () => {
    assert.ok(!isDevModeBashAllowed("git merge feature", allow));
  });

  test("blocks git reset", () => {
    assert.ok(!isDevModeBashAllowed("git reset --hard HEAD~1", allow));
  });

  test("allows explicitly allowed commands", () => {
    assert.ok(isDevModeBashAllowed("echo hello", allow));
  });

  test("blocks unknown commands not in dev patterns or allow", () => {
    assert.ok(!isDevModeBashAllowed("curl http://example.com", allow));
  });

  test("chain: allowed if all segments are safe", () => {
    assert.ok(isDevModeBashAllowed("make test && echo done", allow));
  });

  test("chain: blocked if any segment is git mutating", () => {
    assert.ok(!isDevModeBashAllowed("make test && git commit -m 'msg'", allow));
  });
});

describe("isFileUnderDevPath", () => {
  const devMode = { active: true, path: "/home/user/project" };

  test("file under dev path", () => {
    assert.ok(isFileUnderDevPath("src/main.ts", devMode, "/home/user/project"));
  });

  test("file outside dev path", () => {
    assert.ok(!isFileUnderDevPath("/etc/hosts", devMode, "/home/user/project"));
  });

  test("file in parent directory", () => {
    assert.ok(!isFileUnderDevPath("../other/file.ts", devMode, "/home/user/project"));
  });
});
