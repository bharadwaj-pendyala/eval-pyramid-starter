import type {
  AgentRun,
  SystemUnderTest,
  SystemUnderTestFactory,
} from '../types.js';

/**
 * Does nothing, deliberately. A task this passes cannot tell work apart from
 * no work, so its expectations are not measuring anything.
 */
export class NopAgentFactory implements SystemUnderTestFactory {
  create(): Promise<SystemUnderTest> {
    return Promise.resolve(new NopAgent());
  }
}

class NopAgent implements SystemUnderTest {
  run(): Promise<AgentRun> {
    return Promise.resolve({
      output: {},
      outcome: {},
      transcript: [],
      toolCalls: [],
      metrics: {
        latencyMs: 0,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        turns: 0,
      },
    });
  }
}
