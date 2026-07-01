import { Buffer } from "node:buffer";

export type BeamWorkStatus = "claimed" | "tempfailed" | "permfailed" | "succeeded";

export interface BeamTask {
  id: string;
  from: string;
  to: string[];
  body?: unknown;
  metadata?: unknown;
  ttl?: string;
  failure_strategy?: unknown;
  [key: string]: unknown;
}

export interface BeamResult {
  from: string;
  to: string[];
  task: string;
  status: BeamWorkStatus;
  body?: unknown;
  metadata?: unknown;
  [key: string]: unknown;
}

export interface PolicyContext {
  phase: "input" | "output";
  app_id: string;
  evaluated_at: string;
}

export type PolicyInput = Record<string, unknown> & {
  policy_context: PolicyContext;
};

/**
 * Beam decrypts task/result bodies before returning them to the local app.
 * Some applications additionally encode their JSON payload as Base64. For the
 * policy evaluation we try JSON first and Base64-encoded JSON second, while the
 * original Beam object itself remains unchanged on the forwarding path.
 */
export function decodeBodyForPolicy(body: unknown): unknown {
  if (typeof body !== "string") {
    return body;
  }

  const trimmed = body.trim();
  if (trimmed.length === 0) {
    return body;
  }

  const directJson = tryParseJson(trimmed);
  if (directJson.ok) {
    return directJson.value;
  }

  const decoded = tryDecodeBase64(trimmed);
  if (decoded === undefined) {
    return body;
  }

  const decodedJson = tryParseJson(decoded);
  if (decodedJson.ok) {
    return decodedJson.value;
  }

  return body;
}

export function mapTaskToPolicyInput(task: BeamTask, appId: string): PolicyInput {
  return {
    ...task,
    body: decodeBodyForPolicy(task.body),
    policy_context: {
      phase: "input",
      app_id: appId,
      evaluated_at: new Date().toISOString(),
    },
  };
}

export function mapResultToPolicyInput(
  result: BeamResult,
  taskId: string,
  appId: string,
): PolicyInput {
  return {
    ...result,
    task: result.task || taskId,
    body: decodeBodyForPolicy(result.body),
    policy_context: {
      phase: "output",
      app_id: appId,
      evaluated_at: new Date().toISOString(),
    },
  };
}

export function createInputDeniedResult(
  task: BeamTask,
  appId: string,
): BeamResult {
  return {
    from: appId,
    to: [task.from],
    task: task.id,
    status: "permfailed",
    metadata: {
      policy_denied: true,
      phase: "input",
    },
    body: encodeJsonBody({
      code: "POLICY_INPUT_DENIED",
      message: "The search request was denied by the local access-control policy.",
    }),
  };
}

export function createOutputDeniedResult(
  original: BeamResult,
  taskId: string,
  appId: string,
): BeamResult {
  return {
    from: appId,
    to: Array.isArray(original.to) ? original.to : [],
    task: original.task || taskId,
    status: "permfailed",
    metadata: {
      policy_denied: true,
      phase: "output",
    },
    body: encodeJsonBody({
      code: "POLICY_OUTPUT_DENIED",
      message: "The query result was denied by the local access-control policy.",
    }),
  };
}

function encodeJsonBody(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

function tryParseJson(value: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(value) };
  } catch {
    return { ok: false };
  }
}

function tryDecodeBase64(value: string): string | undefined {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");

  // Avoid treating ordinary text as Base64. Padding is optional for URL-safe Base64.
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(normalized) || normalized.length < 4) {
    return undefined;
  }

  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");

  try {
    const buffer = Buffer.from(padded, "base64");
    if (buffer.length === 0) {
      return undefined;
    }

    const text = buffer.toString("utf8").trim();
    return text.length > 0 ? text : undefined;
  } catch {
    return undefined;
  }
}
