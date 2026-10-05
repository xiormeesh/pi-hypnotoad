import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { normalizeCommand, stripEnvVarPrefixes } from "../src/normalizer.js";

describe("stripEnvVarPrefixes", () => {
  test("strips single env var", () => {
    assert.strictEqual(
      stripEnvVarPrefixes("KUBECONFIG=/dev/null make test"),
      "make test",
    );
  });

  test("strips multiple env vars", () => {
    assert.strictEqual(
      stripEnvVarPrefixes("KUBECONFIG=/dev/null GOFLAGS=-race make test 2>&1"),
      "make test 2>&1",
    );
  });

  test("leaves command without env vars unchanged", () => {
    assert.strictEqual(
      stripEnvVarPrefixes("make test"),
      "make test",
    );
  });

  test("leaves bare env vars unchanged (no command follows)", () => {
    assert.strictEqual(
      stripEnvVarPrefixes("FOO=bar BAZ=qux"),
      "FOO=bar BAZ=qux",
    );
  });

  test("strips GIT_EDITOR=true", () => {
    assert.strictEqual(
      stripEnvVarPrefixes("GIT_EDITOR=true git rebase --continue"),
      "git rebase --continue",
    );
  });

  test("does not strip things that look like assignments but aren't", () => {
    // "foo=bar" looks like an assignment, but if it's the only token
    // or followed by another assignment-like token, it stays
    assert.strictEqual(
      stripEnvVarPrefixes("grep KEY=value file.txt"),
      "grep KEY=value file.txt",
    );
  });
});

describe("normalizeCommand", () => {
  test("strips git -C flag", () => {
    assert.strictEqual(
      normalizeCommand("git -C /some/path fetch --all"),
      "git fetch --all",
    );
  });

  test("strips git --no-pager flag", () => {
    assert.strictEqual(
      normalizeCommand("git --no-pager log --oneline"),
      "git log --oneline",
    );
  });

  test("strips git --git-dir=path flag", () => {
    assert.strictEqual(
      normalizeCommand("git --git-dir=/tmp/.git status"),
      "git status",
    );
  });

  test("strips kubectl -n flag", () => {
    assert.strictEqual(
      normalizeCommand("kubectl -n kube-system get pods"),
      "kubectl get pods",
    );
  });

  test("strips kubectl --namespace=val flag", () => {
    assert.strictEqual(
      normalizeCommand("kubectl --namespace=default get svc"),
      "kubectl get svc",
    );
  });

  test("strips oc context flags", () => {
    assert.strictEqual(
      normalizeCommand("oc --context=prod -n myns get deployment"),
      "oc get deployment",
    );
  });

  test("strips docker host flags", () => {
    assert.strictEqual(
      normalizeCommand("docker -H tcp://host:2375 ps"),
      "docker ps",
    );
  });

  test("leaves unknown commands unchanged", () => {
    assert.strictEqual(
      normalizeCommand("make test"),
      "make test",
    );
  });

  test("strips env vars AND git flags together", () => {
    assert.strictEqual(
      normalizeCommand("GIT_EDITOR=true git -C /path rebase --continue"),
      "git rebase --continue",
    );
  });

  test("strips env vars before unknown command", () => {
    assert.strictEqual(
      normalizeCommand("KUBECONFIG=/dev/null GOFLAGS=-race make test 2>&1"),
      "make test 2>&1",
    );
  });

  // --- Pipeline negation ---

  test("strips leading ! (pipeline negation)", () => {
    assert.strictEqual(
      normalizeCommand("! grep -q pattern file.txt"),
      "grep -q pattern file.txt",
    );
  });

  test("leaves commands without ! unchanged", () => {
    assert.strictEqual(
      normalizeCommand("grep -q pattern file.txt"),
      "grep -q pattern file.txt",
    );
  });

  // --- xargs stripping ---

  test("strips bare xargs", () => {
    assert.strictEqual(
      normalizeCommand("xargs grep -l foo"),
      "grep -l foo",
    );
  });

  test("strips xargs -0", () => {
    assert.strictEqual(
      normalizeCommand("xargs -0 grep -H -E '^pattern'"),
      "grep -H -E '^pattern'",
    );
  });

  test("strips xargs with -I{}", () => {
    assert.strictEqual(
      normalizeCommand("xargs -I{} stat {}"),
      "stat {}",
    );
  });

  test("strips xargs with -I {}", () => {
    assert.strictEqual(
      normalizeCommand("xargs -I {} stat {}"),
      "stat {}",
    );
  });

  test("strips xargs with -n and -P flags", () => {
    assert.strictEqual(
      normalizeCommand("xargs -0 -n 1 -P 4 wc -l"),
      "wc -l",
    );
  });

  test("strips xargs --null --no-run-if-empty", () => {
    assert.strictEqual(
      normalizeCommand("xargs --null --no-run-if-empty cat"),
      "cat",
    );
  });

  test("leaves bare xargs with no command unchanged", () => {
    assert.strictEqual(
      normalizeCommand("xargs"),
      "xargs",
    );
  });

  // --- Absolute project-root path normalization ---

  test("strips project root from absolute paths", () => {
    assert.strictEqual(
      normalizeCommand("bash /home/user/project/.pi/skills/foo.sh", "/home/user/project"),
      "bash .pi/skills/foo.sh",
    );
  });

  test("strips project root from multiple path arguments", () => {
    assert.strictEqual(
      normalizeCommand("diff /home/user/project/a.txt /home/user/project/b.txt", "/home/user/project"),
      "diff a.txt b.txt",
    );
  });

  test("leaves non-project absolute paths unchanged", () => {
    assert.strictEqual(
      normalizeCommand("cat /etc/hosts", "/home/user/project"),
      "cat /etc/hosts",
    );
  });

  test("no-ops when projectRoot is not provided", () => {
    assert.strictEqual(
      normalizeCommand("bash /home/user/project/.pi/skills/foo.sh"),
      "bash /home/user/project/.pi/skills/foo.sh",
    );
  });

  // --- Shell keyword prefix stripping ---

  test("strips if prefix", () => {
    assert.strictEqual(
      normalizeCommand('if [ -d "$dir" ]'),
      '[ -d "$dir" ]',
    );
  });

  test("strips do prefix", () => {
    assert.strictEqual(
      normalizeCommand('do grep -q foo bar'),
      "grep -q foo bar",
    );
  });

  test("strips then prefix", () => {
    assert.strictEqual(
      normalizeCommand("then echo hello"),
      "echo hello",
    );
  });

  test("strips while prefix", () => {
    assert.strictEqual(
      normalizeCommand("while read line"),
      "read line",
    );
  });

  test("strips elif prefix", () => {
    assert.strictEqual(
      normalizeCommand('elif [ -f "$file" ]'),
      '[ -f "$file" ]',
    );
  });

  test("does not strip keywords that are part of command names", () => {
    assert.strictEqual(
      normalizeCommand("ifeq something"),
      "ifeq something",
    );
  });

  // --- Combined normalizations ---

  test("strips env vars + negation + xargs together", () => {
    assert.strictEqual(
      normalizeCommand("FOO=bar ! xargs -0 grep -l pattern"),
      "grep -l pattern",
    );
  });

  test("strips xargs + project root together", () => {
    assert.strictEqual(
      normalizeCommand("xargs -0 node /home/user/project/.pi/skills/run.js", "/home/user/project"),
      "node .pi/skills/run.js",
    );
  });
});
