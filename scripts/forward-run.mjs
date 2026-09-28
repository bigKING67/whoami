#!/usr/bin/env node
// 真实宿主前向验收 runner（设计见 docs/research/runtime-attestation-sigstore.md）。
// 运行：node scripts/forward-run.mjs --suite <dir> --out <dir> [--host claude|replay] [--replay <dir>]
// 收尾：node scripts/forward-run.mjs --finalize <out> --bundle <sigstore bundle>
// 只接受 suite.json 标记 synthetic:true 的合成资料：产物、日志与透明日志记录均公开。
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { generationAttestationPayload } = await import(join(root, "dist/attestation.js"));

const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, value, i, all) => (value.startsWith("--") ? [...pairs, [value.slice(2), all[i + 1]]] : pairs), []),
);
const fail = (message) => {
  console.error(message);
  process.exit(1);
};
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const artifact = (dir, rel) => {
  const bytes = readFileSync(join(dir, rel));
  return { path: rel, sha256: sha256(bytes), bytes: bytes.length };
};
const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + "\n");

if (args.finalize) finalize(resolve(args.finalize), args.bundle);
else run();

function run() {
  if (!args.suite || !args.out) fail("用法：--suite <dir> --out <dir> [--host claude|replay] [--replay <dir>]");
  const suiteDir = resolve(args.suite);
  const out = resolve(process.env.INIT_CWD ?? process.cwd(), args.out);
  if (existsSync(out)) fail(`输出目录已存在，不覆盖：${out}`);
  const suite = JSON.parse(readFileSync(join(suiteDir, "suite.json"), "utf8"));
  if (suite.schema !== "whoami.forward-suite.v1") fail("suite.json schema 须为 whoami.forward-suite.v1");
  if (suite.synthetic !== true) fail("只允许 synthetic:true 的合成资料套件：产物与日志公开");
  const host = args.host ?? "claude";
  if (host === "replay" && !args.replay) fail("--host replay 需要 --replay <目录>");
  const startedAt = new Date().toISOString();
  const runId = process.env.GITHUB_RUN_ID ?? `local-${Date.now()}`;

  mkdirSync(out, { recursive: true });
  copyFileSync(join(root, "SKILL.md"), join(out, "SKILL.snapshot.md"));
  copyFileSync(join(suiteDir, suite.task), join(out, "task.md"));
  copyFileSync(join(suiteDir, suite.rubric), join(out, "rubric.md"));
  const task = readFileSync(join(out, "task.md"), "utf8");

  const runtimes = [];
  const cases = suite.cases.map((c) => {
    const dir = join(out, c.id);
    mkdirSync(dir);
    copyFileSync(join(suiteDir, c.input), join(dir, "input.json"));
    // context 用本仓库 CLI 重算，与验收器一致；needs-input 时 stdout 仍是验收可绑定的 chart。
    const ctxArgs = ["dist/cli.js", "context", "--input", join(dir, "input.json"), "--years", suite.years.join(",")];
    if (suite.granularity) ctxArgs.push("--granularity", suite.granularity);
    const ctx = spawnSync(process.execPath, ctxArgs, { cwd: root, encoding: "utf8" });
    writeFileSync(join(dir, "context.json"), ctx.stdout || ctx.stderr);

    const prompt = `${task}\n\n请以本仓库 SKILL.md 为 skill 作答。出生资料文件：${join(dir, "input.json")}`;
    let events;
    if (host === "replay") events = readFileSync(join(resolve(args.replay), `${c.id}.events.jsonl`), "utf8");
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

    // 模型声明取自宿主事件流（system/init），答复取自 result 事件，均不由操作者填写。
    const parsed = events.split("\n").filter(Boolean).map((line) => JSON.parse(line));
    const init = parsed.find((e) => e.type === "system" && e.subtype === "init");
    const result = parsed.findLast((e) => e.type === "result");
    if (!init?.model) fail(`${c.id}: 事件流缺少 system/init 的 model`);
    if (typeof result?.result !== "string" || result.is_error) fail(`${c.id}: 事件流缺少成功的 result`);
    writeFileSync(join(dir, "response.md"), result.result);
    runtimes.push({ model: init.model, version: init.claude_code_version ?? "unknown" });
    return {
      id: c.id,
      input: artifact(out, `${c.id}/input.json`),
      context: artifact(out, `${c.id}/context.json`),
      response: artifact(out, `${c.id}/response.md`),
    };
  });

  if (new Set(runtimes.map((r) => `${r.model}|${r.version}`)).size !== 1) fail("各 case 的宿主模型或版本不一致");
  const runtime = {
    provider: "anthropic/claude-code",
    model: runtimes[0].model,
    modelVersion: `claude-code ${runtimes[0].version}`,
    reasoningEffort: "host-default",
    temperature: null,
    seed: null,
  };
  const skill = artifact(out, "SKILL.snapshot.md");
  const taskArtifact = artifact(out, "task.md");
  const rubric = artifact(out, "rubric.md");
  const payload = generationAttestationPayload({
    suiteId: suite.id,
    runId,
    startedAt,
    runtime,
    bindings: {
      skill: skill.sha256,
      task: taskArtifact.sha256,
      rubric: rubric.sha256,
      cases: cases.map((c) => ({ id: c.id, input: c.input.sha256, context: c.context.sha256, response: c.response.sha256 })),
    },
  });
  writeFileSync(join(out, "payload.bin"), payload);
  writeJson(join(out, "receipt.json"), {
    schema: "whoami.runtime-receipt.v3",
    runId,
    startedAt,
    runtime,
    bindings: {
      skill: skill.sha256,
      task: taskArtifact.sha256,
      rubric: rubric.sha256,
      cases: cases.map((c) => ({ id: c.id, input: c.input.sha256, context: c.context.sha256, response: c.response.sha256 })),
    },
    payloadSha256: sha256(payload),
    // 由 --finalize 在签发后回填。
    sigstoreBundle: null,
  });
  // review 须由维护者按 rubric 事后填写；未填写前 acceptance-check 会拒绝。
  writeJson(join(out, "manifest.json"), {
    schema: "whoami.acceptance-run.v1",
    suiteId: suite.id,
    skill,
    task: taskArtifact,
    rubric,
    cases,
    runtime: { ...runtime, receipt: null },
    review: null,
  });
  console.log(JSON.stringify({ out, runId, payloadSha256: sha256(payload), cases: cases.length }));
}

function finalize(out, bundle) {
  if (!bundle) fail("--finalize 需要 --bundle <sigstore bundle>");
  copyFileSync(resolve(bundle), join(out, "attestation.sigstore.json"));
  const receipt = JSON.parse(readFileSync(join(out, "receipt.json"), "utf8"));
  receipt.sigstoreBundle = artifact(out, "attestation.sigstore.json");
  writeJson(join(out, "receipt.json"), receipt);
  const manifest = JSON.parse(readFileSync(join(out, "manifest.json"), "utf8"));
  manifest.runtime.receipt = artifact(out, "receipt.json");
  writeJson(join(out, "manifest.json"), manifest);
  console.log(JSON.stringify({ out, receipt: manifest.runtime.receipt }));
}
