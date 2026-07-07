import type { BeamResult, BeamTask } from "./task-mapper.js";
import { Buffer } from "node:buffer";

export interface BeamResponse {
  status: number;
  statusText: string;
  headers: Headers;
  body: Buffer;
}

export interface BeamClientOptions {
  upstreamUrl: string;
  timeoutMs?: number;
}

export class BeamClient {
  private readonly upstreamUrl: string;
  private readonly timeoutMs: number;

  public constructor(options: BeamClientOptions) {
    this.upstreamUrl = options.upstreamUrl.replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  public async getTasks(pathWithQuery: string, headers: HeadersInit): Promise<{
    response: BeamResponse;
    tasks: BeamTask[];
  }> {
    // Task polling is special because the caller needs both the raw HTTP response
    // and the parsed task array for later policy evaluation.
    const response = await this.request("GET", pathWithQuery, headers);

    if (response.status < 200 || response.status >= 300) {
      return { response, tasks: [] };
    }

    let value: unknown;
    try {
      value = JSON.parse(response.body.toString("utf8"));
    } catch (error) {
      throw new Error(
        `Beam proxy returned invalid JSON for ${pathWithQuery}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    if (!Array.isArray(value)) {
      throw new Error("Beam proxy task response is not an array");
    }

    return { response, tasks: value as BeamTask[] };
  }

  public putResult(
    taskId: string,
    appId: string,
    result: BeamResult,
    headers: HeadersInit,
  ): Promise<BeamResponse> {
    // Result submission always uses Beam's task/result route and forwards JSON.
    const path = `/v1/tasks/${encodeURIComponent(taskId)}/results/${encodeURIComponent(appId)}`;
    return this.request("PUT", path, withJsonContentType(headers), Buffer.from(JSON.stringify(result)));
  }

  public request(
    method: string,
    pathWithQuery: string,
    headers: HeadersInit,
    body?: Buffer,
  ): Promise<BeamResponse> {
    return this.performRequest(method, pathWithQuery, headers, body);
  }

  private async performRequest(
    method: string,
    pathWithQuery: string,
    headers: HeadersInit,
    body?: Buffer,
  ): Promise<BeamResponse> {
    // This method is the low-level transport wrapper around fetch. It keeps the
    // server code free from repetitive timeout and response-buffer handling.
    const init: RequestInit = {
      method,
      headers,
      signal: AbortSignal.timeout(this.timeoutMs),
      redirect: "manual",
    };

    if (body && body.length > 0) {
      init.body = new Uint8Array(body);
    }

    const response = await fetch(`${this.upstreamUrl}${pathWithQuery}`, init);

    return {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
      body: Buffer.from(await response.arrayBuffer()),
    };
  }
}

function withJsonContentType(headers: HeadersInit): Headers {
  // We rebuild these headers because the proxy becomes the new HTTP sender.
  const result = new Headers(headers);
  result.set("content-type", "application/json");
  result.delete("content-length");
  result.delete("host");
  return result;
}
