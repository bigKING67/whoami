#!/usr/bin/env node
// 真实宿主前向验收 runner（设计见 docs/research/runtime-attestation-sigstore.md）。
//   生成：    --suite <dir> --out <dir> [--host claude|replay] [--replay <dir>]
//   重算载荷：--repayload <out>                    （签发 job 用：只信任落盘产物，不信任生成 job 写的载荷）
//   回填签发：--finalize <out> --bundle <file>
//   写入评审：--review <out> --review-json <file>   （review 工作流用）
//   回填评审：--finalize-review <out> --bundle <file>
// 只接受 suite.json 标记 synthetic:true 的合成资料：产物、日志与透明日志记录均公开。
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { generationAttestationPayload, reviewAttestationPayload } = await import(join(root, "dist/attestation.js"));

const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, value, i, all) => (value.startsWith("--") ? [...pairs, [value.slice(2), all[i + 1]]] : pairs), []),
);
// npm run 会把 cwd 切到仓库根；所有路径统一按用户执行命令的目录解析。
const base = process.env.INIT_CWD ?? process.cwd();
const path = (p) => resolve(base, p);
const fail = (message) => {
  console.error(message);
  process.exit(1);
};
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const artifact = (dir, rel) => {
  const bytes = readFileSync(join(dir, rel));
  return { path: rel, sha256: sha256(bytes), bytes: bytes.length };
};
const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
const writeJson = (p, value) => writeFileSync(p, JSON.stringify(value, null, 2) + "\n");

if (args.repayload) repayload(path(args.repayload));
else if (args.finalize) attachBundle(path(args.finalize), args.bundle, false);
else if (args.review) review(path(args.review), args["review-json"]);
else if (args["finalize-review"]) attachBundle(path(args["finalize-review"]), args.bundle, true);
else generate();

/** 从落盘产物重算清单绑定与生成载荷；生成与签发两个 job 共用，避免两份绑定逻辑。 */
function repayload(out) {
  const manifest = readJson(join(out, "manifest.json"));
  const receipt = readJson(join(out, "receipt.json"));
  verifySources(out, manifest);
  manifest.skill = artifact(out, "SKILL.snapshot.md");
  manifest.task = artifact(out, "task.md");
  manifest.rubric = artifact(out, "rubric.md");
  manifest.cases = manifest.cases.map((c) => ({
    id: c.id,
    input: artifact(out, `${c.id}/input.json`),
    context: artifact(out, `${c.id}/context.json`),
    response: artifact(out, `${c.id}/response.md`),
  }));
  const bindings = {
    skill: manifest.skill.sha256,
    task: manifest.task.sha256,
    rubric: manifest.rubric.sha256,
    cases: manifest.cases.map((c) => ({ id: c.id, input: c.input.sha256, context: c.context.sha256, response: c.response.sha256 })),
  };
  const { receipt: _r, ...runtime } = manifest.runtime;
  const payload = generationAttestationPayload({
    suiteId: manifest.suiteId,
    runId: receipt.runId,
    startedAt: receipt.startedAt,
    sourceCommit: receipt.sourceCommit,
    runtime,
    observedModels: receipt.observedModels,
    bindings,
  });
  writeFileSync(join(out, "payload.bin"), payload);
  Object.assign(receipt, { runtime, bindings, payloadSha256: sha256(payload), sigstoreBundle: null, review: null });
  writeJson(join(out, "receipt.json"), receipt);
  manifest.runtime.receipt = null;
  writeJson(join(out, "manifest.json"), manifest);
  console.log(JSON.stringify({ out, payloadSha256: sha256(payload) }));
}

/**
 * 签发前核对：Skill 快照、任务、量表与输入须与本提交中的原件逐字节一致，context 须可由 CLI 重算得到。
 * 生成 job 中的模型能写产物目录，这一步让它只能影响自己的答复与事件流。
 */
function verifySources(out, manifest) {
  const suiteDir = join(root, "suites/forward-attest", manifest.suiteId);
  const suite = readJson(join(suiteDir, "suite.json"));
  const same = (a, b, label) => {
    if (!readFileSync(a).equals(readFileSync(b))) fail(`签发前核对失败：${label} 与提交中的原件不一致`);
  };
  same(join(out, "SKILL.snapshot.md"), join(root, "SKILL.md"), "SKILL 快照");
  same(join(out, "task.md"), join(suiteDir, suite.task), "task");
  same(join(out, "rubric.md"), join(suiteDir, suite.rubric), "rubric");
  if (manifest.cases.map((c) => c.id).join() !== suite.cases.map((c) => c.id).join()) fail("签发前核对失败：case 列表与套件不一致");
  for (const c of suite.cases) {
    same(join(out, c.id, "input.json"), join(suiteDir, c.input), `${c.id} 输入`);
    const ctxArgs = ["dist/cli.js", "context", "--input", join(suiteDir, c.input), "--years", suite.years.join(",")];
    if (suite.granularity) ctxArgs.push("--granularity", suite.granularity);
    const ctx = spawnSync(process.execPath, ctxArgs, { cwd: root, encoding: "utf8" });
    if (ctx.stdout !== readFileSync(join(out, c.id, "context.json"), "utf8")) fail(`签发前核对失败：${c.id} context 无法由 CLI 重算得到`);
  }
}

function generate() {
  if (!args.suite || !args.out) fail("用法：--suite <dir> --out <dir> [--host claude|replay] [--replay <dir>]");
  const suiteDir = path(args.suite);
  const out = path(args.out);
  if (existsSync(out)) fail(`输出目录已存在，不覆盖：${out}`);
  const suite = readJson(join(suiteDir, "suite.json"));
  if (suite.schema !== "whoami.forward-suite.v1") fail("suite.json schema 须为 whoami.forward-suite.v1");
  if (suite.synthetic !== true) fail("只允许 synthetic:true 的合成资料套件：产物与日志公开");
  const host = args.host ?? "claude";
  if (host === "replay" && !args.replay) fail("--host replay 需要 --replay <目录>");
  const sourceCommit =
    process.env.GITHUB_SHA ?? spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).stdout.trim();
  if (!/^[0-9a-f]{40}$/u.test(sourceCommit)) fail("无法确定源码提交");
  const startedAt = new Date().toISOString();
  const runId = process.env.GITHUB_RUN_ID ?? `local-${Date.now()}`;

  mkdirSync(out, { recursive: true });
  copyFileSync(join(root, "SKILL.md"), join(out, "SKILL.snapshot.md"));
  copyFileSync(join(suiteDir, suite.task), join(out, "task.md"));
  copyFileSync(join(suiteDir, suite.rubric), join(out, "rubric.md"));
  const task = readFileSync(join(out, "task.md"), "utf8");

  const hostRuns = suite.cases.map((c) => {
    const dir = join(out, c.id);
    mkdirSync(dir);
    copyFileSync(join(suiteDir, c.input), join(dir, "input.json"));
    // context 用本仓库 CLI 重算，与验收器一致；失败时在调用模型前中止，不产生费用与签发。
    const ctxArgs = ["dist/cli.js", "context", "--input", join(dir, "input.json"), "--years", suite.years.join(",")];
    if (suite.granularity) ctxArgs.push("--granularity", suite.granularity);
    const ctx = spawnSync(process.execPath, ctxArgs, { cwd: root, encoding: "utf8" });
    if (ctx.status !== 0 && ctx.status !== 2) fail(`${c.id}: context 计算失败：${ctx.stderr.trim()}`);
    writeFileSync(join(dir, "context.json"), ctx.stdout);

    const prompt = `${task}\n\n请以本仓库 SKILL.md 为 skill 作答。出生资料文件：${join(dir, "input.json")}`;
    let events;
    if (host === "replay") events = readFileSync(join(path(args.replay), `${c.id}.events.jsonl`), "utf8");
    else if (host === "claude") {
      const r = spawnSync(
        "claude",
        [
          "-p", prompt,
          "--output-format", "stream-json", "--verbose",
          "--model", suite.model,
          "--max-turns", String(suite.maxTurns),
          "--allowedTools", "Read", "Bash(node dist/cli.js:*)",
        ],
        { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
      );
      if (r.error) fail(`无法启动 claude：${r.error.message}`);
      events = r.stdout;
    } else fail(`未知宿主 ${host}`);
    writeFileSync(join(dir, "events.jsonl"), events);

    // 模型取自宿主事件流：init 的声明模型，加上 assistant 消息与 result.modelUsage 中实际出现的全部模型。
    const parsed = events.split("\n").filter(Boolean).map((line) => JSON.parse(line));
    const init = parsed.find((e) => e.type === "system" && e.subtype === "init");
    const result = parsed.findLast((e) => e.type === "result");
    if (!init?.model) fail(`${c.id}: 事件流缺少 system/init 的 model`);
    if (typeof result?.result !== "string" || result.is_error) fail(`${c.id}: 事件流缺少成功的 result`);
    writeFileSync(join(dir, "response.md"), result.result);
    const models = new Set([
      init.model,
      ...parsed.filter((e) => e.type === "assistant" && e.message?.model).map((e) => e.message.model),
      ...Object.keys(result.modelUsage ?? {}),
    ]);
    return { id: c.id, model: init.model, version: init.claude_code_version ?? "unknown", models };
  });

  if (new Set(hostRuns.map((r) => `${r.model}|${r.version}`)).size !== 1) fail("各 case 的宿主声明模型或版本不一致");
  const runtime = {
    provider: "anthropic/claude-code",
    model: hostRuns[0].model,
    modelVersion: `claude-code ${hostRuns[0].version}`,
    reasoningEffort: "host-default",
    temperature: null,
    seed: null,
  };
  writeJson(join(out, "manifest.json"), {
    schema: "whoami.acceptance-run.v1",
    suiteId: suite.id,
    cases: hostRuns.map((r) => ({ id: r.id })),
    runtime: { ...runtime, receipt: null },
    // review 须由维护者按 rubric 事后填写，并经 review 工作流签发。
    review: null,
  });
  writeJson(join(out, "receipt.json"), {
    schema: "whoami.runtime-receipt.v3",
    runId,
    startedAt,
    sourceCommit,
    observedModels: [...new Set(hostRuns.flatMap((r) => [...r.models]))].sort(),
  });
  repayload(out);
}

function review(out, reviewPath) {
  if (!reviewPath) fail("--review 需要 --review-json <file>");
  const reviewValue = readJson(path(reviewPath));
  const counts = ["factErrors", "premiseOmissions", "candidateMixing", "unsupportedTimingClaims", "unsafeClaims"];
  if (!["PASS", "PARTIAL", "FAIL"].includes(reviewValue.status) || counts.some((k) => !Number.isInteger(reviewValue[k]) || reviewValue[k] < 0))
    fail("review 须含 status（PASS/PARTIAL/FAIL）与五项非负整数计数");
  const manifest = readJson(join(out, "manifest.json"));
  const receipt = readJson(join(out, "receipt.json"));
  const normalized = { status: reviewValue.status, ...Object.fromEntries(counts.map((k) => [k, reviewValue[k]])) };
  const payload = reviewAttestationPayload({
    suiteId: manifest.suiteId,
    generationPayloadSha256: receipt.payloadSha256,
    rubric: manifest.rubric.sha256,
    review: normalized,
  });
  writeFileSync(join(out, "review-payload.bin"), payload);
  manifest.review = normalized;
  writeJson(join(out, "manifest.json"), manifest);
  receipt.review = { runId: process.env.GITHUB_RUN_ID ?? `local-${Date.now()}`, payloadSha256: sha256(payload), sigstoreBundle: null };
  writeJson(join(out, "receipt.json"), receipt);
  console.log(JSON.stringify({ out, reviewPayloadSha256: sha256(payload) }));
}

function attachBundle(out, bundle, isReview) {
  if (!bundle) fail("需要 --bundle <sigstore bundle>");
  const name = isReview ? "review.sigstore.json" : "attestation.sigstore.json";
  copyFileSync(path(bundle), join(out, name));
  const receipt = readJson(join(out, "receipt.json"));
  if (isReview) {
    if (!receipt.review) fail("receipt 尚无 review，先运行 --review");
    receipt.review.sigstoreBundle = artifact(out, name);
  } else receipt.sigstoreBundle = artifact(out, name);
  writeJson(join(out, "receipt.json"), receipt);
  const manifest = readJson(join(out, "manifest.json"));
  manifest.runtime.receipt = artifact(out, "receipt.json");
  writeJson(join(out, "manifest.json"), manifest);
  console.log(JSON.stringify({ out, receipt: manifest.runtime.receipt }));
}
