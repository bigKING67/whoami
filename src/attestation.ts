import {
  createHash,
  createPublicKey,
  verify as verifySignature,
  type KeyObject,
} from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { InputError } from "./input.js";

export type RuntimeIdentity = {
  provider: string;
  model: string;
  modelVersion: string;
  reasoningEffort: string;
  temperature: string | number | null;
  seed: string | number | null;
};

export type RuntimeBindings = {
  skill: string;
  task: string;
  rubric: string;
  cases: {
    id: string;
    input: string;
    context: string;
    response: string;
    report?: string;
    responseClaims?: string;
  }[];
};

export type AttestedReview = {
  status: "PASS" | "PARTIAL" | "FAIL";
  factErrors: number;
  premiseOmissions: number;
  candidateMixing: number;
  unsupportedTimingClaims: number;
  unsafeClaims: number;
};

export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean")
    return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new InputError(
        "INVALID_ACCEPTANCE_RECEIPT",
        "attestation canonical JSON 不接受非有限数字",
      );
    return JSON.stringify(value);
  }
  if (Array.isArray(value))
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
      .join(",")}}`;
  }
  throw new InputError(
    "INVALID_ACCEPTANCE_RECEIPT",
    "attestation canonical JSON 出现不支持的值",
  );
}

export function runtimeAttestationPayload(value: {
  suiteId: string;
  runId: string;
  startedAt: string;
  runtime: RuntimeIdentity;
  bindings: RuntimeBindings;
  review: AttestedReview;
}) {
  return Buffer.from(
    canonicalJson({
      schema: "whoami.runtime-attestation.v2",
      suiteId: value.suiteId,
      runId: value.runId,
      startedAt: value.startedAt,
      runtime: value.runtime,
      bindings: value.bindings,
      review: value.review,
    }),
    "utf8",
  );
}

/**
 * v3 生成来源载荷：与 v2 绑定相同的 Skill、任务、量表与逐 case 产物，另绑定运行所在的源码提交
 * 与宿主事件流中实际出现的全部模型；不含 review——review 由维护者事后经单独的 CI 签发。
 */
export function generationAttestationPayload(value: {
  suiteId: string;
  runId: string;
  startedAt: string;
  sourceCommit: string;
  runtime: RuntimeIdentity;
  observedModels: string[];
  bindings: RuntimeBindings;
}) {
  return Buffer.from(
    canonicalJson({
      schema: "whoami.generation-attestation.v1",
      suiteId: value.suiteId,
      runId: value.runId,
      startedAt: value.startedAt,
      sourceCommit: value.sourceCommit,
      runtime: value.runtime,
      observedModels: value.observedModels,
      bindings: value.bindings,
    }),
    "utf8",
  );
}

/** v3 review 载荷：把维护者 review 绑定到一次已签发的生成载荷，签发后 review 不能再被改动。 */
export function reviewAttestationPayload(value: {
  suiteId: string;
  generationPayloadSha256: string;
  rubric: string;
  review: AttestedReview;
}) {
  return Buffer.from(
    canonicalJson({
      schema: "whoami.review-attestation.v1",
      suiteId: value.suiteId,
      generationPayloadSha256: value.generationPayloadSha256,
      rubric: value.rubric,
      review: value.review,
    }),
    "utf8",
  );
}

export function ed25519PublicKeyId(key: KeyObject) {
  const der = key.export({ format: "der", type: "spki" });
  return `ed25519:${createHash("sha256").update(der).digest("hex")}`;
}

export function readTrustedEd25519PublicKey(path: string) {
  let resolvedPath: string;
  let pem: Buffer;
  try {
    resolvedPath = realpathSync(path);
    pem = readFileSync(resolvedPath);
  } catch {
    throw new InputError(
      "INVALID_ACCEPTANCE_RECEIPT",
      "trusted runtime key 文件不可读",
    );
  }
  if (
    pem.byteLength > 16_384 ||
    !pem.toString("utf8").includes("-----BEGIN PUBLIC KEY-----")
  )
    throw new InputError(
      "INVALID_ACCEPTANCE_RECEIPT",
      "trusted runtime key 必须是 PEM SPKI 公钥",
    );
  let key: KeyObject;
  try {
    key = createPublicKey(pem);
  } catch {
    throw new InputError(
      "INVALID_ACCEPTANCE_RECEIPT",
      "trusted runtime key 无法解析",
    );
  }
  if (key.asymmetricKeyType !== "ed25519")
    throw new InputError(
      "INVALID_ACCEPTANCE_RECEIPT",
      "trusted runtime key 必须是 Ed25519 公钥",
    );
  return { key, keyId: ed25519PublicKeyId(key), resolvedPath };
}

export function decodeCanonicalBase64(value: string) {
  const decoded = Buffer.from(value, "base64");
  if (!decoded.length || decoded.toString("base64") !== value)
    throw new InputError(
      "INVALID_ACCEPTANCE_RECEIPT",
      "runtime attestation.signature 必须是规范 base64",
    );
  return decoded;
}

export function verifyEd25519Attestation(
  payload: Buffer,
  signature: Buffer,
  key: KeyObject,
) {
  return verifySignature(null, payload, key, signature);
}
