import { InputError } from "./input.js";

/**
 * 从 Claude Code `--output-format stream-json` 事件流推导运行事实：声明模型、宿主版本、实际出现的全部模型
 * 与最终答复。runner 与 acceptance-check 共用，签发与核验都只信任事件流，不信任生成 job 写出的 JSON。
 */
export function deriveHostRun(events: string, label: string) {
  let parsed: Record<string, unknown>[];
  try {
    parsed = events
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  } catch {
    throw new InputError("INVALID_HOST_EVENTS", `${label} 事件流不是逐行 JSON`);
  }
  const init = parsed.find((e) => e.type === "system" && e.subtype === "init");
  const result = [...parsed].reverse().find((e) => e.type === "result");
  if (typeof init?.model !== "string" || !init.model)
    throw new InputError("INVALID_HOST_EVENTS", `${label} 事件流缺少 system/init 的 model`);
  if (typeof result?.result !== "string" || result.is_error === true)
    throw new InputError("INVALID_HOST_EVENTS", `${label} 事件流缺少成功的 result`);
  const assistantModels = parsed
    .filter((e) => e.type === "assistant")
    .map((e) => (e.message as { model?: unknown } | undefined)?.model)
    .filter((m): m is string => typeof m === "string" && m.length > 0);
  const usageModels = Object.keys((result.modelUsage as Record<string, unknown> | undefined) ?? {});
  return {
    model: init.model,
    version: typeof init.claude_code_version === "string" ? init.claude_code_version : "unknown",
    observedModels: [...new Set([init.model, ...assistantModels, ...usageModels])].sort(),
    response: result.result,
  };
}

/** 各 case 的宿主运行汇总为运行时声明；声明模型或版本不一致时拒绝。 */
export function hostRuntime(runs: ReturnType<typeof deriveHostRun>[]) {
  if (!runs.length || new Set(runs.map((r) => `${r.model}|${r.version}`)).size !== 1)
    throw new InputError("INVALID_HOST_EVENTS", "各 case 的宿主声明模型或版本不一致");
  return {
    runtime: {
      provider: "anthropic/claude-code",
      model: runs[0]!.model,
      modelVersion: `claude-code ${runs[0]!.version}`,
      reasoningEffort: "host-default",
      temperature: null,
      seed: null,
    },
    observedModels: [...new Set(runs.flatMap((r) => r.observedModels))].sort(),
  };
}
