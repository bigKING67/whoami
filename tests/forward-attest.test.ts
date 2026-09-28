import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkAcceptanceManifest, type SigstoreResult } from "../src/acceptance.js";
import { InputError } from "../src/input.js";

// runner 读取 dist；npm run check 先构建再测试。
const identity = {
  repo: "bigKING67/whoami",
  signerWorkflow: "bigKING67/whoami/.github/workflows/forward-attest.yml",
  sourceRef: "refs/heads/main",
  reviewWorkflow: "bigKING67/whoami/.github/workflows/forward-review.yml",
};
const run = (args: string[]) => spawnSync(process.execPath, ["scripts/forward-run.mjs", ...args], { encoding: "utf8" });
const read = (p: string) => JSON.parse(readFileSync(p, "utf8"));
const PASS = { status: "PASS", factErrors: 0, premiseOmissions: 0, candidateMixing: 0, unsupportedTimingClaims: 0, unsafeClaims: 0 };

/** 回放生成 → 签发回填 →（可选）review 写入与签发回填；bundle 以占位文件代替，签发由注入的验证器模拟。 */
function pipeline(withReview: boolean) {
  const tmp = mkdtempSync(join(tmpdir(), "whoami-forward-"));
  const out = join(tmp, "out");
  const ok = (r: ReturnType<typeof run>) => assert.equal(r.status, 0, r.stderr);
  ok(run(["--suite", "suites/forward-attest/attest-001", "--out", out, "--host", "replay", "--replay", "tests/fixtures/forward-replay"]));
  writeFileSync(join(tmp, "gen.bundle"), "{}\n");
  ok(run(["--finalize", out, "--bundle", join(tmp, "gen.bundle")]));
  if (withReview) {
    writeFileSync(join(tmp, "review.json"), JSON.stringify(PASS));
    ok(run(["--review", out, "--review-json", join(tmp, "review.json")]));
    writeFileSync(join(tmp, "review.bundle"), "{}\n");
    ok(run(["--finalize-review", out, "--bundle", join(tmp, "review.bundle")]));
  }
  const manifestPath = join(out, "manifest.json");
  const receipt = read(join(out, "receipt.json"));
  // 模拟 gh：按 bundle 文件名返回对应签发的运行 ID 与源码提交。
  const honest = (_p: Buffer, bundle: string): SigstoreResult =>
    bundle.endsWith("review.sigstore.json")
      ? { verified: true, runId: receipt.review.runId, sourceDigest: "f".repeat(40) }
      : { verified: true, runId: receipt.runId, sourceDigest: receipt.sourceCommit };
  return { out, manifestPath, manifest: read(manifestPath), receipt, honest };
}
const rejects = (fn: () => unknown, code: string) =>
  assert.throws(fn, (e: unknown) => e instanceof InputError && e.code === code);

test("生成与 review 均经 CI 签发且身份、运行 ID、源码提交一致时 verified", () => {
  const { manifest, manifestPath, receipt, honest } = pipeline(true);
  assert.equal(manifest.runtime.model, "claude-sonnet-5");
  assert.deepEqual(receipt.observedModels, ["claude-sonnet-5"]);
  const result = checkAcceptanceManifest(manifest, manifestPath, { trustedSigstoreIdentity: identity, sigstoreVerifier: honest });
  assert.equal(result.status, "verified");
  assert(result.limitations.some((l) => l.includes("维护者人工评审")));
});

test("review 未经 CI 签发时只能 partial：清单里的 review 可被任意改写", () => {
  const { manifest, manifestPath, honest } = pipeline(false);
  manifest.review = PASS;
  const result = checkAcceptanceManifest(manifest, manifestPath, { trustedSigstoreIdentity: identity, sigstoreVerifier: honest });
  assert.equal(result.runtimeVerified, true);
  assert.equal(result.status, "partial");
  assert(result.limitations.some((l) => l.includes("review 未经 CI 签发")));
});

test("签发后改动 review、证书运行 ID 或源码提交不符、签发无效、未给身份，均拒绝", () => {
  const { manifest, manifestPath, receipt, honest } = pipeline(true);
  const opts = (verifier = honest) => ({ trustedSigstoreIdentity: identity, sigstoreVerifier: verifier });
  rejects(() => checkAcceptanceManifest({ ...manifest, review: { ...PASS, status: "PARTIAL", factErrors: 1 } }, manifestPath, opts()), "ACCEPTANCE_RECEIPT_MISMATCH");
  rejects(() => checkAcceptanceManifest(manifest, manifestPath, opts(() => ({ verified: true, runId: "999", sourceDigest: receipt.sourceCommit }))), "ACCEPTANCE_RECEIPT_MISMATCH");
  rejects(() => checkAcceptanceManifest(manifest, manifestPath, opts((p, b) => ({ ...honest(p, b), sourceDigest: "0".repeat(40) }))), "ACCEPTANCE_RECEIPT_MISMATCH");
  rejects(() => checkAcceptanceManifest(manifest, manifestPath, opts(() => ({ verified: false, runId: null, sourceDigest: null }))), "ACCEPTANCE_RECEIPT_MISMATCH");
  rejects(() => checkAcceptanceManifest(manifest, manifestPath, { sigstoreVerifier: honest }), "INVALID_ACCEPTANCE_RECEIPT");
  // 未指定期望的 review 工作流：不核验 review 签发，降级为 partial。
  const { reviewWorkflow: _rw, ...noReviewIdentity } = identity;
  assert.equal(checkAcceptanceManifest(manifest, manifestPath, { trustedSigstoreIdentity: noReviewIdentity, sigstoreVerifier: honest }).status, "partial");
});

test("答复与事件流不一致、事件流被改动时拒绝；事件流中出现其他模型时披露", () => {
  const { out, manifest, manifestPath, honest } = pipeline(true);
  const opts = { trustedSigstoreIdentity: identity, sigstoreVerifier: honest };
  const eventsPath = join(out, "case-a", "events.jsonl");
  const original = readFileSync(eventsPath, "utf8");
  writeFileSync(eventsPath, original.replace("claude-sonnet-5", "claude-opus-5-5"));
  // 事件流在产物哈希一层即被拒绝。
  assert.throws(() => checkAcceptanceManifest(manifest, manifestPath, opts), (e: unknown) => e instanceof InputError && /eventLogs/.test(e.message));
  writeFileSync(eventsPath, original);
  // 事件流里 assistant 消息由另一模型产生：重新生成后披露，而不是静默接受。
  const tmp = mkdtempSync(join(tmpdir(), "whoami-replay-"));
  for (const id of ["case-a", "case-b"]) {
    const lines = readFileSync(`tests/fixtures/forward-replay/${id}.events.jsonl`, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    lines[1].message.model = "claude-haiku-4-5-20251001";
    writeFileSync(join(tmp, `${id}.events.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  }
  const out2 = join(tmp, "out");
  assert.equal(run(["--suite", "suites/forward-attest/attest-001", "--out", out2, "--host", "replay", "--replay", tmp]).status, 0);
  const receipt2 = read(join(out2, "receipt.json"));
  assert.deepEqual(receipt2.observedModels, ["claude-haiku-4-5-20251001", "claude-sonnet-5"]);
  writeFileSync(join(tmp, "b"), "{}\n");
  assert.equal(run(["--finalize", out2, "--bundle", join(tmp, "b")]).status, 0);
  const m2 = read(join(out2, "manifest.json"));
  m2.review = PASS;
  const r2 = read(join(out2, "receipt.json"));
  const result = checkAcceptanceManifest(m2, join(out2, "manifest.json"), {
    trustedSigstoreIdentity: identity,
    sigstoreVerifier: () => ({ verified: true, runId: r2.runId, sourceDigest: r2.sourceCommit }),
  });
  assert(result.limitations.some((l) => l.includes("claude-haiku-4-5-20251001")));
});

test("runner 拒绝 PASS 却带有问题计数的 review，避免签发一份核验必然拒绝的评审", () => {
  const { out } = pipeline(false);
  const tmp = mkdtempSync(join(tmpdir(), "whoami-review-"));
  writeFileSync(join(tmp, "r.json"), JSON.stringify({ ...PASS, factErrors: 1 }));
  const r = run(["--review", out, "--review-json", join(tmp, "r.json")]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /review 无效/);
});

test("回执载荷摘要被改（连同清单中的回执哈希）时由载荷重算拒绝", () => {
  const { out, manifest, manifestPath, honest } = pipeline(true);
  const receiptPath = join(out, "receipt.json");
  const receipt = read(receiptPath);
  receipt.payloadSha256 = "0".repeat(64);
  const bytes = Buffer.from(JSON.stringify(receipt, null, 2) + "\n");
  writeFileSync(receiptPath, bytes);
  manifest.runtime.receipt = { path: "receipt.json", sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length };
  assert.throws(
    () => checkAcceptanceManifest(manifest, manifestPath, { trustedSigstoreIdentity: identity, sigstoreVerifier: honest }),
    (e: unknown) => e instanceof InputError && e.code === "ACCEPTANCE_RECEIPT_MISMATCH" && e.message.includes("payloadSha256"),
  );
});

test("runner 拒绝非合成套件、已存在输出目录，并在 context 失败时于调用模型前中止", () => {
  const dir = mkdtempSync(join(tmpdir(), "whoami-suite-"));
  const suite = read("suites/forward-attest/attest-001/suite.json");
  const replay = ["--host", "replay", "--replay", "tests/fixtures/forward-replay"];
  writeFileSync(join(dir, "suite.json"), JSON.stringify({ ...suite, synthetic: false }));
  const nonSynthetic = run(["--suite", dir, "--out", join(dir, "o1"), ...replay]);
  assert.notEqual(nonSynthetic.status, 0);
  assert.match(nonSynthetic.stderr, /synthetic/);
  const existing = run(["--suite", "suites/forward-attest/attest-001", "--out", dir, ...replay]);
  assert.match(existing.stderr, /已存在/);
  for (const f of ["task.md", "rubric.md"]) writeFileSync(join(dir, f), "x\n");
  writeFileSync(join(dir, "bad.json"), "{}");
  writeFileSync(join(dir, "suite.json"), JSON.stringify({ ...suite, cases: [{ id: "case-a", input: "bad.json" }] }));
  const badContext = run(["--suite", dir, "--out", join(dir, "o2"), ...replay]);
  assert.notEqual(badContext.status, 0);
  assert.match(badContext.stderr, /context 计算失败/);
});

test("签发前重算：生成阶段被改写的 Skill 快照、输入或 context 会被拒绝", () => {
  const { out } = pipeline(false);
  for (const [file, label] of [["SKILL.snapshot.md", "SKILL"], ["case-a/input.json", "输入"], ["case-a/context.json", "context"], ["case-a/response.md", "答复"]] as const) {
    const original = readFileSync(join(out, file));
    writeFileSync(join(out, file), Buffer.concat([original, Buffer.from(" ")]));
    const r = run(["--repayload", out]);
    assert.notEqual(r.status, 0, file);
    assert.match(r.stderr, new RegExp(label));
    writeFileSync(join(out, file), original);
  }
  assert.equal(run(["--repayload", out]).status, 0);
});

test("默认 gh 核验：解析证书运行 ID 与源码提交；签发失败与网络故障分别报告", () => {
  const { manifest, manifestPath, receipt } = pipeline(false);
  manifest.review = PASS;
  const bin = mkdtempSync(join(tmpdir(), "whoami-fake-gh-"));
  const fakeGh = (script: string) => {
    writeFileSync(join(bin, "gh"), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  };
  const withPath = <T>(fn: () => T) => {
    const saved = process.env.PATH;
    process.env.PATH = `${bin}:${saved}`;
    try {
      return fn();
    } finally {
      process.env.PATH = saved;
    }
  };
  const check = () => checkAcceptanceManifest(manifest, manifestPath, { trustedSigstoreIdentity: identity });
  const cert = { runInvocationURI: `https://github.com/bigKING67/whoami/actions/runs/${receipt.runId}/attempts/1`, sourceRepositoryDigest: receipt.sourceCommit };
  fakeGh(`echo '${JSON.stringify([{ verificationResult: { signature: { certificate: cert } } }])}'`);
  assert.equal(withPath(check).runtimeVerified, true);
  fakeGh(`echo 'Loaded 1 attestation from bundle' >&2; echo 'Error: verification failed: no matching attestations' >&2; exit 1`);
  withPath(() => rejects(check, "ACCEPTANCE_RECEIPT_MISMATCH"));
  fakeGh(`echo 'Loaded 1 attestation from bundle' >&2; echo 'Error: failed to verify: dial tcp: lookup tuf-repo-cdn.sigstore.dev: no such host' >&2; exit 1`);
  withPath(() => rejects(check, "INVALID_ACCEPTANCE_RECEIPT"));
});
