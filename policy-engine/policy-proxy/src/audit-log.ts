import { mkdir, appendFile } from "node:fs/promises";
import { dirname } from "node:path";

export type AuditDecision = "allow" | "deny";

export interface AuditEvent {
  event: string;
  task_id?: string | undefined;
  app_id?: string | undefined;
  status?: string | undefined;
  decision?: AuditDecision | undefined;
  reason?: string | undefined;
  details?: Record<string, unknown> | undefined;
}

export interface AuditLogEntry extends AuditEvent {
  timestamp: string;
}

export interface AuditLoggerOptions {
  filePath: string | undefined;
  logToConsole: boolean;
}

export class AuditLogger {
  private readonly filePath: string | undefined;
  private readonly logToConsole: boolean;
  private writeQueue: Promise<void> = Promise.resolve();

  public constructor(options: AuditLoggerOptions) {
    this.filePath = options.filePath;
    this.logToConsole = options.logToConsole;

    if (this.filePath) {
      this.writeQueue = mkdir(dirname(this.filePath), { recursive: true }).then(() => undefined);
    }
  }

  public async start(): Promise<void> {
    await this.writeQueue;
  }

  public record(event: AuditEvent): void {
    const entry: AuditLogEntry = {
      timestamp: new Date().toISOString(),
      ...event,
    };

    if (this.logToConsole) {
      console.log(`[policy-proxy][audit] ${JSON.stringify(entry)}`);
    }

    if (!this.filePath) {
      return;
    }

    // Concurrent requests can produce audit entries at the same time. The queue
    // keeps file writes ordered and avoids interleaved JSON lines.
    this.writeQueue = this.writeQueue
      .then(() => appendFile(this.filePath!, `${JSON.stringify(entry)}\n`, "utf8"))
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[policy-proxy] audit log write failed: ${message}`);
      });
  }
}
