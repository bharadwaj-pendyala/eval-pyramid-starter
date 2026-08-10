import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { escapeHtml } from '../../src/harness/write-reports.js';
import { redactUnknown } from '../../src/reporting/redact.js';
import { summarizeReviewQueue } from '../../src/reporting/review-queue.js';

describe('report safety', () => {
  it('redacts sensitive values recursively', () => {
    expect(
      redactUnknown({
        email: 'person@example.com',
        nested: {
          authorization: 'Bearer secret',
          safe: 'Contact person@example.com',
        },
        metrics: { inputTokens: 180, outputTokens: 72 },
        rows: [{ apiKey: 'secret-key' }],
      })
    ).toEqual({
      email: '[REDACTED]',
      nested: { authorization: '[REDACTED]', safe: 'Contact [REDACTED_EMAIL]' },
      metrics: { inputTokens: 180, outputTokens: 72 },
      rows: [{ apiKey: '[REDACTED]' }],
    });
  });

  it('escapes dynamic HTML report values', () => {
    expect(escapeHtml(`<script>alert("x")</script> & 'quote'`)).toBe(
      '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;quote&#39;'
    );
  });

  it('summarizes singular and plural human review queues', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'eval-pyramid-review-'));

    try {
      const path = join(directory, 'review-queue.jsonl');
      await writeFile(path, '{"taskId":"one"}\n', 'utf8');
      await expect(summarizeReviewQueue(directory)).resolves.toContain(
        '1 trial waiting for human review'
      );

      await writeFile(path, '{"taskId":"one"}\n{"taskId":"two"}\n', 'utf8');
      await expect(summarizeReviewQueue(directory)).resolves.toContain(
        '2 trials waiting for human review'
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
