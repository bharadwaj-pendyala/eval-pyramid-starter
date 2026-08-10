const SENSITIVE_KEYS = new Set([
  'accesstoken',
  'apikey',
  'authorization',
  'clientsecret',
  'cookie',
  'email',
  'password',
  'refreshtoken',
  'secret',
  'token',
]);
const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu;
const BEARER_TOKEN = /\bBearer\s+[A-Z0-9._~+/=-]+/giu;
const OPENAI_KEY = /\bsk-[A-Z0-9_-]{16,}\b/giu;

export function redactUnknown(value: unknown): unknown {
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) return value.map(redactUnknown);
  if (!isRecord(value)) return value;

  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      isSensitiveKey(key) ? '[REDACTED]' : redactUnknown(entry),
    ])
  );
}

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEYS.has(
    key.replace(/[^a-z0-9]/giu, '').toLocaleLowerCase()
  );
}

export function redactText(value: string): string {
  return value
    .replace(EMAIL, '[REDACTED_EMAIL]')
    .replace(BEARER_TOKEN, 'Bearer [REDACTED]')
    .replace(OPENAI_KEY, '[REDACTED_API_KEY]');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
