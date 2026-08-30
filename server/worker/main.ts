import { serve } from '@hono/node-server';
import { runtimeConfig } from '../config/runtime-config';
import { flowPassDatabasePath, openMigratedDatabase } from '../db/connection';
import { createWorkerApp } from './app';
import { QueueDispatcher } from './queue-dispatcher';
import { generatePassport } from './handlers/generate-passport';
import { LmStudioClient } from '../adapters/lm-studio/lm-studio-client';
import { KeychainSecretProvider } from '../config/keychain';
import { initializeFieldCryptoAtStartup } from '../crypto/keyring';
import { join } from 'node:path';
import { DocumentVault } from '../services/document-vault';
import { OcrAdapterError } from '../adapters/ocr/ocr-contract';
import { PaddleClient } from '../adapters/ocr/paddle-client';
import { VisionClient, createVisionProcessRunner } from '../adapters/ocr/vision-client';
import { runOcrJob } from './handlers/run-ocr';
import { runRetentionJob } from './handlers/run-retention';
import { JobRepository } from '../db/repositories/jobs';
import type { DurableJob } from '../db/repositories/jobs';
import { processLineEvent } from './handlers/process-line-event';
import { sendLineNotification } from './handlers/send-line-notification';
import { createLineMessagingClient } from '../adapters/line/messaging-client';

const database = openMigratedDatabase(flowPassDatabasePath(runtimeConfig.dataRoot));

serve({
  fetch: createWorkerApp(database).fetch,
  hostname: runtimeConfig.workerHost,
  port: runtimeConfig.workerPort,
});

/**
 * Processing is explicit opt-in so merely starting the local health service
 * never reads credentials or calls a model. When enabled, the dispatcher
 * leases each class independently and completes/fails jobs durably.
 */
if (process.env.FLOWPASS_WORKER_RUN === '1') {
  void (async () => {
    try {
      const provider = new KeychainSecretProvider();
      const keyId = process.env.FLOWPASS_ACTIVE_KEY_ID ?? 'flowpass-v1';
      const crypto = await initializeFieldCryptoAtStartup(provider, {
        activeKeyId: keyId,
        masterKeyRefs: { [keyId]: { service: process.env.FLOWPASS_KEYCHAIN_SERVICE ?? 'FlowPass', account: process.env.FLOWPASS_MASTER_KEY_ACCOUNT ?? 'flowpass-master-key' } },
      });
      // A missing model token must not prevent OCR/retention maintenance from
      // starting. AI jobs remain durably queued until the operator configures
      // the token and restarts the worker.
      let client: LmStudioClient | null = null;
      try {
        const token = await provider.get({ service: process.env.FLOWPASS_KEYCHAIN_SERVICE ?? 'FlowPass', account: process.env.FLOWPASS_LM_STUDIO_KEYCHAIN_ACCOUNT ?? 'lm-studio-api-token' });
        client = new LmStudioClient({ modelId: process.env.FLOWPASS_MODEL_ID ?? 'unconfigured', endpoint: `${runtimeConfig.lmStudioBaseUrl}/v1/chat/completions`, token });
      } catch {
        client = null;
      }
      const workerId = process.env.FLOWPASS_WORKER_ID ?? `worker-${process.pid}`;
      const vault = new DocumentVault({ rootPath: join(runtimeConfig.dataRoot, 'vault'), crypto });
      const visionRunner = process.env.FLOWPASS_VISION_OCR_PATH
        ? createVisionProcessRunner(process.env.FLOWPASS_VISION_OCR_PATH)
        : async () => { throw new OcrAdapterError('OCR_UNAVAILABLE'); };
      const vision = new VisionClient(visionRunner);
      const paddle = new PaddleClient(async () => { throw new OcrAdapterError('OCR_UNAVAILABLE'); }, process.env.FLOWPASS_PADDLE_PREFLIGHT === 'passed');
      const handlers = {
        ocr: async (job: DurableJob) => { await runOcrJob(job, { workerId }, { database, crypto, vault, ocr: { vision, paddle } }); },
        retention: async (job: DurableJob) => { await runRetentionJob(job, { workerId }, { database, crypto }); },
        line_webhook: async (job: DurableJob) => { processLineEvent(job, { database }); },
        ...(process.env.FLOWPASS_LINE_CHANNEL_ACCESS_TOKEN ? { line_notification: async (job: DurableJob) => { await sendLineNotification(job, { database, crypto, client: createLineMessagingClient({ channelAccessToken: process.env.FLOWPASS_LINE_CHANNEL_ACCESS_TOKEN! }), liffId: runtimeConfig.liffId }); } } : {}),
        ...(client ? { ai_draft: async (job: DurableJob) => { await generatePassport(job, { workerId }, { database, crypto, client: client! }); } } : {}),
      };
      const dispatcher = new QueueDispatcher({ database, workerId, handlers });
      const retentionJobs = new JobRepository(database);
      const enqueueLineNotifications = () => {
        if (!process.env.FLOWPASS_LINE_CHANNEL_ACCESS_TOKEN) return;
        const pending = database.prepare("SELECT id FROM notification_jobs WHERE status = 'pending' ORDER BY created_at ASC LIMIT 20").all() as Array<{ id: string }>;
        for (const row of pending) retentionJobs.enqueue({ systemId: 'line-notification-bridge' }, { jobType: 'line_notification', payload: { notificationJobId: row.id }, uniqueKey: `line-notification:${row.id}`, maxAttempts: 3 });
      };
      const enqueueRetention = () => {
        const day = new Date().toISOString().slice(0, 10);
        retentionJobs.enqueue({ systemId: 'retention-scheduler' }, { jobType: 'retention', payload: { day }, uniqueKey: `retention:${day}`, maxAttempts: 5 });
      };
      enqueueRetention();
      const tick = () => { enqueueLineNotifications(); dispatcher.dispatchOnce(); };
      const timer = setInterval(tick, 250);
      const retentionTimer = setInterval(enqueueRetention, 60 * 60 * 1000);
      process.once('SIGINT', () => { clearInterval(timer); clearInterval(retentionTimer); });
      process.once('SIGTERM', () => { clearInterval(timer); clearInterval(retentionTimer); });
    } catch {
      // Keep health available and leave jobs queued for an operator retry.
    }
  })();
}

process.once('SIGINT', () => database.close());
process.once('SIGTERM', () => database.close());
