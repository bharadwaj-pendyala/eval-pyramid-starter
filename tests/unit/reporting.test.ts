import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { escapeHtml } from '../../src/harness/write-reports.js';
import { redactUnknown } from '../../src/reporting/redact.js';
import {
  adjudicateReview,
  exportReviewDecisions,
  summarizeReviewQueue,
} from '../../src/reporting/review-queue.js';

describe('report safety', () => {
  it('redacts sensitive values recursively', () => {
    expect(
      redactUnknown({
        email: 'person@example.com',
        nested: {
          authorization: 'Bearer secret',
          safe: 'Contact person@example.com',
        },
        metrics: { inputTokens: 5, outputTokens: 2 },
        rows: [{ apiKey: 'secret-key' }],
      })
    ).toEqual({
      email: '[REDACTED]',
      nested: { authorization: '[REDACTED]', safe: 'Contact [REDACTED_EMAIL]' },
      metrics: { inputTokens: 5, outputTokens: 2 },
      rows: [{ apiKey: '[REDACTED]' }],
    });
  });

  it('escapes dynamic HTML report values', () => {
    expect(escapeHtml(`<script>alert("x")</script> & 'quote'`)).toBe(
      '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;quote&#39;'
    );
  });

  it('lists, adjudicates, and exports human review decisions durably', async () => {
    const reportRoot = await mkdtemp(join(tmpdir(), 'eval-pyramid-review-'));

    try {
      const latest = join(reportRoot, 'latest');
      await mkdir(latest);
      await writeFile(
        join(latest, 'summary.json'),
        '{"runId":"review-run"}\n',
        'utf8'
      );
      const queue =
        '{"runId":"review-run","taskId":"one","trialIndex":0,"reasons":["failed"],"output":"a"}\n{"runId":"review-run","taskId":"two","trialIndex":1,"reasons":["unknown"],"output":"b"}\n';
      const runDirectory = join(reportRoot, 'runs', 'review-run');
      await mkdir(runDirectory, { recursive: true });
      await writeFile(join(latest, 'review-queue.jsonl'), queue, 'utf8');
      await writeFile(join(runDirectory, 'review-queue.jsonl'), queue, 'utf8');
      await expect(summarizeReviewQueue(reportRoot)).resolves.toContain(
        '2 trials waiting for human review'
      );

      await adjudicateReview(reportRoot, 'one', 0, 0.25, 'Unsafe action.');
      await expect(summarizeReviewQueue(reportRoot)).resolves.toContain(
        '1 trial waiting for human review'
      );
      const exportPath = await exportReviewDecisions(reportRoot);
      const exported = await readFile(exportPath, 'utf8');
      expect(exported).toContain('"humanScore":0.25');
      expect(exported).toContain('"output":"a"');
      expect(exported).toContain('Unsafe action.');
    } finally {
      await rm(reportRoot, { recursive: true, force: true });
    }
  });
});
