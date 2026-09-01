import { readFileSync, readdirSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { KeychainSecretProvider } from '../server/config/keychain';
import { LmStudioClient } from '../server/adapters/lm-studio/lm-studio-client';
import { inspectPassportJson } from '../server/domain/passport-validation';
import { createModelCatalog, eligibleModel, formatModelDoctorReport, type ModelCapabilities } from '../server/adapters/lm-studio/model-catalog';
import { FIXED_AI_INSTRUCTION } from '../server/domain/ai-draft-service';
import { normalizeLoopbackOpenAiBaseUrl, openAiApiUrl } from '../server/config/loopback-openai-url';

type Fixture = { fixture: string; expectedSchemaValid: boolean; requiredFollowUpTopics: string[]; answers: Record<string, string>; modelOutput?: unknown };
type BenchmarkResult = { fixture: string; valid: boolean; coveredTopics: string[]; latencyMs: number; failureType?: string };

export function loadAiFixtures(directory = join(process.cwd(), 'test', 'fixtures', 'ai')): Fixture[] {
  return readdirSync(directory).filter((name) => name.endsWith('.json') && name !== 'manifest.json').sort().map((name) => JSON.parse(readFileSync(join(directory, name), 'utf8')) as Fixture);
}

export async function runFixtureBenchmark(client: Pick<LmStudioClient, 'complete'>, fixtures = loadAiFixtures()): Promise<BenchmarkResult[]> {
  const results: BenchmarkResult[] = [];
  const maxFixture: Fixture = { fixture: 'maximum-legal-input', expectedSchemaValid: true, requiredFollowUpTopics: [], answers: { material: '中'.repeat(500), aiPurpose: '中'.repeat(500), sensitiveData: '中'.repeat(600), destinationAndAudience: '中'.repeat(500) } };
  for (const fixture of [...fixtures, maxFixture]) {
    const started = performance.now();
    try {
      const response = await client.complete({ systemInstruction: FIXED_AI_INSTRUCTION, inputEnvelope: fixture.answers });
      let inspection = inspectPassportJson(response.content);
      if (!inspection.validation.ok) {
        const repaired = await client.complete({ systemInstruction: FIXED_AI_INSTRUCTION, inputEnvelope: {}, repairIssues: inspection.validation.errors, invalidStructure: inspection.canonical });
        inspection = inspectPassportJson(repaired.content);
      }
      const coveredTopics = inspection.canonical ? fixture.requiredFollowUpTopics.filter((topic) => JSON.stringify(inspection.canonical).toLowerCase().includes(topic.toLowerCase())) : [];
      results.push({ fixture: fixture.fixture, valid: inspection.validation.ok, coveredTopics, latencyMs: Math.round(performance.now() - started), ...(inspection.validation.ok ? {} : { failureType: inspection.validation.errors[0]?.code ?? 'AI_OUTPUT_INVALID' }) });
    } catch (error) {
      const failureType = error && typeof error === 'object' && 'code' in error && typeof (error as { code?: unknown }).code === 'string' ? (error as { code: string }).code : 'MODEL_OFFLINE';
      results.push({ fixture: fixture.fixture, valid: false, coveredTopics: [], latencyMs: Math.round(performance.now() - started), failureType });
    }
  }
  return results;
}

function summarize(results: BenchmarkResult[]) {
  const latencies = results.map((result) => result.latencyMs).sort((a, b) => a - b);
  const percentile = (fraction: number) => latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * fraction))] ?? 0;
  const failures = new Map<string, number>();
  results.filter((result) => !result.valid).forEach((result) => failures.set(result.failureType ?? 'AI_OUTPUT_INVALID', (failures.get(result.failureType ?? 'AI_OUTPUT_INVALID') ?? 0) + 1));
  return { count: results.length, schemaPassRate: results.length ? results.filter((result) => result.valid).length / results.length : 0, requiredTopicCoverage: results.reduce((sum, result) => sum + result.coveredTopics.length, 0), p50LatencyMs: percentile(0.5), p95LatencyMs: percentile(0.95), peakFailureType: [...failures.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null, accepted: results.length === 21 && results.every((result) => result.valid && result.latencyMs <= 120_000) };
}

async function main() {
  const endpoint = normalizeLoopbackOpenAiBaseUrl(
    process.env.FLOWPASS_LM_STUDIO_BASE_URL ?? process.env.FLOWPASS_LM_STUDIO_URL ?? 'http://127.0.0.1:1234',
  );
  const service = process.env.FLOWPASS_LM_STUDIO_KEYCHAIN_SERVICE ?? 'FlowPass';
  const account = process.env.FLOWPASS_LM_STUDIO_KEYCHAIN_ACCOUNT ?? 'lm-studio-api-token';
  const provider = new KeychainSecretProvider();
  let token: string | null = null;
  try { token = await provider.get({ service, account }); } catch { /* report presence only */ }
  let models: ModelCapabilities[] = [];
  if (process.argv.includes('--live')) {
    try {
      const response = await fetch(openAiApiUrl(endpoint, 'models'), { headers: token ? { authorization: `Bearer ${token}` } : {}, redirect: 'error' });
      if (response.ok) {
        const body = await response.json() as { data?: Array<Record<string, unknown>> };
        models = (body.data ?? []).map((item) => ({ id: typeof item.id === 'string' ? item.id : 'unknown', contextLength: typeof item.context_length === 'number' ? item.context_length : null, supportsJsonSchema: item.supports_json_schema === true ? true : null, supportsChat: item.supports_chat !== false }));
      }
    } catch { models = []; }
  }
  const selected = process.env.FLOWPASS_MODEL_ID ?? models[0]?.id ?? 'unconfigured';
  const catalog = createModelCatalog(models, selected);
  const report: Record<string, unknown> = { ...JSON.parse(formatModelDoctorReport({ ...catalog, models: catalog.models.map((item) => ({ ...item, eligible: eligibleModel(item) })) })), keychainTokenPresent: Boolean(token), fixtureCount: loadAiFixtures().length, liveModels: models.map((model) => ({ id: model.id, contextLength: model.contextLength, supportsJsonSchema: model.supportsJsonSchema, supportsChat: model.supportsChat })) };
  if (process.argv.includes('--benchmark')) {
    const client = new LmStudioClient({ modelId: selected, endpoint: openAiApiUrl(endpoint, 'chat/completions'), token });
    const benchmark = summarize(await runFixtureBenchmark(client));
    const selectedMetadata = models.find((model) => model.id === selected);
    report.benchmark = { ...benchmark, candidateEligible: Boolean(selectedMetadata && eligibleModel(selectedMetadata)), accepted: benchmark.accepted && Boolean(selectedMetadata && eligibleModel(selectedMetadata)) };
  }
  console.log(JSON.stringify(report, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main();
