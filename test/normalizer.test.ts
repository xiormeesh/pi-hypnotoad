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
});
