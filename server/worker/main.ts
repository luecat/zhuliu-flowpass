import { serve } from '@hono/node-server';
import { runtimeConfig } from '../config/runtime-config';
import { flowPassDatabasePath, openMigratedDatabase } from '../db/connection';
import { createWorkerApp, defaultWorkerDependencyStatus } from './app';
import { QueueDispatcher } from './queue-dispatcher';
import { generatePassport } from './handlers/generate-passport';
import { LmStudioClient } from '../adapters/lm-studio/lm-studio-client';
import { GeminiClient } from '../adapters/gemini/gemini-client';
import { DEFAULT_GEMINI_QUOTA_MODELS, GeminiQuotaRouter } from '../adapters/gemini/model-quota-router';
import { KeychainSecretProvider } from '../config/keychain';
import { initializeFieldCryptoAtStartup } from '../crypto/keyring';
import { JobRepository } from '../db/repositories/jobs';
import type { DurableJob } from '../db/repositories/jobs';
import { processLineEvent } from './handlers/process-line-event';
import { sendLineNotification } from './handlers/send-line-notification';
import { createLineMessagingClient } from '../adapters/line/messaging-client';
import { openAiApiUrl } from '../config/loopback-openai-url';
import { isMaintenanceMode } from '../services/maintenance-mode';

const database = openMigratedDatabase(flowPassDatabasePath(runtimeConfig.dataRoot));

const dependencyStatus = defaultWorkerDependencyStatus();

serve({
  fetch: createWorkerApp(database, dependencyStatus).fetch,
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
      // The configured model ID stays the explicit opt-in for AI processing.
      // Provider selection is env-driven so LM Studio remains available as a
      // fallback without any code revert.
      let client: Pick<LmStudioClient, 'complete'> | null = null;
      let adapterName: 'gemini' | 'lm_studio' = 'lm_studio';
      const modelId = process.env.FLOWPASS_MODEL_ID?.trim();
      if (modelId && runtimeConfig.modelProvider === 'gemini') {
        let geminiKey: string | null = null;
        try {
          geminiKey = await provider.get({ service: process.env.FLOWPASS_KEYCHAIN_SERVICE ?? 'FlowPass', account: process.env.FLOWPASS_GEMINI_KEYCHAIN_ACCOUNT ?? 'gemini-api-key' });
        } catch {
          geminiKey = null;
        }
        if (geminiKey) {
          const models = DEFAULT_GEMINI_QUOTA_MODELS;
          const clients = new Map(models.map((model) => [
            model.id,
            new GeminiClient({ modelId: model.id, apiKey: geminiKey!, overallTimeoutMs: 120_000 }),
          ]));
          client = new GeminiQuotaRouter(database, clients, models);
          adapterName = 'gemini';
        }
      } else if (modelId) {
        // Local OpenAI-compatible servers can intentionally run without a token.
        let lmToken: string | null = null;
        try {
          lmToken = await provider.get({ service: process.env.FLOWPASS_KEYCHAIN_SERVICE ?? 'FlowPass', account: process.env.FLOWPASS_LM_STUDIO_KEYCHAIN_ACCOUNT ?? 'lm-studio-api-token' });
        } catch {
          lmToken = null;
        }
        client = new LmStudioClient({
          modelId,
          endpoint: openAiApiUrl(runtimeConfig.lmStudioBaseUrl, 'chat/completions'),
          token: lmToken,
          // A local 9B GGUF model can need more than two minutes to satisfy
          // the complete strict passport schema on first inference.
          overallTimeoutMs: 300_000,
        });
      }
      // Health key name is deliberately unchanged: /healthz and its tests read
      // `lmStudio` for whichever model provider is active.
      dependencyStatus.lmStudio = client ? 'ready' : 'disabled';
      let lineChannelAccessToken: string | null = null;
      try {
        lineChannelAccessToken = await provider.get({
          service: process.env.FLOWPASS_KEYCHAIN_SERVICE ?? 'FlowPass',
          account: process.env.FLOWPASS_LINE_CHANNEL_ACCESS_TOKEN_KEYCHAIN_ACCOUNT ?? 'line-channel-access-token',
        });
      } catch {
        lineChannelAccessToken = null;
      }
      const lineClient = lineChannelAccessToken
        ? createLineMessagingClient({ channelAccessToken: lineChannelAccessToken })
        : null;
      dependencyStatus.lineNotification = lineClient ? 'ready' : 'disabled';
      const workerId = process.env.FLOWPASS_WORKER_ID ?? `worker-${process.pid}`;
      const handlers = {
        line_webhook: async (job: DurableJob) => {
          processLineEvent(job, {
            database,
            crypto,
            lineClient,
            now: new Date().toISOString(),
          });
        },
        ...(lineClient ? { line_notification: async (job: DurableJob) => { await sendLineNotification(job, { database, crypto, client: lineClient, liffId: runtimeConfig.liffId }); } } : {}),
        ...(client ? { ai_draft: async (job: DurableJob) => { await generatePassport(job, { workerId }, { database, crypto, client: client!, adapterName, classifyInput: true }); } } : {}),
      };
      const dispatcher = new QueueDispatcher({
        database,
        workerId,
        handlers,
        // Keep the durable lease longer than the model timeout so another
        // worker cannot lease the same AI draft while inference is active.
        leaseDurationMs: 960_000,
      });
      const jobBridge = new JobRepository(database);
      const enqueueLineNotifications = () => {
        if (!lineClient) return;
        const pending = database.prepare("SELECT id FROM notification_jobs WHERE status = 'pending' ORDER BY created_at ASC LIMIT 20").all() as Array<{ id: string }>;
        for (const row of pending) jobBridge.enqueue({ systemId: 'line-notification-bridge' }, { jobType: 'line_notification', payload: { notificationJobId: row.id }, uniqueKey: `line-notification:${row.id}`, maxAttempts: 3 });
      };
      const tick = () => {
        if (isMaintenanceMode(database)) return;
        enqueueLineNotifications();
        dispatcher.dispatchOnce();
      };
      dependencyStatus.processing = 'ready';
      const timer = setInterval(tick, 250);
      process.once('SIGINT', () => { clearInterval(timer); });
      process.once('SIGTERM', () => { clearInterval(timer); });
    } catch {
      dependencyStatus.processing = 'failed';
      // Keep health available and leave jobs queued for an operator retry.
    }
  })();
}

process.once('SIGINT', () => database.close());
process.once('SIGTERM', () => database.close());
