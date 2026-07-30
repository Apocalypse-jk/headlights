import { createHash } from "node:crypto";
import { mkdir, appendFile, readFile } from "node:fs/promises";
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
  sequence: number;
  previous_hash: string | null;
  entry_hash: string;
  hash_algorithm: "sha256";
}

type PendingAuditLogEntry = AuditEvent & {
  timestamp: string;
};

type HashableAuditLogEntry = PendingAuditLogEntry & {
  sequence: number;
  previous_hash: string | null;
  hash_algorithm: "sha256";
};

export interface AuditLoggerOptions {
  filePath: string | undefined;
  logToConsole: boolean;
}

export class AuditLogger {
  private readonly filePath: string | undefined;
  private readonly logToConsole: boolean;
  private writeQueue: Promise<void> = Promise.resolve();
  private previousHash: string | null = null;
  private nextSequence = 1;

  public constructor(options: AuditLoggerOptions) {
    this.filePath = options.filePath;
    this.logToConsole = options.logToConsole;

    if (this.filePath) {
      this.writeQueue = mkdir(dirname(this.filePath), { recursive: true })
        .then(() => this.initializeHashChainFromExistingLog());
    }
  }

  public async start(): Promise<void> {
    await this.writeQueue;
  }

  public record(event: AuditEvent): void {
    const pendingEntry: PendingAuditLogEntry = {
      timestamp: new Date().toISOString(),
      ...event,
    };

    // Concurrent requests can produce audit entries at the same time. The queue
    // keeps hash links and file writes ordered. Otherwise two parallel requests
    // could accidentally point to the same previous_hash.
    this.writeQueue = this.writeQueue
      .then(async () => {
        const entry = this.createHashLinkedEntry(pendingEntry);

        if (this.logToConsole) {
          console.log(`[policy-proxy][audit] ${JSON.stringify(entry)}`);
        }

        if (this.filePath) {
          await appendFile(this.filePath, `${JSON.stringify(entry)}\n`, "utf8");
        }
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[policy-proxy] audit log write failed: ${message}`);
      });
  }

  private createHashLinkedEntry(pendingEntry: PendingAuditLogEntry): AuditLogEntry {
    const hashableEntry: HashableAuditLogEntry = {
      ...pendingEntry,
      sequence: this.nextSequence,
      previous_hash: this.previousHash,
      hash_algorithm: "sha256",
    };
    const entryHash = sha256(stableStringify(hashableEntry));
    const entry: AuditLogEntry = {
      ...hashableEntry,
      entry_hash: entryHash,
    };

    this.previousHash = entryHash;
    this.nextSequence += 1;

    return entry;
  }

  private async initializeHashChainFromExistingLog(): Promise<void> {
    if (!this.filePath) {
      return;
    }

    try {
      const content = await readFile(this.filePath, "utf8");
      const lastLine = content
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .at(-1);

      if (!lastLine) {
        return;
      }

      const lastEntry = JSON.parse(lastLine) as Partial<AuditLogEntry>;
      if (typeof lastEntry.entry_hash === "string") {
        this.previousHash = lastEntry.entry_hash;
      }
      if (typeof lastEntry.sequence === "number" && Number.isSafeInteger(lastEntry.sequence)) {
        this.nextSequence = lastEntry.sequence + 1;
      }
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code === "ENOENT") {
        return;
      }

      const message = error instanceof Error ? error.message : String(error);
      console.error(`[policy-proxy] audit log hash chain initialization failed: ${message}`);
    }
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }

  const record = value as Record<string, unknown>;
  const entries = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`);

  return `{${entries.join(",")}}`;
}
