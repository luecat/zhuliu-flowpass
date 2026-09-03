import type { DurableJob, JobType } from '../db/repositories/jobs';
import { concurrencyForJobType, DurableJobRunner } from './job-runner';

export type QueueHandler = (job: DurableJob) => Promise<void>;

export interface QueueDispatcherOptions {
  database: ConstructorParameters<typeof DurableJobRunner>[0];
  workerId: string;
  handlers: Partial<Record<JobType, QueueHandler>>;
  clock?: () => Date;
  leaseDurationMs?: number;
}

/**
 * Small durable dispatcher used by the local worker. Each job class leases
 * independently, so a slow AI request cannot consume the notification slots.
 * Handlers run outside SQLite transactions; only lease/complete/fail mutate DB.
 */
export class QueueDispatcher {
  private readonly runner: DurableJobRunner;
  private readonly active = new Map<JobType, number>();
  private readonly clock: () => Date;
  private readonly leaseDurationMs: number;

  public constructor(private readonly options: QueueDispatcherOptions) {
    this.runner = new DurableJobRunner(options.database);
    this.clock = options.clock ?? (() => new Date());
    this.leaseDurationMs = options.leaseDurationMs ?? 120_000;
  }

  public activeCount(jobType: JobType): number { return this.active.get(jobType) ?? 0; }

  /** Lease at most one ready job for every configured handler/class. */
  public dispatchOnce(): number {
    let dispatched = 0;
    const now = this.clock().toISOString();
    for (const [jobType, handler] of Object.entries(this.options.handlers) as Array<[JobType, QueueHandler | undefined]>) {
      if (!handler) continue;
      while (this.activeCount(jobType) < concurrencyForJobType(jobType)) {
        const job = this.runner.leaseNextForType({ workerId: this.options.workerId, jobType, now, leaseDurationMs: this.leaseDurationMs });
        if (!job) break;
        this.active.set(jobType, this.activeCount(jobType) + 1);
        dispatched += 1;
        void handler(job)
          .then(() => { this.runner.complete({ workerId: this.options.workerId, jobId: job.id, completedAt: this.clock().toISOString() }); })
          .catch((error: unknown) => {
            const errorCode = error && typeof error === 'object' && 'code' in error && typeof (error as { code?: unknown }).code === 'string'
              ? (error as { code: string }).code
              : 'WORKER_HANDLER_FAILED';
            this.runner.fail({ workerId: this.options.workerId, jobId: job.id, errorCode, now: this.clock().toISOString(), terminal: errorCode === 'AI_INPUT_INVALID' });
          })
          .finally(() => { this.active.set(jobType, Math.max(0, this.activeCount(jobType) - 1)); });
      }
    }
    return dispatched;
  }
}
