import { z } from 'zod';
import { isLoopbackHost, normalizeLoopbackOpenAiBaseUrl } from './loopback-openai-url';

const LoopbackHostSchema = z
  .string()
  .refine(isLoopbackHost, 'must be a loopback host');

const LoopbackOpenAiBaseUrlSchema = z.string().url().refine((value) => {
  try {
    normalizeLoopbackOpenAiBaseUrl(value);
    return true;
  } catch {
    return false;
  }
}, 'must be a loopback OpenAI base URL').transform(normalizeLoopbackOpenAiBaseUrl);

const PRODUCTION_PUBLIC_ORIGIN = 'https://flowpass.luecat.com';

function isAllowedPublicOrigin(value: string): boolean {
  try {
    const parsed = new URL(value);
    if (parsed.origin === PRODUCTION_PUBLIC_ORIGIN) {
      return true;
    }
    return (
      parsed.protocol === 'http:' &&
      parsed.hostname === '127.0.0.1' &&
      parsed.port.length > 0 &&
      parsed.username.length === 0 &&
      parsed.password.length === 0 &&
      parsed.pathname === '/' &&
      parsed.search.length === 0 &&
      parsed.hash.length === 0
    );
  } catch {
    return false;
  }
}

const PublicOriginSchema = z
  .string()
  .url()
  .refine(isAllowedPublicOrigin, 'must be the production origin or an explicit loopback test origin');

const RuntimeConfigSchema = z.object({
  publicOrigin: PublicOriginSchema.default(PRODUCTION_PUBLIC_ORIGIN),
  publicPort: z.coerce.number().int().min(1).max(65535).default(38100),
  adminHost: LoopbackHostSchema.default('127.0.0.1'),
  adminPort: z.coerce.number().int().min(1).max(65535).default(38101),
  workerHost: LoopbackHostSchema.default('127.0.0.1'),
  workerPort: z.coerce.number().int().min(1).max(65535).default(38102),
  lmStudioBaseUrl: LoopbackOpenAiBaseUrlSchema.default('http://127.0.0.1:1234'),
  timezone: z.literal('Asia/Taipei').default('Asia/Taipei'),
  dataRoot: z
    .string()
    .min(1)
    .default('/Users/luecat/Library/Application Support/FlowPass'),
  // These are public LINE identifiers, so keeping the configured production
  // values as defaults lets a fresh local checkout work without a second
  // build-time configuration step. Secrets remain Keychain-only.
  lineLoginChannelId: z.string().trim().min(1).default('2011336492'),
  liffId: z.string().trim().min(1).default('2011336492-ay7OJ4mO'),
});

export type RuntimeConfig = z.infer<typeof RuntimeConfigSchema>;
export type RuntimeConfigInput = Partial<Record<keyof RuntimeConfig, unknown>>;

export function createRuntimeConfig(input: RuntimeConfigInput): RuntimeConfig {
  return RuntimeConfigSchema.parse(input);
}

export const runtimeConfig = createRuntimeConfig({
  publicOrigin: process.env.FLOWPASS_PUBLIC_ORIGIN,
  publicPort: process.env.FLOWPASS_PUBLIC_PORT,
  adminHost: process.env.FLOWPASS_ADMIN_HOST,
  adminPort: process.env.FLOWPASS_ADMIN_PORT,
  workerHost: process.env.FLOWPASS_WORKER_HOST,
  workerPort: process.env.FLOWPASS_WORKER_PORT,
  lmStudioBaseUrl: process.env.FLOWPASS_LM_STUDIO_BASE_URL,
  timezone: process.env.FLOWPASS_TIMEZONE,
  dataRoot: process.env.FLOWPASS_DATA_ROOT,
  lineLoginChannelId: process.env.FLOWPASS_LINE_LOGIN_CHANNEL_ID,
  liffId: process.env.NEXT_PUBLIC_FLOWPASS_LIFF_ID,
});
