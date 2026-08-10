import type { EvalConfig } from './src/types.js';

const config: EvalConfig = {
  taskFile: 'evals/tasks.jsonl',
  reportDirectory: 'reports/latest',
  concurrency: 2,
  thresholds: {
    deterministicPassRate: 1,
    passAt1: 0.8,
    passPowerK: 0.5,
    judgeAverage: 0.8,
  },
};

export default config;
