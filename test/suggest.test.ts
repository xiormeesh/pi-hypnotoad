import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { suggestBashPattern, suggestFilePattern, findFirstUnknownSegment } from "../src/suggest.js";

describe("suggestBashPattern", () => {
  test("subcommand tool: git checkout foo → git checkout *", () => {
    assert.strictEqual(suggestBashPattern("git checkout main"), "git checkout *");
  });

  test("subcommand tool: docker build . → docker build *", () => {
    assert.strictEqual(suggestBashPattern("docker build ."), "docker build *");
  });

  test("regular command: curl http://foo → curl *", () => {
    assert.strictEqual(suggestBashPattern("curl http://example.com"), "curl *");
  });

  test("single-word command stays as-is", () => {
    assert.strictEqual(suggestBashPattern("whoami"), "whoami");
  });

  test("strips env vars before suggesting", () => {
    assert.strictEqual(
      suggestBashPattern("KUBECONFIG=/dev/null make test"),
      "make *",
    );
  });

  test("strips git flags before suggesting", () => {
    assert.strictEqual(
      suggestBashPattern("git -C /path fetch --all"),
      "git fetch *",
    );
  });

  test("chain: suggests based on first unknown segment", () => {
    // cd is a safe builtin prefix, so it's skipped
    assert.strictEqual(
      suggestBashPattern("cd /path && custom-tool --flag"),
      "custom-tool *",
    );
  });

  test("chain: non-builtin first segment is used", () => {
    assert.strictEqual(
      suggestBashPattern("echo hello && custom-tool --flag"),
      "echo *",
    );
  });
});

describe("suggestFilePattern", () => {
  test("project-relative path suggests directory wildcard", () => {
    assert.strictEqual(
      suggestFilePattern("wiki/work/index.md", "/home/user/project"),
      "wiki/work/**",
    );
  });

  test("root-level file suggests *", () => {
    assert.strictEqual(
      suggestFilePattern("README.md", "/home/user/project"),
      "*",
    );
  });

  test("absolute path outside project suggests full path", () => {
    assert.strictEqual(
      suggestFilePattern("/etc/hosts", "/home/user/project"),
      "/etc/hosts",
    );
  });
});

describe("findFirstUnknownSegment", () => {
  test("skips safe builtins", () => {
    assert.strictEqual(
      findFirstUnknownSegment("cd /path && export FOO=bar && custom-tool"),
      "custom-tool",
    );
  });

  test("returns first segment if not a builtin", () => {
    assert.strictEqual(
      findFirstUnknownSegment("curl http://example.com | grep foo"),
      "curl http://example.com",
    );
  });

  test("returns null if all segments are builtins", () => {
    assert.strictEqual(
      findFirstUnknownSegment("cd /path && true"),
      null,
    );
  });
});
