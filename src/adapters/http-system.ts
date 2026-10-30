import type {
  EvalTask,
  TaskInput,
  EvidenceObserver,
  JsonValue,
  ObservedEvidence,
  RejectedToolCall,
  SystemRun,
  SystemUnderTest,
  ToolCall,
  TranscriptEvent,
  TrialContext,
} from '../types.js';

export interface HttpAdapterOptions {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class HttpSystemUnderTest implements SystemUnderTest {
  readonly #runUrl: string;
  readonly #client: JsonHttpClient;

  constructor(runUrl: string, options: HttpAdapterOptions = {}) {
    this.#runUrl = requireHttpUrl(runUrl, 'System-under-test URL');
    this.#client = new JsonHttpClient(options);
  }

  async run(input: TaskInput, context: TrialContext): Promise<SystemRun> {
    const value = await this.#client.request(this.#runUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        input,
        context: {
          runId: context.runId,
          trialId: context.trialId,
          trialIndex: context.trialIndex,
        },
      }),
    });
    if (!isSystemRun(value)) {
      throw new Error('System-under-test response failed runtime validation.');
    }
    return value;
  }
}

export class HttpEvidenceObserver implements EvidenceObserver {
  readonly #evidenceUrl: string;
  readonly #client: JsonHttpClient;

  constructor(evidenceUrl: string, options: HttpAdapterOptions = {}) {
    this.#evidenceUrl = requireHttpUrl(evidenceUrl, 'Evidence URL');
    this.#client = new JsonHttpClient(options);
  }

  async observe(
    task: EvalTask,
    context: TrialContext
  ): Promise<ObservedEvidence> {
    const url = new URL(this.#evidenceUrl);
    url.searchParams.set('taskId', task.id);
    url.searchParams.set('runId', context.runId);
    url.searchParams.set('trialId', context.trialId);
    url.searchParams.set('trialIndex', String(context.trialIndex));
    const value = await this.#client.request(url.toString());
    if (!isObservedEvidence(value)) {
      throw new Error('Evidence response failed runtime validation.');
    }
    return value;
  }
}

class JsonHttpClient {
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;

  constructor(options: HttpAdapterOptions) {
    this.#timeoutMs = options.timeoutMs ?? 30_000;
    this.#fetch = options.fetchImpl ?? fetch;
  }

  async request(url: string, init?: RequestInit): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.#timeoutMs);
    try {
      const response = await this.#fetch(url, {
        ...init,
        signal: controller.signal,
      });
      if (!response.ok) {
        const detail = await response.text();
        throw new Error(
          `HTTP adapter request failed with HTTP ${response.status}${detail ? `: ${detail.trim()}` : '.'}`
        );
      }
      if (
        !(response.headers.get('content-type') ?? '').includes(
          'application/json'
        )
      ) {
        throw new Error('HTTP adapter response was not JSON.');
      }
      return await response.json();
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(
          `HTTP adapter request timed out after ${this.#timeoutMs} ms.`,
          { cause: error }
        );
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}

function isSystemRun(value: unknown): value is SystemRun {
  if (!isRecord(value) || !isJsonValue(value['output'])) return false;
  if (!Array.isArray(value['transcript'])) return false;
  if (!value['transcript'].every(isTranscriptEvent)) return false;
  const metrics = value['metrics'];
  return (
    isRecord(metrics) &&
    isNonNegativeInteger(metrics['turns']) &&
    optionalNonNegativeNumber(metrics['inputTokens']) &&
    optionalNonNegativeNumber(metrics['outputTokens']) &&
    optionalNonNegativeNumber(metrics['costUsd']) &&
    (metrics['usageSource'] === undefined ||
      typeof metrics['usageSource'] === 'string')
  );
}

function isObservedEvidence(value: unknown): value is ObservedEvidence {
  return (
    isRecord(value) &&
    isJsonValue(value['outcome']) &&
    Array.isArray(value['toolCalls']) &&
    value['toolCalls'].every(isToolCall) &&
    (value['rejectedToolCalls'] === undefined ||
      (Array.isArray(value['rejectedToolCalls']) &&
        value['rejectedToolCalls'].every(isRejectedToolCall))) &&
    typeof value['source'] === 'string' &&
    value['source'].trim().length > 0
  );
}

function isTranscriptEvent(value: unknown): value is TranscriptEvent {
  return (
    isRecord(value) &&
    ['assistant', 'system', 'tool', 'user'].includes(String(value['role'])) &&
    typeof value['content'] === 'string' &&
    (value['toolCall'] === undefined || isToolCall(value['toolCall']))
  );
}

function isToolCall(value: unknown): value is ToolCall {
  return (
    isRecord(value) &&
    typeof value['name'] === 'string' &&
    isRecord(value['arguments']) &&
    Object.values(value['arguments']).every(isJsonValue)
  );
}

function isRejectedToolCall(value: unknown): value is RejectedToolCall {
  return (
    isRecord(value) &&
    isNonNegativeInteger(value['position']) &&
    isToolCall(value)
  );
}

function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return true;
  }
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isRecord(value) && Object.values(value).every(isJsonValue);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && typeof value === 'number' && value >= 0;
}

function optionalNonNegativeNumber(value: unknown): boolean {
  return (
    value === undefined ||
    (typeof value === 'number' && Number.isFinite(value) && value >= 0)
  );
}

function requireHttpUrl(value: string, label: string): string {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error(`${label} must use HTTP or HTTPS.`);
  }
  return url.toString();
}
