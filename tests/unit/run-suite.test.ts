import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { runSuite } from '../../src/harness/run-suite.js';
import type {
  AgentRun,
  EvalTask,
  JudgeProvider,
  ReleaseThresholds,
  SystemUnderTestFactory,
} from '../../src/types.js';

const task: EvalTask = {
  id: 'runtime-failure',
  description: 'Capture a runtime failure as a failed trial.',
  input: { customerId: 'test', message: 'Run the failing system.' },
  expected: { maxTurns: 1 },
};

const thresholds: ReleaseThresholds = {
  deterministicPassRate: 1,
  passAt1: 1,
  passPowerK: 1,
  judgeAverage: 1,
  maxInvalidRate: 0,
};

describe('run suite boundaries', () => {
  it('records adapter failures as invalid rather than as model failures', async () => {
    const reportDirectory = await mkdtemp(
      join(tmpdir(), 'eval-pyramid-runtime-')
    );
    let disposed = false;
    const factory: SystemUnderTestFactory = {
      create: () =>
        Promise.resolve({
          run: () => Promise.reject(new Error('adapter exploded')),
          dispose: () => {
            disposed = true;
            return Promise.resolve();
          },
        }),
    };

    try {
      const result = await runSuite({
        tasks: [task],
        factory,
        trials: 1,
        k: 1,
        concurrency: 1,
        thresholds,
        reportDirectory,
      });
      const record = result.records[0];

      expect(record?.error).toBe('adapter exploded');
      expect(record?.outcome).toEqual({
        status: 'system_error',
        scored: false,
        detail: 'adapter exploded',
      });
      expect(result.summary.scoredTrialCount).toBe(0);
      expect(result.summary.invalidRate).toBe(1);
      // Nothing was measured, so no reliability number may be reported.
      expect(result.summary.passAt1).toBeNull();
      expect(result.summary.deterministicPassRate).toBeNull();
      expect(result.summary.releaseGate.passed).toBe(false);
      expect(result.summary.runId).not.toBe('');
      expect(disposed).toBe(true);
    } finally {
      await rm(reportDirectory, { recursive: true, force: true });
    }
  });

  it('rejects invalid suite options before running', async () => {
    const factory: SystemUnderTestFactory = {
      create: () => Promise.reject(new Error('must not create')),
    };
    const base = {
      tasks: [task],
      factory,
      trials: 1,
      k: 1,
      concurrency: 1,
      thresholds,
      reportDirectory: 'unused',
    };

    await expect(runSuite({ ...base, tasks: [] })).rejects.toThrow(
      'At least one task is required'
    );
    await expect(runSuite({ ...base, trials: 0 })).rejects.toThrow(
      'trials must be a positive integer'
    );
    await expect(runSuite({ ...base, k: 2 })).rejects.toThrow(
      'k must be a positive integer'
    );
    await expect(runSuite({ ...base, concurrency: 0 })).rejects.toThrow(
      'concurrency must be a positive integer'
    );
  });

  it('records factory setup failures instead of aborting the suite', async () => {
    const reportDirectory = await mkdtemp(
      join(tmpdir(), 'eval-pyramid-setup-')
    );
    const factory: SystemUnderTestFactory = {
      create: () => Promise.reject(new Error('authentication failed')),
    };

    try {
      const result = await runSuite({
        tasks: [task],
        factory,
        trials: 1,
        k: 1,
        concurrency: 1,
        thresholds,
        reportDirectory,
      });

      expect(result.records[0]?.error).toBe('authentication failed');
      expect(result.records[0]?.outcome.status).toBe('system_error');
      expect(result.records[0]?.outcome.scored).toBe(false);
    } finally {
      await rm(reportDirectory, { recursive: true, force: true });
    }
  });

  it('keeps deterministic evidence but scores nothing when the judge fails', async () => {
    const reportDirectory = await mkdtemp(
      join(tmpdir(), 'eval-pyramid-judge-failure-')
    );
    const judgedTask: EvalTask = {
      ...task,
      rubric: [
        {
          id: 'quality',
          description: 'The response has acceptable quality.',
          minimumScore: 0.8,
        },
      ],
    };
    const judgeProvider: JudgeProvider = {
      name: 'failing-judge',
      score: () => Promise.reject(new Error('judge unavailable')),
    };

    try {
      const result = await runSuite({
        tasks: [judgedTask],
        factory: successfulFactory(),
        trials: 1,
        k: 1,
        concurrency: 1,
        thresholds,
        reportDirectory,
        judgeProvider,
      });
      const record = result.records[0];

      expect(record?.run.output).toEqual({ status: 'complete' });
      expect(record?.deterministicPassed).toBe(true);
      expect(record?.judgePassed).toBeNull();
      expect(record?.outcome.status).toBe('judge_error');
      expect(record?.outcome.scored).toBe(false);
      expect(record?.grades.map((grade) => grade.grader)).toEqual([
        'turn-budget',
        'judge:quality:runtime',
      ]);
      expect(record?.error).toBe('judge unavailable');
      // A judge outage must not be reported as a low judge score.
      expect(result.summary.judgeAverage).toBeNull();
    } finally {
      await rm(reportDirectory, { recursive: true, force: true });
    }
  });

  it('reports grader crashes as invalid instead of blaming the system', async () => {
    const reportDirectory = await mkdtemp(
      join(tmpdir(), 'eval-pyramid-grader-')
    );
    const brokenTask: EvalTask = {
      ...task,
      id: 'broken-grader',
      expected: { outputSchema: { type: 'not-a-real-type' } },
    };

    try {
      const result = await runSuite({
        tasks: [brokenTask],
        factory: successfulFactory(),
        trials: 1,
        k: 1,
        concurrency: 1,
        thresholds,
        reportDirectory,
      });
      const record = result.records[0];

      expect(record?.outcome.status).toBe('grader_error');
      expect(record?.outcome.scored).toBe(false);
      expect(record?.run.output).toEqual({ status: 'complete' });
    } finally {
      await rm(reportDirectory, { recursive: true, force: true });
    }
  });

  it('treats cleanup failures as warnings, not as a failed trial', async () => {
    const reportDirectory = await mkdtemp(
      join(tmpdir(), 'eval-pyramid-cleanup-')
    );
    let trialWorkspace = '';
    const factory: SystemUnderTestFactory = {
      create: () =>
        Promise.resolve({
          run: (_task, context) => {
            trialWorkspace = context.workspace;
            return Promise.resolve(successfulRun());
          },
          dispose: () => Promise.reject(new Error('close failed')),
        }),
    };

    try {
      const result = await runSuite({
        tasks: [task],
        factory,
        trials: 1,
        k: 1,
        concurrency: 1,
        thresholds,
        reportDirectory,
      });
      const record = result.records[0];

      expect(record?.passed).toBe(true);
      expect(record?.outcome.status).toBe('completed');
      expect(record?.error).toBeNull();
      expect(record?.warnings).toEqual([
        'System disposal failed: close failed',
      ]);
      expect(result.summary.passAt1).toBe(1);
      expect(result.summary.releaseGate.passed).toBe(true);
      await expect(access(trialWorkspace)).rejects.toThrow();
    } finally {
      await rm(reportDirectory, { recursive: true, force: true });
    }
  });

  it('stamps the report with what produced it', async () => {
    const reportDirectory = await mkdtemp(join(tmpdir(), 'eval-pyramid-prov-'));

    try {
      const result = await runSuite({
        tasks: [task],
        factory: successfulFactory(),
        trials: 1,
        k: 1,
        concurrency: 1,
        thresholds,
        reportDirectory,
        systemLabel: 'unit-system',
        taskFile: 'tests/inline.jsonl',
      });
      const provenance = result.summary.provenance;

      expect(provenance?.systemUnderTest).toBe('unit-system');
      expect(provenance?.judge).toBeNull();
      expect(provenance?.taskFile).toBe('tests/inline.jsonl');
      expect(provenance?.taskDigests).toHaveLength(1);
      expect(provenance?.taskDigests[0]?.taskId).toBe(task.id);
      expect(provenance?.taskDigests[0]?.digest).toMatch(/^[0-9a-f]{64}$/u);
      expect(provenance?.taskSetDigest).toMatch(/^[0-9a-f]{64}$/u);
      expect(provenance?.configDigest).toMatch(/^[0-9a-f]{64}$/u);
    } finally {
      await rm(reportDirectory, { recursive: true, force: true });
    }
  });

  it('retries a trial lost to the infrastructure and keeps the recovered result', async () => {
    const reportDirectory = await mkdtemp(
      join(tmpdir(), 'eval-pyramid-retry-')
    );
    let attempts = 0;
    const factory: SystemUnderTestFactory = {
      create: () =>
        Promise.resolve({
          run: () => {
            attempts += 1;
            return attempts === 1
              ? Promise.reject(new Error('429 rate limited'))
              : Promise.resolve(successfulRun());
          },
        }),
    };

    try {
      const result = await runSuite({
        tasks: [task],
        factory,
        trials: 1,
        k: 1,
        concurrency: 1,
        thresholds,
        reportDirectory,
        retries: 2,
      });
      const record = result.records[0];

      expect(attempts).toBe(2);
      expect(record?.outcome.status).toBe('completed');
      expect(record?.attempts).toBe(2);
      expect(record?.passed).toBe(true);
      // The lost attempt is visible without being counted against the model.
      expect(record?.warnings[0]).toContain('retried after system_error');
      expect(result.summary.invalidTrialCount).toBe(0);
    } finally {
      await rm(reportDirectory, { recursive: true, force: true });
    }
  });

  it('never retries a trial that produced a real result', async () => {
    const reportDirectory = await mkdtemp(
      join(tmpdir(), 'eval-pyramid-no-retry-')
    );
    let attempts = 0;
    const failingTask: EvalTask = { ...task, expected: { maxTurns: 0 } };
    const factory: SystemUnderTestFactory = {
      create: () =>
        Promise.resolve({
          run: () => {
            attempts += 1;
            return Promise.resolve(successfulRun());
          },
        }),
    };

    try {
      const result = await runSuite({
        tasks: [failingTask],
        factory,
        trials: 1,
        k: 1,
        concurrency: 1,
        thresholds,
        reportDirectory,
        retries: 3,
      });

      // Retrying a failure until it passes would be sampling to a conclusion.
      expect(attempts).toBe(1);
      expect(result.records[0]?.attempts).toBe(1);
      expect(result.records[0]?.passed).toBe(false);
    } finally {
      await rm(reportDirectory, { recursive: true, force: true });
    }
  });

  it('rejects a negative retry count', async () => {
    await expect(
      runSuite({
        tasks: [task],
        factory: successfulFactory(),
        trials: 1,
        k: 1,
        concurrency: 1,
        thresholds,
        reportDirectory: 'unused',
        retries: -1,
      })
    ).rejects.toThrow('retries must be zero or a positive integer');
  });

  it('times the trial itself instead of trusting the system to report it', async () => {
    const reportDirectory = await mkdtemp(
      join(tmpdir(), 'eval-pyramid-clock-')
    );
    const latencyTask: EvalTask = {
      ...task,
      expected: { maxLatencyMs: 1000 },
    };
    const factory: SystemUnderTestFactory = {
      create: () =>
        Promise.resolve({
          run: () =>
            Promise.resolve({
              ...successfulRun(),
              metrics: { ...successfulRun().metrics, latencyMs: 900_000 },
            }),
        }),
    };

    try {
      const result = await runSuite({
        tasks: [latencyTask],
        factory,
        trials: 1,
        k: 1,
        concurrency: 1,
        thresholds,
        reportDirectory,
      });
      const record = result.records[0];
      const latency = record?.grades.find(
        (grade) => grade.grader === 'latency-budget'
      );

      // The system claims 900 seconds; the harness clock says otherwise.
      expect(record?.durationMs).toBeLessThan(1000);
      expect(latency?.passed).toBe(true);
      expect(latency?.rationale).toContain('measured by the harness');
    } finally {
      await rm(reportDirectory, { recursive: true, force: true });
    }
  });
});

function successfulFactory(): SystemUnderTestFactory {
  return {
    create: () =>
      Promise.resolve({
        run: () => Promise.resolve(successfulRun()),
      }),
  };
}

function successfulRun(): AgentRun {
  return {
    output: { status: 'complete' },
    outcome: {},
    transcript: [],
    toolCalls: [],
    metrics: {
      latencyMs: 1,
      inputTokens: 1,
      outputTokens: 1,
      costUsd: 0,
      turns: 1,
    },
  };
}
