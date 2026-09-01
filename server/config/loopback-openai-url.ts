const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host.toLowerCase());
}

function parseLoopbackHttpUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('OpenAI endpoint must be a loopback HTTP URL');
  }
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    !isLoopbackHost(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error('OpenAI endpoint must be a loopback HTTP URL');
  }
  return url;
}

export function normalizeLoopbackOpenAiBaseUrl(value: string): string {
  const url = parseLoopbackHttpUrl(value);
  const path = url.pathname.replace(/\/+$/, '');
  if (path !== '' && path !== '/v1') {
    throw new Error('OpenAI base URL must end at the server root or /v1');
  }
  return url.origin;
}

export function openAiApiUrl(baseUrl: string, resource: 'models' | 'chat/completions'): string {
  return `${normalizeLoopbackOpenAiBaseUrl(baseUrl)}/v1/${resource}`;
}

export function assertLoopbackOpenAiChatCompletionsUrl(value: string): URL {
  const url = parseLoopbackHttpUrl(value);
  if (url.pathname !== '/v1/chat/completions') {
    throw new Error('OpenAI chat endpoint must be /v1/chat/completions');
  }
  return url;
}
