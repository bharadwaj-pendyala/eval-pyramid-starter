import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { runSuite } from '../../src/harness/run-suite.js';
import type {
  EvalTask,
  JudgeProvider,
  ObservedEvidence,
  ReleaseThresholds,
  SystemRun,
  SystemUnderTestFactory,
  TrialEnvironment,
} from '../../src/types.js';

const task: EvalTask = {
  id: 'runtime-failure',
  description: 'Capture a runtime failure as a failed trial.',
  severity: 'medium',
  input: { message: 'Run the system.' },
  expected: { maxTurns: 1 },
};

const thresholds: ReleaseThresholds = {
  deterministicPassRate: 1,
  passAt1: 1,
  passPowerK: 1,
  judgeAverage: 1,
  criticalPassRate: 1,
  requireJudge: false,
  requireIndependentEvidence: true,
};

describe('run suite boundaries', () => {
  it('captures system failures, disposes the environment, and creates a run id', async () => {
    const reportRoot = await temporaryRoot('runtime');
    let disposed = false;
    const factory = factoryFor({
      system: { run: () => Promise.reject(new Error('adapter exploded')) },
      observer: { observe: () => Promise.resolve(observed()) },
      dispose: () => {
        disposed = true;
        return Promise.resolve();
      },
    });

    try {
      const result = await runSuite({
        tasks: [task],
        factory,
        trials: 1,
        k: 1,
        concurrency: 1,
        thresholds,
        reportRoot,
      });

      expect(result.records[0]?.error).toBe('adapter exploded');
      expect(result.records[0]?.grades[0]?.grader).toBe('runtime');
      expect(result.summary.runId).not.toBe('');
      expect(disposed).toBe(true);
    } finally {
      await rm(reportRoot, { recursive: true, force: true });
    }
  });

  it('rejects invalid suite options before running', async () => {
    const factory: SystemUnderTestFactory = {
      name: 'never',
      evidenceSource: 'never',
      create: () => Promise.reject(new Error('must not create')),
    };
    const base = {
      tasks: [task],
      factory,
      trials: 1,
      k: 1,
      concurrency: 1,
      thresholds,
      reportRoot: 'unused',
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

  it('records environment setup failures instead of aborting the suite', async () => {
    const reportRoot = await temporaryRoot('setup');
    const factory: SystemUnderTestFactory = {
      name: 'failing-setup',
      evidenceSource: 'test-observer',
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
        reportRoot,
      });

      expect(result.records[0]?.error).toBe('authentication failed');
      expect(result.records[0]?.passed).toBe(false);
    } finally {
      await rm(reportRoot, { recursive: true, force: true });
    }
  });

  it('measures latency and obtains outcome and tools from the observer', async () => {
    const reportRoot = await temporaryRoot('observation');
    const factory = factoryFor({
      system: {
        run: async () => {
          await new Promise((resolve) => setTimeout(resolve, 5));
          return successfulRun();
        },
      },
      observer: {
        observe: () =>
          Promise.resolve({
            outcome: { stored: true },
            toolCalls: [{ name: 'persist', arguments: { value: true } }],
            source: 'independent-test-store',
          }),
      },
    });

    try {
      const result = await runSuite({
        tasks: [task],
        factory,
        trials: 1,
        k: 1,
        concurrency: 1,
        thresholds,
        reportRoot,
        runId: 'observed-run',
      });
      const run = result.records[0]?.run;

      expect(run?.outcome).toEqual({ stored: true });
      expect(run?.toolCalls[0]?.name).toBe('persist');
      expect(run?.metrics.latencyMs).toBeGreaterThanOrEqual(4);
      expect(run?.metrics.latencySource).toBe('harness-wall-clock');
      expect(result.summary.independentEvidenceRate).toBe(1);
    } finally {
      await rm(reportRoot, { recursive: true, force: true });
    }
  });

  it('retains system output and fails closed when observation fails', async () => {
    const reportRoot = await temporaryRoot('observer-failure');
    const factory = factoryFor({
      system: { run: () => Promise.resolve(successfulRun()) },
      observer: {
        observe: () => Promise.reject(new Error('database unavailable')),
      },
    });

    try {
      const result = await runSuite({
        tasks: [task],
        factory,
        trials: 1,
        k: 1,
        concurrency: 1,
        thresholds,
        reportRoot,
      });

      expect(result.records[0]?.run.output).toEqual({ status: 'complete' });
      expect(result.records[0]?.run.evidenceSource).toBe('unavailable');
      expect(result.records[0]?.passed).toBe(false);
      expect(result.records[0]?.grades[0]?.grader).toBe('evidence:runtime');
    } finally {
      await rm(reportRoot, { recursive: true, force: true });
    }
  });

  it('retains deterministic evidence when the judge fails', async () => {
    const reportRoot = await temporaryRoot('judge-failure');
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
        thresholds: { ...thresholds, requireJudge: true },
        reportRoot,
        judgeProvider,
      });
      const record = result.records[0];

      expect(record?.run.output).toEqual({ status: 'complete' });
      expect(record?.deterministicPassed).toBe(true);
      expect(record?.judgePassed).toBe(false);
      expect(record?.grades.map((grade) => grade.grader)).toEqual([
        'turn-budget',
        'judge:quality:runtime',
      ]);
      expect(record?.error).toBe('judge unavailable');
    } finally {
      await rm(reportRoot, { recursive: true, force: true });
    }
  });

  it('removes the workspace even when environment disposal fails', async () => {
    const reportRoot = await temporaryRoot('cleanup');
    let trialWorkspace = '';
    const factory: SystemUnderTestFactory = {
      name: 'cleanup-test',
      evidenceSource: 'test-observer',
      create: (context) => {
        trialWorkspace = context.workspace;
        return Promise.resolve({
          system: { run: () => Promise.resolve(successfulRun()) },
          observer: { observe: () => Promise.resolve(observed()) },
          dispose: () => Promise.reject(new Error('close failed')),
        });
      },
    };

    try {
      const result = await runSuite({
        tasks: [task],
        factory,
        trials: 1,
        k: 1,
        concurrency: 1,
        thresholds,
        reportRoot,
      });

      expect(result.records[0]?.passed).toBe(false);
      expect(result.records[0]?.error).toContain('Environment disposal failed');
      await expect(access(trialWorkspace)).rejects.toThrow();
    } finally {
      await rm(reportRoot, { recursive: true, force: true });
    }
  });
});

function successfulFactory(): SystemUnderTestFactory {
  return factoryFor({
    system: { run: () => Promise.resolve(successfulRun()) },
    observer: { observe: () => Promise.resolve(observed()) },
  });
}

function factoryFor(environment: TrialEnvironment): SystemUnderTestFactory {
  return {
    name: 'test-system',
    evidenceSource: 'test-observer',
    create: () => Promise.resolve(environment),
  };
}

function successfulRun(): SystemRun {
  return {
    output: { status: 'complete' },
    transcript: [],
    metrics: {
      inputTokens: 1,
      outputTokens: 1,
      costUsd: 0,
      turns: 1,
      usageSource: 'test-provider',
    },
  };
}

function observed(): ObservedEvidence {
  return { outcome: {}, toolCalls: [], source: 'test-observer' };
}

function temporaryRoot(label: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `eval-pyramid-${label}-`));
}
