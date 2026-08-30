import type { FlowPassDatabase } from '../db/connection';
import {
  JobRepository,
  type CompleteJobInput,
  type DurableJob,
  type EnqueueJobInput,
  type FailJobInput,
  type LeaseNextJobInput,
  type JobType,
  type SystemScope,
} from '../db/repositories/jobs';

const DURABLE_JOB_SYSTEM_SCOPE: SystemScope = { systemId: 'durable-job-runner' };

export const JOB_CLASS_CONCURRENCY = {
  ai_draft: 1,
  ocr: 1,
  line_notification: 4,
  line_webhook: 4,
  retention: 1,
} as const;

export function concurrencyForJobType(jobType: DurableJob['jobType']): number {
  return JOB_CLASS_CONCURRENCY[jobType];
}

export class DurableJobRunner {
  private readonly jobs: JobRepository;

  public constructor(database: FlowPassDatabase) {
    this.jobs = new JobRepository(database);
  }

  public enqueue(input: EnqueueJobInput): DurableJob {
    return this.jobs.enqueue(DURABLE_JOB_SYSTEM_SCOPE, input);
  }

  public leaseNext(input: LeaseNextJobInput): DurableJob | null {
    return this.jobs.leaseNext({ workerId: input.workerId }, input);
  }

  public leaseNextForType(input: Omit<LeaseNextJobInput, 'jobType'> & { jobType: JobType }): DurableJob | null {
    return this.jobs.leaseNext({ workerId: input.workerId }, input);
  }

  public complete(input: CompleteJobInput): DurableJob | null {
    return this.jobs.complete({ workerId: input.workerId }, input);
  }

  public fail(input: FailJobInput): DurableJob | null {
    return this.jobs.fail({ workerId: input.workerId }, input);
  }
}
