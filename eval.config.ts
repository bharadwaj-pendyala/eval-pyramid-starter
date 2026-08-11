import type { EvalConfig } from './src/types.js';

const sharedThresholds = {
  deterministicPassRate: 1,
  passAt1: 0.8,
  passPowerK: 0.5,
  judgeAverage: 0.8,
  criticalPassRate: 1,
  requireIndependentEvidence: true,
};

const config: EvalConfig = {
  taskFile: 'evals/tasks.jsonl',
  reportRoot: 'reports',
  concurrency: 2,
  thresholds: {
    ...sharedThresholds,
    requireJudge: false,
  },
  liveThresholds: {
    ...sharedThresholds,
    requireJudge: true,
  },
};

export default config;
