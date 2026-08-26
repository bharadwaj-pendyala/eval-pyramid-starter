import type { EvalConfig } from './src/types.js';

const config: EvalConfig = {
  taskFile: 'evals/tasks.jsonl',
  reportDirectory: 'reports/latest',
  controlReportDirectory: 'reports/controls',
  concurrency: 2,
  // The offline adapter cannot fail transiently, so a retry would only hide a
  // real bug. Against a live provider, 1 or 2 absorbs the usual 429 and 503.
  retries: 0,
  thresholds: {
    deterministicPassRate: 1,
    passAt1: 0.8,
    passPowerK: 0.5,
    judgeAverage: 0.8,
    // Nothing in the offline path should fail to measure. Raise this once a
    // real provider is in the loop, and treat a rising number as an incident.
    maxInvalidRate: 0,
  },
};

export default config;
