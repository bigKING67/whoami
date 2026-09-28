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

## 审查后的修订（2026-09-28）

代码审查指出两处设计漏洞，已修正：

1. **review 未签发导致 verified 可伪造**：只签生成来源时，任何人都可把清单里的 review 从 FAIL 改为 PASS。现在 review 必须经第二个工作流 [forward-review.yml](drafts/forward-review.yml) 在 CI 内签发：维护者手动触发并以输入提交 review，工作流先核验生成签发，再对“生成载荷摘要 + 量表哈希 + review”签发（`whoami.review-attestation.v1`）。v3 只有生成与 review 两份签发都有效才可能 `verified`；review 内容仍是维护者人工评审，结果中如实标注。
2. **模型与签发权限同处一个 job**：模型可用 Bash 改写产物或读取 OIDC 请求变量。现在拆为两个 job：`generate` 持有 API key、运行模型、无签发权限；`attest` 无 API key、不运行模型，先核对 Skill 快照、task、rubric、输入与提交中的原件逐字节一致、context 可由 CLI 重算，再从落盘产物重算载荷后签发。模型能影响的只剩它自己的答复与事件流。

第二轮审查又指出：签发 job 仍直接采用生成 job 写出的运行时、模型列表与答复，而模型留下的后台进程可在宿主退出后改写这些文件。现已改为：runner 在内存中收集宿主完整输出，宿主退出后结束其整个进程组，之后才创建产物目录；事件流逐 case 纳入签发载荷（`eventLogs`）；签发 job 与 `acceptance-check` 都从事件流重新推导运行时、模型列表与答复并与落盘文件比对（共用 `src/host-events.ts`）；事件流中出现声明模型以外的模型时在结果中披露。签发 job 还要求运行 ID 与源码提交等于本次工作流，套件须位于本提交的 `suites/forward-attest/<id>`。

生成 job 上传前检查产物中是否出现 API key 原文：模型的 Bash 继承环境变量，而 artifact 公开且不经 GitHub 屏蔽。

另外：签发载荷绑定源码提交与宿主事件流中实际出现的全部模型（`observedModels`）；核验时比对证书中的运行 ID 与源码提交；`gh` 未登录、网络或超时等环境问题单独报错，不误报为伪造；context 失败时在调用模型前中止。

## 已定决定与进度

- 宿主：Claude Code 2.1.283，套件固定模型与 `--max-turns`，工具只放行 `Read` 与 `node dist/cli.js`。
- 验证：`acceptance-check --sigstore-repo bigKING67/whoami --sigstore-workflow bigKING67/whoami/.github/workflows/forward-attest.yml --sigstore-ref refs/heads/main --sigstore-review-workflow bigKING67/whoami/.github/workflows/forward-review.yml`，内部调用 `gh attestation verify`（需要网络与已登录的 gh）。
- 已实现并用回放测试覆盖：runner（生成、重算载荷与签发前核对、回填、review 写入与回填）、v3 回执与两种载荷、`acceptance-check` 的双签发核验。
- **待你操作**：
  1. Settings → Environments 新建 `forward-attest`：勾选 Required reviewers（你本人），添加 secret `ANTHROPIC_API_KEY`。
  2. 再新建 `forward-review`：勾选 Required reviewers（你本人），不需要 secret。
  3. 告诉我完成后，我把两个草稿移入 `.github/workflows/`。
- **首跑流程**：手动触发 Forward attest（套件 `attest-001`）→ 下载 `forward-attest-<run id>` 产物，按 rubric 阅读两个 case 的答复 → 手动触发 Forward review，填生成运行 ID 与 review JSON → 下载 `forward-review-<run id>`，本地运行上面的 acceptance-check，预期 `verified`（review 为 PASS 时）。
