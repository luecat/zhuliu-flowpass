import type { FieldCrypto } from '../../crypto/field-crypto';
import type { FlowPassDatabase } from '../../db/connection';
import type { DurableJob, WorkerScope } from '../../db/repositories/jobs';
import { purgeExpiredRawOcr, type OcrRetentionResult } from '../../services/retention-service';

export async function runRetentionJob(job: DurableJob, _scope: WorkerScope, options: { database: FlowPassDatabase; crypto: FieldCrypto; clock?: () => Date }): Promise<OcrRetentionResult> {
  if (job.jobType !== 'retention') throw new Error('unsupported retention job');
  return purgeExpiredRawOcr({ database: options.database, crypto: options.crypto, now: (options.clock ?? (() => new Date()))() });
}

