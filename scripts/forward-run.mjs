#!/usr/bin/env node
// 真实宿主前向验收 runner（设计见 docs/research/runtime-attestation-sigstore.md）。
//   生成：    --suite <dir> --out <dir> [--host claude|replay] [--replay <dir>]
//   签发前重算：--repayload <out>   （签发 job 用：核对原件、从事件流重新推导，不信任生成 job 写的 JSON）
//   回填签发：--finalize <out> --bundle <file>
//   写入评审：--review <out> --review-json <file>   （review 工作流用）
//   回填评审：--finalize-review <out> --bundle <file>
// 只接受 suite.json 标记 synthetic:true 的合成资料：产物、日志与透明日志记录均公开。
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { generationAttestationPayload, reviewAttestationPayload } = await import(join(root, "dist/attestation.js"));
const { deriveHostRun, hostRuntime } = await import(join(root, "dist/host-events.js"));
const { verifyReview } = await import(join(root, "dist/acceptance.js"));

const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, value, i, all) => (value.startsWith("--") ? [...pairs, [value.slice(2), all[i + 1]]] : pairs), []),
);
// 只有经 npm run 启动（cwd 被切到仓库根）时才按 INIT_CWD 解析；直接 node 调用按 cwd，避免继承的 INIT_CWD 错位。
const base = process.env.INIT_CWD && process.cwd() === root ? process.env.INIT_CWD : process.cwd();
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
const suiteOf = (suiteDir) => {
  const suite = readJson(join(suiteDir, "suite.json"));
  if (suite.schema !== "whoami.forward-suite.v1") fail("suite.json schema 须为 whoami.forward-suite.v1");
  if (suite.synthetic !== true) fail("只允许 synthetic:true 的合成资料套件：产物与日志公开");
  return suite;
};

/** 用本仓库 CLI 计算 context；needs-input（退出 2）的 stdout 也是验收可绑定的 chart。其他失败视为工具错误。 */
function computeContext(inputPath, suite, label) {
  const ctxArgs = ["dist/cli.js", "context", "--input", inputPath, "--years", suite.years.join(",")];
  if (suite.granularity) ctxArgs.push("--granularity", suite.granularity);
  const ctx = spawnSync(process.execPath, ctxArgs, { cwd: root, encoding: "utf8" });
  if (ctx.error || (ctx.status !== 0 && ctx.status !== 2))
    fail(`${label}: context 计算失败（工具错误，非篡改）：${ctx.error?.message ?? ctx.stderr.trim()}`);
  return ctx.stdout;
}

/** 启动宿主并收集完整输出；宿主退出后结束其整个进程组，模型留下的后台进程无法事后改写产物。 */
function runClaude(prompt, suite) {
  return new Promise((done) => {
    const child = spawn(
      "claude",
      [
        "-p", prompt,
        "--output-format", "stream-json", "--verbose",
        "--model", suite.model,
        "--max-turns", String(suite.maxTurns),
        "--allowedTools", "Read", "Bash(node dist/cli.js:*)",
      ],
      { cwd: root, detached: true, stdio: ["ignore", "pipe", "inherit"] },
    );
    const chunks = [];
    child.stdout.on("data", (c) => chunks.push(c));
    child.on("error", (e) => fail(`无法启动 claude：${e.message}`));
    child.on("close", () => {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // 进程组已全部退出。
      }
      done(Buffer.concat(chunks).toString("utf8"));
    });
  });
}

if (args.repayload) repayload(path(args.repayload));
else if (args.finalize) attachBundle(path(args.finalize), args.bundle, false);
else if (args.review) review(path(args.review), args["review-json"]);
else if (args["finalize-review"]) attachBundle(path(args["finalize-review"]), args.bundle, true);
else await generate();

/** 从落盘产物构建清单绑定与生成载荷；运行时与模型列表由事件流推导后传入。 */
function buildPayload(out, manifest, receipt, runs) {
  const { runtime, observedModels } = hostRuntime(runs);
  manifest.skill = artifact(out, "SKILL.snapshot.md");
  manifest.task = artifact(out, "task.md");
  manifest.rubric = artifact(out, "rubric.md");
  manifest.cases = manifest.cases.map((c) => ({
    id: c.id,
    input: artifact(out, `${c.id}/input.json`),
    context: artifact(out, `${c.id}/context.json`),
    response: artifact(out, `${c.id}/response.md`),
  }));
  manifest.runtime = { ...runtime, receipt: null };
  const eventLogs = manifest.cases.map((c) => ({ id: c.id, ...artifact(out, `${c.id}/events.jsonl`) }));
  const bindings = {
    skill: manifest.skill.sha256,
    task: manifest.task.sha256,
    rubric: manifest.rubric.sha256,
    cases: manifest.cases.map((c) => ({ id: c.id, input: c.input.sha256, context: c.context.sha256, response: c.response.sha256 })),
  };
  const payload = generationAttestationPayload({
    suiteId: manifest.suiteId,
    runId: receipt.runId,
    startedAt: receipt.startedAt,
    sourceCommit: receipt.sourceCommit,
    runtime,
    observedModels,
    bindings,
    eventLogs: eventLogs.map(({ id, sha256: digest }) => ({ id, sha256: digest })),
  });
  writeFileSync(join(out, "payload.bin"), payload);
  Object.assign(receipt, { runtime, observedModels, bindings, eventLogs, payloadSha256: sha256(payload), sigstoreBundle: null, review: null });
  writeJson(join(out, "receipt.json"), receipt);
  writeJson(join(out, "manifest.json"), manifest);
  console.log(JSON.stringify({ out, payloadSha256: sha256(payload) }));
}

/**
 * 签发 job：套件须位于本提交的 suites/forward-attest 下；Skill 快照、task、rubric、输入须与原件逐字节一致，
 * context 须可由 CLI 重算；答复、运行时与模型列表从事件流重新推导。运行 ID 与源码提交须与本次工作流一致。
 */
function repayload(out) {
  const manifest = readJson(join(out, "manifest.json"));
  const receipt = readJson(join(out, "receipt.json"));
  const suiteDir = resolve(root, receipt.suitePath ?? "");
  const rel = relative(join(root, "suites", "forward-attest"), suiteDir);
  if (!receipt.suitePath || rel === "" || rel.startsWith("..") || isAbsolute(rel) || rel.includes(sep))
    fail("签发只接受本提交 suites/forward-attest/<id> 下的套件");
  const suite = suiteOf(suiteDir);
  if (suite.id !== manifest.suiteId) fail("签发前核对失败：suiteId 与套件不一致");
  if (process.env.GITHUB_SHA && receipt.sourceCommit !== process.env.GITHUB_SHA) fail("签发前核对失败：源码提交与本次工作流不一致");
  if (process.env.GITHUB_RUN_ID && receipt.runId !== process.env.GITHUB_RUN_ID) fail("签发前核对失败：运行 ID 与本次工作流不一致");
  const same = (a, b, label) => {
    if (!readFileSync(a).equals(readFileSync(b))) fail(`签发前核对失败：${label} 与提交中的原件不一致`);
  };
  same(join(out, "SKILL.snapshot.md"), join(root, "SKILL.md"), "SKILL 快照");
  same(join(out, "task.md"), join(suiteDir, suite.task), "task");
  same(join(out, "rubric.md"), join(suiteDir, suite.rubric), "rubric");
  if (manifest.cases.map((c) => c.id).join() !== suite.cases.map((c) => c.id).join()) fail("签发前核对失败：case 列表与套件不一致");
  const runs = suite.cases.map((c) => {
    same(join(out, c.id, "input.json"), join(suiteDir, c.input), `${c.id} 输入`);
    if (computeContext(join(suiteDir, c.input), suite, c.id) !== readFileSync(join(out, c.id, "context.json"), "utf8"))
      fail(`签发前核对失败：${c.id} context 无法由 CLI 重算得到`);
    const run = deriveHostRun(readFileSync(join(out, c.id, "events.jsonl"), "utf8"), c.id);
    if (run.response !== readFileSync(join(out, c.id, "response.md"), "utf8")) fail(`签发前核对失败：${c.id} 答复与事件流不一致`);
    return run;
  });
  buildPayload(out, manifest, receipt, runs);
}

async function generate() {
  if (!args.suite || !args.out) fail("用法：--suite <dir> --out <dir> [--host claude|replay] [--replay <dir>]");
  const suiteDir = path(args.suite);
  const out = path(args.out);
  if (existsSync(out)) fail(`输出目录已存在，不覆盖：${out}`);
  const suite = suiteOf(suiteDir);
  const host = args.host ?? "claude";
  if (host === "replay" && !args.replay) fail("--host replay 需要 --replay <目录>");
  if (host !== "replay" && host !== "claude") fail(`未知宿主 ${host}`);
  const sourceCommit =
    process.env.GITHUB_SHA ?? spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).stdout.trim();
  if (!/^[0-9a-f]{40}$/u.test(sourceCommit)) fail("无法确定源码提交");
  const startedAt = new Date().toISOString();
  const runId = process.env.GITHUB_RUN_ID ?? `local-${Date.now()}`;
  const task = readFileSync(join(suiteDir, suite.task), "utf8");

  // context 先算：失败时在调用模型前中止，不产生费用与签发。
  const contexts = suite.cases.map((c) => computeContext(join(suiteDir, c.input), suite, c.id));
  // 宿主全部结束（进程组已清理）后才创建产物目录并写入。
  const events = [];
  for (const c of suite.cases) {
    const prompt = `${task}\n\n请以本仓库 SKILL.md 为 skill 作答。出生资料文件：${join(suiteDir, c.input)}`;
    events.push(host === "replay" ? readFileSync(join(path(args.replay), `${c.id}.events.jsonl`), "utf8") : await runClaude(prompt, suite));
  }
  const runs = suite.cases.map((c, i) => deriveHostRun(events[i], c.id));

  mkdirSync(out, { recursive: true });
  copyFileSync(join(root, "SKILL.md"), join(out, "SKILL.snapshot.md"));
  copyFileSync(join(suiteDir, suite.task), join(out, "task.md"));
  copyFileSync(join(suiteDir, suite.rubric), join(out, "rubric.md"));
  suite.cases.forEach((c, i) => {
    mkdirSync(join(out, c.id));
    copyFileSync(join(suiteDir, c.input), join(out, c.id, "input.json"));
    writeFileSync(join(out, c.id, "context.json"), contexts[i]);
    writeFileSync(join(out, c.id, "events.jsonl"), events[i]);
    writeFileSync(join(out, c.id, "response.md"), runs[i].response);
  });
  const suiteRel = relative(root, suiteDir);
  const manifest = {
    schema: "whoami.acceptance-run.v1",
    suiteId: suite.id,
    cases: suite.cases.map((c) => ({ id: c.id })),
    runtime: null,
    // review 须由维护者按 rubric 事后填写，并经 review 工作流签发。
    review: null,
  };
  const receipt = {
    schema: "whoami.runtime-receipt.v3",
    runId,
    startedAt,
    sourceCommit,
    suitePath: suiteRel.startsWith("..") || isAbsolute(suiteRel) ? suiteDir : suiteRel,
  };
  buildPayload(out, manifest, receipt, runs);
}

function review(out, reviewPath) {
  if (!reviewPath) fail("--review 需要 --review-json <file>");
  let normalized;
  try {
    // 与 acceptance-check 共用同一校验，避免 CI 永久签发一份核验必然拒绝的 review。
    normalized = (({ status, counts }) => ({ status, ...counts }))(verifyReview(readJson(path(reviewPath))));
  } catch (error) {
    fail(`review 无效：${error.message}`);
  }
  const manifest = readJson(join(out, "manifest.json"));
  const receipt = readJson(join(out, "receipt.json"));
  // 绑定刚由 gh 核验过的 payload.bin 本身，而非回执中的摘要字段。
  const generationPayloadSha256 = sha256(readFileSync(join(out, "payload.bin")));
  if (generationPayloadSha256 !== receipt.payloadSha256) fail("payload.bin 与回执中的 payloadSha256 不一致");
  const payload = reviewAttestationPayload({
    suiteId: manifest.suiteId,
    generationPayloadSha256,
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
