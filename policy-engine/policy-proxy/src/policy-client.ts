export type PolicyFailMode = "open" | "closed";

export interface PolicyDecision {
  allow: boolean;
  reason?: string | undefined;
  evaluationMs?: number | undefined;
}

export interface PolicyClientOptions {
  engineUrl: string;
  inputPolicyPath: string;
  outputPolicyPath: string;
  failMode: PolicyFailMode;
  timeoutMs?: number;
}

interface OpaResponse {
  result?: boolean | { allow?: boolean; reason?: string };
}

export class PolicyClient {
  private readonly engineUrl: string;
  private readonly inputPolicyPath: string;
  private readonly outputPolicyPath: string;
  private readonly failMode: PolicyFailMode;
  private readonly timeoutMs: number;

  public constructor(options: PolicyClientOptions) {
    this.engineUrl = options.engineUrl.replace(/\/+$/, "");
    this.inputPolicyPath = normalizePath(options.inputPolicyPath);
    this.outputPolicyPath = normalizePath(options.outputPolicyPath);
    this.failMode = options.failMode;
    this.timeoutMs = options.timeoutMs ?? 5_000;
  }

  public authorizeInput(input: unknown): Promise<PolicyDecision> {
    // Input policies decide whether a retrieved Beam task may be shown to Focus.
    return this.evaluate(this.inputPolicyPath, input, "input");
  }

  public authorizeOutput(input: unknown): Promise<PolicyDecision> {
    // Output policies decide whether a claimed/succeeded result may leave the site.
    return this.evaluate(this.outputPolicyPath, input, "output");
  }

  public async health(): Promise<boolean> {
    try {
      const response = await fetch(`${this.engineUrl}/health`, {
        method: "GET",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  private async evaluate(
    path: string,
    input: unknown,
    phase: "input" | "output",
  ): Promise<PolicyDecision> {
    // The policy engine gets a simple { input: ... } payload so the proxy can swap
    // OPA later for another engine behind the same internal decision format.
    const start = performance.now();

    try {
      const response = await fetch(`${this.engineUrl}${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({ input }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });

      if (!response.ok) {
        throw new Error(`Policy engine returned HTTP ${response.status}`);
      }

      const payload = (await response.json()) as OpaResponse;
      const decision = normalizeOpaDecision(payload);
      const evaluationMs = Math.round((performance.now() - start) * 100) / 100;

      if (decision === undefined) {
        // An undefined OPA result generally means that the requested rule/path
        // does not exist. Treat this as a deny rather than silently allowing it.
        return {
          allow: false,
          evaluationMs,
          reason: `No ${phase} policy decision was returned. Check the configured policy path.`,
        };
      }

      return {
        ...decision,
        evaluationMs,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[policy-proxy] ${phase} policy evaluation failed: ${message}`);

      return {
        allow: this.failMode === "open",
        evaluationMs: Math.round((performance.now() - start) * 100) / 100,
        reason:
          this.failMode === "open"
            ? `Policy engine unavailable; allowed because POLICY_FAIL_MODE=open (${message})`
            : `Policy engine unavailable; denied because POLICY_FAIL_MODE=closed (${message})`,
      };
    }
  }
}

function normalizeOpaDecision(payload: OpaResponse): PolicyDecision | undefined {
  // OPA may return either a plain boolean or an object with allow/reason.
  // This helper normalizes both variants into one proxy-internal format.
  if (typeof payload.result === "boolean") {
    return { allow: payload.result };
  }

  if (payload.result && typeof payload.result.allow === "boolean") {
    return payload.result.reason === undefined
      ? { allow: payload.result.allow }
      : { allow: payload.result.allow, reason: payload.result.reason };
  }

  return undefined;
}

function normalizePath(path: string): string {
  // Config may contain the path with or without a leading slash.
  return path.startsWith("/") ? path : `/${path}`;
}
