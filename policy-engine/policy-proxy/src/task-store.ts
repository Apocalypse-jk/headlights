import type { PolicyInput } from "./task-mapper.js";

export interface TaskContext {
  taskId: string;
  appId: string;
  // This is the decoded policy input of the original Beam task. It is stored so
  // the later output policy can compare a result with the request that caused it.
  requestInput: PolicyInput;
  createdAt: string;
  updatedAt: string;
}

export interface TaskContextStoreOptions {
  ttlMs: number;
}

export class TaskContextStore {
  // The Map is the in-memory correlation table:
  // Beam task ID -> context of the original allowed request.
  // This is sufficient for the current single policy-proxy container setup.
  private readonly contexts = new Map<string, TaskContext>();
  private readonly ttlMs: number;

  public constructor(options: TaskContextStoreOptions) {
    this.ttlMs = options.ttlMs;
  }

  public remember(taskId: string, appId: string, requestInput: PolicyInput): void {
    const now = new Date().toISOString();

    // The task ID is the correlation key between the original request and the
    // later result submission from Focus.
    // If Focus polls the same task more than once before completing it, we keep
    // the original creation time and only refresh the update timestamp.
    this.contexts.set(taskId, {
      taskId,
      appId,
      requestInput,
      createdAt: this.contexts.get(taskId)?.createdAt ?? now,
      updatedAt: now,
    });
  }

  public get(taskId: string): TaskContext | undefined {
    // Results may arrive later than the task retrieval. This lookup reconnects
    // the output phase with the original input phase using the Beam task ID.
    const context = this.contexts.get(taskId);

    if (!context) {
      return undefined;
    }

    if (this.isExpired(context)) {
      // Expired entries are removed lazily as soon as they are touched. The
      // periodic cleanup in server.ts handles entries that are never requested.
      this.contexts.delete(taskId);
      return undefined;
    }

    return context;
  }

  public delete(taskId: string): void {
    // Terminal results no longer need request context, so deleting them prevents
    // unnecessary memory growth during long-running tests.
    this.contexts.delete(taskId);
  }

  public cleanup(): number {
    // This is the proactive cleanup path for tasks that never receive a final
    // result, for example because Focus stopped or the Beam task expired.
    let removed = 0;

    for (const [taskId, context] of this.contexts.entries()) {
      if (this.isExpired(context)) {
        this.contexts.delete(taskId);
        removed += 1;
      }
    }

    return removed;
  }

  public size(): number {
    // Used only for operational logging, so we can see whether old contexts are
    // being removed as expected.
    return this.contexts.size;
  }

  private isExpired(context: TaskContext): boolean {
    // updatedAt is used instead of createdAt so repeated sightings of the same
    // task can keep its context alive while it is still active.
    return Date.now() - Date.parse(context.updatedAt) > this.ttlMs;
  }
}
