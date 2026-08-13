import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import process from "node:process";

import { newEnforcer, type Enforcer } from "casbin";

interface PolicyRequest {
  input?: unknown;
}

interface PolicyDecision {
  allow: boolean;
  reason?: string;
}

type JsonRecord = Record<string, unknown>;

const config = {
  bindAddress: env("BIND_ADDR", "0.0.0.0:8181"),
  modelPath: env("CASBIN_MODEL_PATH", "./model.conf"),
  policyPath: env("CASBIN_POLICY_PATH", "./policy.csv"),
  maxBodyBytes: parsePositiveInteger(env("MAX_BODY_BYTES", String(2 * 1024 * 1024))),
};

const enforcer = await newEnforcer(config.modelPath, config.policyPath);

const server = createServer(async (request, response) => {
  try {
    await route(request, response, enforcer);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[casbin-policy-engine] request failed: ${message}`);
    sendJson(response, 500, {
      result: {
        allow: false,
        reason: message,
      },
    });
  }
});

const { host, port } = parseBindAddress(config.bindAddress);
server.listen(port, host, () => {
  console.log(`[casbin-policy-engine] listening on http://${host}:${port}`);
  console.log(`[casbin-policy-engine] model: ${config.modelPath}`);
  console.log(`[casbin-policy-engine] policy: ${config.policyPath}`);
});

async function route(
  request: IncomingMessage,
  response: ServerResponse,
  enforcer: Enforcer,
): Promise<void> {
  const method = request.method ?? "GET";
  const url = new URL(request.url ?? "/", "http://casbin-policy-engine.local");

  if (method === "GET" && url.pathname === "/health") {
    sendJson(response, 200, { status: "ok" });
    return;
  }

  if (method !== "POST") {
    sendJson(response, 405, {
      result: {
        allow: false,
        reason: "Only POST policy evaluation requests are supported.",
      },
    });
    return;
  }

  if (url.pathname === "/v1/data/input/allow_access") {
    const policyRequest = await readPolicyRequest(request);
    const decision = await authorizeInput(enforcer, policyRequest.input);
    sendJson(response, 200, { result: decision });
    return;
  }

  if (url.pathname === "/v1/data/output/allow_output") {
    const policyRequest = await readPolicyRequest(request);
    const decision = await authorizeOutput(enforcer, policyRequest.input);
    sendJson(response, 200, { result: decision });
    return;
  }

  sendJson(response, 404, {
    result: {
      allow: false,
      reason: `Unknown policy path: ${url.pathname}`,
    },
  });
}

async function authorizeInput(enforcer: Enforcer, input: unknown): Promise<PolicyDecision> {
  const task = asRecord(input);
  const from = getString(task, "from");
  const targets = getStringArray(task?.to);

  if (from === undefined || targets.length === 0) {
    return {
      allow: false,
      reason: "Input policy denied because from/to is missing.",
    };
  }

  for (const target of targets) {
    if (await enforcer.enforce("input", from, target, "search")) {
      return { allow: true };
    }
  }

  return {
    allow: false,
    reason: `Input policy denied for from=${from}, to=${targets.join(",")}.`,
  };
}

async function authorizeOutput(enforcer: Enforcer, input: unknown): Promise<PolicyDecision> {
  const result = asRecord(input);

  if (result === undefined) {
    return {
      allow: false,
      reason: "Output policy denied because the policy input is not an object.",
    };
  }

  const from = getString(result, "from");
  const status = getString(result, "status");

  if (from === undefined || status === undefined) {
    return {
      allow: false,
      reason: "Output policy denied because from/status is missing.",
    };
  }

  const casbinAllowed = await enforcer.enforce("output", from, "result", status);
  if (!casbinAllowed) {
    return {
      allow: false,
      reason: `Casbin output policy denied for from=${from}, status=${status}.`,
    };
  }

  if (status === "claimed") {
    return { allow: true };
  }

  if (status !== "succeeded") {
    return {
      allow: false,
      reason: `Output policy denied unsupported status=${status}.`,
    };
  }

  const facts = outputFacts(result);

  if (facts.isSuperuserRequest) {
    return {
      allow: true,
      reason: "Allowed by original request metadata project:superuser.",
    };
  }

  if (!facts.requestContextFound) {
    return {
      allow: false,
      reason: "Output policy denied because the original request context is missing.",
    };
  }

  if (facts.patientCount < 50) {
    return {
      allow: false,
      reason: `Output policy denied because patient_count=${facts.patientCount} is below 50.`,
    };
  }

  if (facts.diagnosisCount < 50) {
    return {
      allow: false,
      reason: `Output policy denied because diagnosis_count=${facts.diagnosisCount} is below 50.`,
    };
  }

  if (!facts.genderPrivacyAllowed) {
    return {
      allow: false,
      reason: "Output policy denied because a gender bucket violates k-anonymity.",
    };
  }

  if (!facts.donorAgePrivacyAllowed) {
    return {
      allow: false,
      reason: "Output policy denied because a donor_age bucket violates k-anonymity.",
    };
  }

  if (!facts.sampleKindPrivacyAllowed) {
    return {
      allow: false,
      reason: "Output policy denied because a sample_kind bucket violates k-anonymity.",
    };
  }

  return { allow: true };
}

function outputFacts(input: JsonRecord): {
  requestContextFound: boolean;
  isSuperuserRequest: boolean;
  patientCount: number;
  diagnosisCount: number;
  genderPrivacyAllowed: boolean;
  donorAgePrivacyAllowed: boolean;
  sampleKindPrivacyAllowed: boolean;
} {
  const body = asRecord(input.body);
  const totals = asRecord(body?.totals);
  const stratifiers = asRecord(body?.stratifiers);
  const genderCounts = asRecord(stratifiers?.gender);
  const donorAgeCounts = asRecord(stratifiers?.donor_age);
  const sampleKindCounts = asRecord(stratifiers?.sample_kind);
  const requestContext = asRecord(input.request_context);

  return {
    requestContextFound: input.request_context_found === true,
    isSuperuserRequest: requestContext?.metadata === "project:superuser",
    patientCount: getNumber(totals, "patient", getNumber(totals, "result", 0)),
    diagnosisCount: getNumber(totals, "diagnosis", 0),
    genderPrivacyAllowed:
      privacyCheck(getNumber(genderCounts, "female", 0)) &&
      privacyCheck(getNumber(genderCounts, "male", 0)) &&
      privacyCheck(getNumber(genderCounts, "other", 0)),
    donorAgePrivacyAllowed: allCountsPassPrivacy(donorAgeCounts),
    sampleKindPrivacyAllowed: allCountsPassPrivacy(sampleKindCounts),
  };
}

function allCountsPassPrivacy(record: JsonRecord | undefined): boolean {
  if (record === undefined) {
    return true;
  }

  return Object.values(record).every((value) => typeof value === "number" && privacyCheck(value));
}

function privacyCheck(count: number): boolean {
  return count === 0 || count >= 10;
}

async function readPolicyRequest(request: IncomingMessage): Promise<PolicyRequest> {
  const body = await readRequestBody(request, config.maxBodyBytes);
  try {
    return JSON.parse(body.toString("utf8")) as PolicyRequest;
  } catch {
    throw new Error("Request body must be valid JSON.");
  }
}

async function readRequestBody(request: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;

    if (total > maxBytes) {
      throw new Error(`Request body exceeds configured limit of ${maxBytes} bytes`);
    }

    chunks.push(buffer);
  }

  return Buffer.concat(chunks);
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": body.length,
  });
  response.end(body);
}

function asRecord(value: unknown): JsonRecord | undefined {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as JsonRecord;
  }

  return undefined;
}

function getString(record: JsonRecord | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" ? value : undefined;
}

function getStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === "string");
  }

  return typeof value === "string" ? [value] : [];
}

function getNumber(record: JsonRecord | undefined, key: string, fallback: number): number {
  const value = record?.[key];
  return typeof value === "number" ? value : fallback;
}

function env(name: string, fallback: string): string {
  return process.env[name]?.trim() || fallback;
}

function parsePositiveInteger(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`Expected a positive integer, received '${value}'`);
  }
  return parsed;
}

function parseBindAddress(value: string): { host: string; port: number } {
  const separator = value.lastIndexOf(":");
  if (separator < 0) {
    return { host: "0.0.0.0", port: parsePositiveInteger(value) };
  }

  return {
    host: value.slice(0, separator) || "0.0.0.0",
    port: parsePositiveInteger(value.slice(separator + 1)),
  };
}
