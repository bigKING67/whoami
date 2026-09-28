# 真实宿主运行回执：GitHub Actions + Sigstore 方案（草案，待确认）

2026-09-28。目标：让自然语言前向验收能从 `partial` 升级为 `verified`，且“verified”只来自一个操作者事后无法伪造的签发环境。本文只是设计；工作流草稿在 [drafts/forward-attest.yml](drafts/forward-attest.yml)，未放入 `.github/workflows/`，不会运行，也不含任何密钥。

## 为什么不是本机签名

现有 v2 回执流程（`attestation-prepare` → 外部 Ed25519 签名 → `attestation-finalize`）要求签发方**真实观察到运行**。私钥若由维护者在本机持有，签名只证明“维护者提交了这些文件”，与[验收绑定](../../references/acceptance.md)中“不得凭自签材料升级为 verified”冲突。

GitHub artifact attestation 由 GitHub Actions 的 OIDC 身份经 Sigstore（Fulcio 短期证书 + Rekor 透明日志）签发：证书写明仓库、工作流文件、ref、提交 SHA 与 run ID。签名在 runner 内完成，维护者没有可导出的私钥，事后不能为另一份产物补签。本仓库为公开仓库，可免费使用。

## 信任边界（必须如实写进结论）

- **证明了什么**：某次 `forward-attest.yml` 运行（固定仓库、工作流路径、提交）产生了这些逐字节产物；宿主 CLI 版本与模型声明取自该运行内宿主自身输出的事件流，而非操作者填写。
- **没有证明什么**：模型提供方内部实际使用的权重；输出语义正确或预测有效；事后的人工 review。review 仍是维护者评审，结论中与生成来源分开陈述。
- **前提**：工作流文件、runner 脚本与 Skill 快照都在被签名的提交里；任何人改工作流都会改变证书中的身份，验证时按预期身份拒绝。

## 设计

### 1. 触发与隔离

- 只允许 `workflow_dispatch`，输入为 `suites/<id>` 目录；禁止 `push`/`pull_request` 触发，避免外部提交借机读取密钥。
- 使用 GitHub Environment `forward-attest`：配置**必需审批人**（你本人），模型 API key 只作为该 Environment 的 secret 暴露给这一 job。
- `permissions: { contents: read, id-token: write, attestations: write }`；checkout 设 `persist-credentials: false`；所有 action 按 SHA 固定（与现有 CI 一致）。
- `concurrency` 串行、`timeout-minutes` 与宿主 `--max-turns` 双重限额，控制费用。
- **只允许合成出生资料**：日志与产物公开，Rekor 记录公开。runner 拒绝没有 `synthetic: true` 标记的输入。

### 2. 运行（新增 `scripts/forward-run.mjs`）

1. 读取套件内冻结的 `task.md`、`rubric.md`、`input*.json`；把当前 `SKILL.md` 与 references 打成快照并记录哈希。
2. 用本仓库 CLI 为每个 case 重算 context（与验收器一致）。
3. 以无头模式启动宿主（候选：Claude Code `claude -p --output-format stream-json`，或 `codex exec --json`），工作目录为本仓库，提示为冻结的 task。
4. 从宿主事件流中提取：模型标识、宿主版本、最终答复、实际工具调用；原样保存事件流。
5. 生成 `runtime.receipt=null` 的 draft manifest 与 `whoami.runtime-run.v1`，再调用现有 `attestation-prepare` 得到 canonical payload。

### 3. 签发

- 把 canonical payload 原始字节写成 `payload.bin`，用 `actions/attest-build-provenance`（或 `actions/attest`）以其为 subject 签发；attestation bundle 与全部产物作为 workflow artifact 上传。
- 维护者下载产物后，review 按 rubric 人工完成，写入 manifest 的 `review`。

### 4. 新回执类型 `whoami.runtime-receipt.v3`（需实现）

```json
{
  "schema": "whoami.runtime-receipt.v3",
  "runId": "GitHub run id",
  "startedAt": "…",
  "runtime": { "provider": "…", "model": "取自宿主事件流", "modelVersion": "…", "reasoningEffort": null, "temperature": null, "seed": null },
  "payloadSha256": "canonical payload 摘要（不含 review）",
  "sigstoreBundle": { "path": "attestation.sigstore.json", "sha256": "…", "bytes": 1 },
  "expectedIdentity": {
    "repo": "bigKING67/whoami",
    "signerWorkflow": "bigKING67/whoami/.github/workflows/forward-attest.yml",
    "sourceRef": "refs/heads/main"
  }
}
```

与 v2 的差别：v2 的 payload 含 review；v3 只签**生成来源**（Skill 快照、task、rubric、case 产物、runtime、runner 提交），因为 review 发生在签发之后。`acceptance-check` 对 v3：

1. 重算 payload（不含 review）并比对 `payloadSha256`；
2. 调用 `gh attestation verify payload.bin --bundle <bundle> --repo … --signer-workflow … --source-ref …`（需要网络取 Sigstore trusted root；也可预先导出 trusted root 离线验证）；
3. 验证通过后 `runtimeVerified=true`；最终状态 `verified` 仍要求 review 存在，且结果中标注“review 为维护者评审，未经独立签发”。

`--trusted-runtime-key` 与 v2 流程保持不变；v3 用新参数 `--trusted-sigstore-identity` 指定期望身份，不能由 manifest 自带身份自证。

## 已定决定与进度

- 宿主：Claude Code（`claude -p --output-format stream-json`，固定 2.1.283，套件固定模型与 `--max-turns`，工具只放行 `Read` 与 `node dist/cli.js`）。
- 验证：`acceptance-check --sigstore-repo … --sigstore-workflow … --sigstore-ref …`，内部调用 `gh attestation verify`（需要网络与 gh CLI）。
- 已实现：`scripts/forward-run.mjs`（运行、合成资料守卫、回放模式、`--finalize` 回填 bundle）、`whoami.runtime-receipt.v3` 与 `generationAttestationPayload`、`acceptance-check` 的 v3 核验（验证器可注入测试）、首个套件 `suites/forward-attest/attest-001`。回放测试覆盖 verified、身份缺失、签发无效与产物改动。
- 待你操作：在 Settings → Environments 新建 `forward-attest`，设必需审批人（你本人），添加 secret `ANTHROPIC_API_KEY`。完成后告知，我把 [drafts/forward-attest.yml](drafts/forward-attest.yml) 移入 `.github/workflows/`，由你手动触发首跑。
- 首跑后：下载产物，按 rubric 填写 manifest.review，运行
  `node dist/cli.js acceptance-check --manifest <out>/manifest.json --sigstore-repo bigKING67/whoami --sigstore-workflow bigKING67/whoami/.github/workflows/forward-attest.yml --sigstore-ref refs/heads/main`，预期 `verified`，并写质量记录。
