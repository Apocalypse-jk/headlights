import { Buffer } from "node:buffer";
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http";
import process from "node:process";

import { BeamClient, type BeamResponse } from "./beam-client.js";
import { PolicyClient, type PolicyFailMode } from "./policy-client.js";
import {
  createInputDeniedResult,
  createOutputDeniedResult,
  mapResultToPolicyInput,
  mapTaskToPolicyInput,
  type BeamResult,
  type BeamTask,
} from "./task-mapper.js";

const config = {
  bindAddress: env("BIND_ADDR", "0.0.0.0:4002"),
  upstreamBeamProxyUrl: requiredEnv("UPSTREAM_BEAM_PROXY_URL"),
  policyEngineUrl: requiredEnv("POLICY_ENGINE_URL"),
  inputPolicyPath: env("INPUT_POLICY_PATH", "/v1/data/input/allow_access"),
  outputPolicyPath: env("OUTPUT_POLICY_PATH", "/v1/data/output/allow_output"),
  beamAppId: requiredEnv("BEAM_APP_ID"),
  failMode: parseFailMode(env("POLICY_FAIL_MODE", "closed")),
  maxBodyBytes: parsePositiveInteger(env("MAX_BODY_BYTES", String(11 * 1024 * 1024))),
  upstreamTimeoutMs: parsePositiveInteger(env("UPSTREAM_TIMEOUT_MS", "30000")),
  policyTimeoutMs: parsePositiveInteger(env("POLICY_TIMEOUT_MS", "5000")),
};

const beamClient = new BeamClient({
  upstreamUrl: config.upstreamBeamProxyUrl,
  timeoutMs: config.upstreamTimeoutMs,
});

const policyClient = new PolicyClient({
  engineUrl: config.policyEngineUrl,
  inputPolicyPath: config.inputPolicyPath,
  outputPolicyPath: config.outputPolicyPath,
  failMode: config.failMode,
  timeoutMs: config.policyTimeoutMs,
});

const server = createServer(async (request, response) => {
  try {
    await route(request, response);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[policy-proxy] request failed: ${message}`);

    if (!response.headersSent) {
      sendJson(response, 502, {
        code: "POLICY_PROXY_ERROR",
        message,
      });
    } else {
      response.end();
    }
  }
});

const { host, port } = parseBindAddress(config.bindAddress);
server.listen(port, host, () => {
  console.log(`[policy-proxy] listening on http://${host}:${port}`);
  console.log(`[policy-proxy] Beam upstream: ${config.upstreamBeamProxyUrl}`);
  console.log(`[policy-proxy] Policy engine: ${config.policyEngineUrl}`);
  console.log(`[policy-proxy] Fail mode: ${config.failMode}`);
});

async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const method = request.method ?? "GET";
  const pathWithQuery = request.url ?? "/";
  const url = new URL(pathWithQuery, "http://policy-proxy.local");

  if (method === "GET" && url.pathname === "/v1/health") {
    await handleHealth(request, response, pathWithQuery);
    return;
  }

  if (method === "GET" && url.pathname === "/v1/tasks") {
    await handleTaskRetrieval(request, response, pathWithQuery);
    return;
  }

  const resultRoute = url.pathname.match(/^\/v1\/tasks\/([^/]+)\/results\/([^/]+)$/);
  if (method === "PUT" && resultRoute?.[1] && resultRoute[2]) {
    await handleResultSubmission(
      request,
      response,
      decodeURIComponent(resultRoute[1]),
      decodeURIComponent(resultRoute[2]),
    );
    return;
  }

  // Health checks and any currently unused Beam endpoints are forwarded
  // transparently. Only task retrieval and result submission are intercepted.
  await forwardUnmodified(request, response, pathWithQuery);
}


async function handleHealth(
  request: IncomingMessage,
  response: ServerResponse,
  pathWithQuery: string,
): Promise<void> {
  const upstream = await beamClient.request(
    "GET",
    pathWithQuery,
    forwardRequestHeaders(request.headers),
  );

  if (upstream.status < 200 || upstream.status >= 300) {
    writeBeamResponse(response, upstream);
    return;
  }

  if (!(await policyClient.health())) {
    sendJson(response, 503, {
      code: "POLICY_ENGINE_UNAVAILABLE",
      message: "The Beam proxy is healthy, but the policy engine is unavailable.",
    });
    return;
  }

  // Preserve Beam.Proxy's successful health response.
  writeBeamResponse(response, upstream);
}

async function handleTaskRetrieval(
  request: IncomingMessage,
  response: ServerResponse,
  pathWithQuery: string,
): Promise<void> {
  const headers = forwardRequestHeaders(request.headers);
  const { response: upstream, tasks } = await beamClient.getTasks(pathWithQuery, headers);
  console.log(`[policy-proxy] task retrieval: upstream HTTP ${upstream.status}, tasks=${tasks.length}`);

  if (upstream.status < 200 || upstream.status >= 300) {
    writeBeamResponse(response, upstream);
    return;
  }

  const evaluated = await Promise.all(
    tasks.map(async (task) => ({
      task,
      decision: await policyClient.authorizeInput(mapTaskToPolicyInput(task, config.beamAppId)),
    })),
  );

  const allowedTasks: BeamTask[] = [];

  for (const { task, decision } of evaluated) {
    console.log(
      `[policy-proxy] input decision for task ${task.id}: ${decision.allow ? "allow" : "deny"}`,
    );

    if (decision.allow) {
      allowedTasks.push(task);
      continue;
    }

    console.warn(`[policy-proxy] input denied for task ${task.id}: ${decision.reason ?? "policy returned false"}`);

    const denial = createInputDeniedResult(task, config.beamAppId);
    const denialResponse = await beamClient.putResult(
      task.id,
      config.beamAppId,
      denial,
      headers,
    );

    if (denialResponse.status < 200 || denialResponse.status >= 300) {
      console.error(
        `[policy-proxy] could not store denial result for task ${task.id}: HTTP ${denialResponse.status}`,
      );
    }
  }

  const responseHeaders = filteredResponseHeaders(upstream.headers);
  responseHeaders.set("content-type", "application/json");
  responseHeaders.delete("content-length");

  response.writeHead(upstream.status, Object.fromEntries(responseHeaders.entries()));
  response.end(JSON.stringify(allowedTasks));
}

async function handleResultSubmission(
  request: IncomingMessage,
  response: ServerResponse,
  taskId: string,
  pathAppId: string,
): Promise<void> {
  const body = await readRequestBody(request, config.maxBodyBytes);

  let result: BeamResult;
  try {
    result = JSON.parse(body.toString("utf8")) as BeamResult;
  } catch {
    sendJson(response, 400, {
      code: "INVALID_BEAM_RESULT",
      message: "The request body must contain a valid Beam result JSON object.",
    });
    return;
  }

  const decision = await policyClient.authorizeOutput(
    mapResultToPolicyInput(result, taskId, pathAppId),
  );
  console.log(
    `[policy-proxy] output decision for task ${taskId}, status=${result.status}: ${
      decision.allow ? "allow" : "deny"
    }`,
  );

  const forwardedResult = decision.allow
    ? result
    : createOutputDeniedResult(result, taskId, pathAppId);

  if (!decision.allow) {
    console.warn(
      `[policy-proxy] output denied for task ${taskId}; forwarding a permfailed replacement instead of the original result`,
    );
  }

  const upstream = await beamClient.putResult(
    taskId,
    pathAppId,
    forwardedResult,
    forwardRequestHeaders(request.headers),
  );

  writeBeamResponse(response, upstream);
}

async function forwardUnmodified(
  request: IncomingMessage,
  response: ServerResponse,
  pathWithQuery: string,
): Promise<void> {
  const method = request.method ?? "GET";
  const body = method === "GET" || method === "HEAD"
    ? undefined
    : await readRequestBody(request, config.maxBodyBytes);

  const upstream = await beamClient.request(
    method,
    pathWithQuery,
    forwardRequestHeaders(request.headers),
    body,
  );

  writeBeamResponse(response, upstream, method === "HEAD");
}

function writeBeamResponse(
  response: ServerResponse,
  upstream: BeamResponse,
  omitBody = false,
): void {
  const headers = filteredResponseHeaders(upstream.headers);
  headers.delete("content-length");

  response.writeHead(upstream.status, Object.fromEntries(headers.entries()));
  response.end(omitBody ? undefined : upstream.body);
}

function forwardRequestHeaders(headers: IncomingHttpHeaders): Headers {
  const result = new Headers();

  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || HOP_BY_HOP_HEADERS.has(name.toLowerCase())) {
      continue;
    }

    if (Array.isArray(value)) {
      for (const entry of value) {
        result.append(name, entry);
      }
    } else {
      result.set(name, value);
    }
  }

  result.delete("host");
  result.delete("content-length");
  return result;
}

function filteredResponseHeaders(headers: Headers): Headers {
  const result = new Headers();

  headers.forEach((value, name) => {
    if (!HOP_BY_HOP_HEADERS.has(name.toLowerCase())) {
      result.set(name, value);
    }
  });

  return result;
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

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
}

function env(name: string, fallback: string): string {
  return process.env[name]?.trim() || fallback;
}

function parseFailMode(value: string): PolicyFailMode {
  if (value === "open" || value === "closed") {
    return value;
  }
  throw new Error(`POLICY_FAIL_MODE must be 'open' or 'closed', received '${value}'`);
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

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);
