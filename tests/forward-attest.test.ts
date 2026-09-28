import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkAcceptanceManifest } from "../src/acceptance.js";
import { InputError } from "../src/input.js";

// runner 读取 dist，测试前由 npm run check 构建。
const identity = {
  repo: "bigKING67/whoami",
  signerWorkflow: "bigKING67/whoami/.github/workflows/forward-attest.yml",
  sourceRef: "refs/heads/main",
};

function replayRun() {
  const out = join(mkdtempSync(join(tmpdir(), "whoami-forward-")), "out");
  const run = (args: string[]) => spawnSync(process.execPath, ["scripts/forward-run.mjs", ...args], { encoding: "utf8" });
  const r = run(["--suite", "suites/forward-attest/attest-001", "--out", out, "--host", "replay", "--replay", "tests/fixtures/forward-replay"]);
  assert.equal(r.status, 0, r.stderr);
  // 以任意文件代替真实 Sigstore bundle；签名本身由注入的验证器模拟。
  const bundle = join(out, "..", "fake.sigstore.json");
  writeFileSync(bundle, "{}\n");
  const f = run(["--finalize", out, "--bundle", bundle]);
  assert.equal(f.status, 0, f.stderr);
  const manifestPath = join(out, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.review = { status: "PASS", factErrors: 0, premiseOmissions: 0, candidateMixing: 0, unsupportedTimingClaims: 0, unsafeClaims: 0 };
  return { out, manifestPath, manifest };
}

test("runner 回放生成 v3 回执：模型声明取自宿主事件流，签发有效且身份匹配时 verified", () => {
  const { manifestPath, manifest } = replayRun();
  assert.equal(manifest.runtime.model, "claude-sonnet-5");
  assert.equal(manifest.runtime.modelVersion, "claude-code 9.9.9-replay");
  let seen: { identity?: unknown; bytes?: number } = {};
  const result = checkAcceptanceManifest(manifest, manifestPath, {
    trustedSigstoreIdentity: identity,
    sigstoreVerifier: (payload, _bundle, id) => {
      seen = { identity: id, bytes: payload.length };
      return true;
    },
  });
  assert.equal(result.status, "verified");
  assert.equal(result.runtimeVerified, true);
  assert.equal(result.runtimeKeyId, `sigstore:${identity.signerWorkflow}@${identity.sourceRef}`);
  assert.deepEqual(seen.identity, identity);
  assert(result.limitations.some((l) => l.includes("review 为维护者事后评审")));
});

test("未指定期望身份、签发无效或产物被改动时不能 verified", () => {
  const { out, manifestPath, manifest } = replayRun();
  const reject = (fn: () => unknown, code: string) =>
    assert.throws(fn, (e: unknown) => e instanceof InputError && e.code === code);
  reject(() => checkAcceptanceManifest(manifest, manifestPath, { sigstoreVerifier: () => true }), "INVALID_ACCEPTANCE_RECEIPT");
  reject(
    () => checkAcceptanceManifest(manifest, manifestPath, { trustedSigstoreIdentity: identity, sigstoreVerifier: () => false }),
    "ACCEPTANCE_RECEIPT_MISMATCH",
  );
  // 改动答复：清单与回执绑定的哈希随之失配。
  writeFileSync(join(out, "case-a", "response.md"), "改写后的答复。");
  assert.throws(() =>
    checkAcceptanceManifest(manifest, manifestPath, { trustedSigstoreIdentity: identity, sigstoreVerifier: () => true }),
  );
});

test("runner 拒绝非合成资料套件与已存在的输出目录", () => {
  const dir = mkdtempSync(join(tmpdir(), "whoami-suite-"));
  const suite = JSON.parse(readFileSync("suites/forward-attest/attest-001/suite.json", "utf8"));
  writeFileSync(join(dir, "suite.json"), JSON.stringify({ ...suite, synthetic: false }));
  const r = spawnSync(process.execPath, ["scripts/forward-run.mjs", "--suite", dir, "--out", join(dir, "out"), "--host", "replay", "--replay", "tests/fixtures/forward-replay"], { encoding: "utf8" });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /synthetic/);
  const existing = spawnSync(process.execPath, ["scripts/forward-run.mjs", "--suite", "suites/forward-attest/attest-001", "--out", dir, "--host", "replay", "--replay", "tests/fixtures/forward-replay"], { encoding: "utf8" });
  assert.notEqual(existing.status, 0);
  assert.match(existing.stderr, /已存在/);
});
