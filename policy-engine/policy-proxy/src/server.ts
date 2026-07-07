import { Buffer } from "node:buffer";
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http";
import process from "node:process";

import { AuditLogger } from "./audit-log.js";
import { BeamClient, type BeamResponse } from "./beam-client.js";
import { PolicyClient, type PolicyFailMode } from "./policy-client.js";
import { TaskContextStore } from "./task-store.js";
import {
  createInputDeniedResult,
  createOutputDeniedResult,
  mapResultToPolicyInput,
  mapTaskToPolicyInput,
  type BeamResult,
  type BeamTask,
  type PolicyInput,
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
  // Contexts are kept only temporarily. This prevents stale task entries from
  // staying in memory forever when Focus never submits a final result.
  taskContextTtlMs: parsePositiveInteger(env("TASK_CONTEXT_TTL_MS", String(60 * 60 * 1000))),
  auditLogPath: optionalEnv("AUDIT_LOG_PATH"),
  auditLogConsole: parseBoolean(env("AUDIT_LOG_CONSOLE", "true")),
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

const taskContexts = new TaskContextStore({
  // This store lives inside the current Node.js process. It is therefore shared
  // by concurrent requests handled by this policy-proxy instance, but not by
  // other containers or after a restart.
  ttlMs: config.taskContextTtlMs,
});

const auditLog = new AuditLogger({
  // The audit log is structured JSONL. That makes it easy to ingest later from a
  // small web UI, database importer, or log collector without parsing text logs.
  filePath: config.auditLogPath,
  logToConsole: config.auditLogConsole,
});

const server = createServer(async (request, response) => {
  try {
    await route(request, response);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[policy-proxy] request failed: ${message}`);
    auditLog.record({
      event: "request_failed",
      reason: message,
      details: {
        method: request.method,
        url: request.url,
      },
    });

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
  console.log(`[policy-proxy] Task context TTL: ${config.taskContextTtlMs}ms`);
  console.log(`[policy-proxy] Audit log: ${config.auditLogPath ?? "console only"}`);

  auditLog.record({
    event: "proxy_started",
    details: {
      bind_address: config.bindAddress,
      upstream_beam_proxy_url: config.upstreamBeamProxyUrl,
      policy_engine_url: config.policyEngineUrl,
      fail_mode: config.failMode,
      task_context_ttl_ms: config.taskContextTtlMs,
      audit_log_path: config.auditLogPath,
    },
  });
});

setInterval(() => {
  // Cleanup is intentionally periodic and lightweight. It handles old entries
  // for tasks that were allowed but never produced a terminal result.
  const removed = taskContexts.cleanup();
  if (removed > 0) {
    console.log(`[policy-proxy] removed ${removed} expired task context(s); remaining=${taskContexts.size()}`);
    auditLog.record({
      event: "task_context_cleanup",
      details: {
        removed,
        remaining: taskContexts.size(),
      },
    });
  }
}, Math.min(config.taskContextTtlMs, 60_000)).unref();

void auditLog.start();

async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
  // This is the central router of the policy proxy. It intercepts only the Beam
  // endpoints that matter for authorization and forwards all others unchanged.
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
  // The proxy is only considered healthy when the original Beam proxy answers
  // successfully and the policy engine can also be reached.
  const upstream = await beamClient.request(
    "GET",
    pathWithQuery,
    forwardRequestHeaders(request.headers),
  );

  if (upstream.status < 200 || upstream.status >= 300) {
    auditLog.record({
      event: "health_check",
      status: "upstream_unhealthy",
      details: {
        upstream_status: upstream.status,
      },
    });
    writeBeamResponse(response, upstream);
    return;
  }

  if (!(await policyClient.health())) {
    auditLog.record({
      event: "health_check",
      status: "policy_engine_unavailable",
      details: {
        upstream_status: upstream.status,
      },
    });
    sendJson(response, 503, {
      code: "POLICY_ENGINE_UNAVAILABLE",
      message: "The Beam proxy is healthy, but the policy engine is unavailable.",
    });
    return;
  }

  // Preserve Beam.Proxy's successful health response.
  auditLog.record({
    event: "health_check",
    status: "healthy",
    details: {
      upstream_status: upstream.status,
    },
  });
  writeBeamResponse(response, upstream);
}

async function handleTaskRetrieval(
  request: IncomingMessage,
  response: ServerResponse,
  pathWithQuery: string,
): Promise<void> {
  // Focus pulls pending tasks from this endpoint. We therefore fetch the tasks
  // from the real Beam proxy first and evaluate each task before returning it.
  const headers = forwardRequestHeaders(request.headers);
  const { response: upstream, tasks } = await beamClient.getTasks(pathWithQuery, headers);
  console.log(`[policy-proxy] task retrieval: upstream HTTP ${upstream.status}, tasks=${tasks.length}`);
  auditLog.record({
    event: "task_retrieval",
    details: {
      upstream_status: upstream.status,
      task_count: tasks.length,
    },
  });

  if (upstream.status < 200 || upstream.status >= 300) {
    writeBeamResponse(response, upstream);
    return;
  }

  const evaluated = await Promise.all(
    tasks.map(async (task) => {
      // The task mapper converts Beam-specific data into a policy input that OPA
      // can evaluate without the server having to know body encoding details.
      const input = mapTaskToPolicyInput(task, config.beamAppId);

      return {
        task,
        input,
        decision: await policyClient.authorizeInput(input),
      };
    }),
  );

  const allowedTasks: BeamTask[] = [];

  for (const { task, input, decision } of evaluated) {
    console.log(
      `[policy-proxy] input decision for task ${task.id}: ${decision.allow ? "allow" : "deny"}`,
    );
    auditLog.record({
      event: "input_policy_decision",
      task_id: task.id,
      app_id: config.beamAppId,
      decision: decision.allow ? "allow" : "deny",
      reason: decision.reason,
      details: {
        from: task.from,
        to: task.to,
      },
    });

    if (decision.allow) {
      // Store the decoded input context before handing the task to Focus. When
      // Focus later submits a result, the task ID lets us attach this original
      // request context to the output-policy input.
      taskContexts.remember(task.id, config.beamAppId, input);
      allowedTasks.push(task);
      continue;
    }

    // A denied task must still be completed on the Beam side. Otherwise Focus
    // would see the same blocked task again on the next poll.
    console.warn(`[policy-proxy] input denied for task ${task.id}: ${decision.reason ?? "policy returned false"}`);

    const denial = createInputDeniedResult(task, config.beamAppId);
    const denialResponse = await beamClient.putResult(
      task.id,
      config.beamAppId,
      denial,
      headers,
    );
    auditLog.record({
      event: "input_denial_result_forwarded",
      task_id: task.id,
      app_id: config.beamAppId,
      status: denial.status,
      details: {
        upstream_status: denialResponse.status,
      },
    });

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
  // Focus submits claimed/succeeded results here. Before the result leaves the
  // local site, the proxy evaluates whether the content is allowed to pass on.
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

  // The Beam task ID from the result route is the link back to the original
  // search request. If a context exists, the output policy can check both the
  // result and the request that caused it.
  const storedContext = taskContexts.get(taskId);
  const outputInput = withRequestContext(
    mapResultToPolicyInput(result, taskId, pathAppId),
    storedContext?.requestInput,
  );

  if (!storedContext) {
    console.warn(`[policy-proxy] no stored request context found for task ${taskId}`);
    auditLog.record({
      event: "task_context_missing",
      task_id: taskId,
      app_id: pathAppId,
      status: result.status,
    });
  }

  const decision = await policyClient.authorizeOutput(outputInput);
  console.log(
    `[policy-proxy] output decision for task ${taskId}, status=${result.status}: ${
      decision.allow ? "allow" : "deny"
    }`,
  );
  auditLog.record({
    event: "output_policy_decision",
    task_id: taskId,
    app_id: pathAppId,
    status: result.status,
    decision: decision.allow ? "allow" : "deny",
    reason: decision.reason,
    details: {
      from: result.from,
      to: result.to,
      request_context_found: storedContext !== undefined,
    },
  });

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
  auditLog.record({
    event: "output_result_forwarded",
    task_id: taskId,
    app_id: pathAppId,
    status: forwardedResult.status,
    decision: decision.allow ? "allow" : "deny",
    details: {
      upstream_status: upstream.status,
      forwarded_original_result: decision.allow,
    },
  });

  if (isTerminalStatus(result.status)) {
    // After a final result there should be no later output for this task. Removing
    // the context here keeps the in-memory Map bounded during parallel tests.
    taskContexts.delete(taskId);
    auditLog.record({
      event: "task_context_deleted",
      task_id: taskId,
      app_id: pathAppId,
      status: result.status,
    });
  }

  writeBeamResponse(response, upstream);
}

function withRequestContext(
  outputInput: PolicyInput,
  requestInput: PolicyInput | undefined,
): PolicyInput {
  // The output policy still receives the normal result-based input, but now with
  // two additional fields. Policies can require request_context_found=true when
  // they need the original query for their decision.
  return {
    ...outputInput,
    request_context_found: requestInput !== undefined,
    request_context: requestInput,
  };
}

function isTerminalStatus(status: BeamResult["status"]): boolean {
  // "claimed" is not terminal because Focus usually sends it before the final
  // succeeded/failed result. Keeping the context after claimed is therefore key.
  return status === "succeeded" || status === "permfailed";
}

async function forwardUnmodified(
  request: IncomingMessage,
  response: ServerResponse,
  pathWithQuery: string,
): Promise<void> {
  // Endpoints outside the authorization flow stay transparent so the proxy keeps
  // Beam-compatible behavior for callers that use other routes.
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
  // We buffer the body once so it can be parsed for policy checks and then reused
  // for forwarding without rereading the stream.
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

function optionalEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value && value.length > 0 ? value : undefined;
}

function parseBoolean(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  throw new Error(`Expected a boolean value, received '${value}'`);
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
