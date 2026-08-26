import type {
  AgentRun,
  EvalTask,
  SystemUnderTest,
  SystemUnderTestFactory,
  ToolCall,
  TranscriptEvent,
} from '../types.js';

/**
 * Replays the known-good answer a task ships with. A task the oracle cannot
 * pass is a broken task, not a hard one: its graders reject a correct result.
 */
export class OracleAgentFactory implements SystemUnderTestFactory {
  create(): Promise<SystemUnderTest> {
    return Promise.resolve(new OracleAgent());
  }
}

class OracleAgent implements SystemUnderTest {
  run(task: EvalTask): Promise<AgentRun> {
    const reference = task.reference;
    if (!reference) {
      return Promise.reject(
        new Error(
          `Task ${task.id} ships no reference answer, so the oracle has nothing to replay.`
        )
      );
    }

    const toolCalls = reference.toolCalls ?? requiredToolCalls(task);
    const transcript: TranscriptEvent[] = [
      { role: 'user', content: task.input.message },
      ...toolCalls.map((call): TranscriptEvent => ({
        role: 'assistant',
        content: `Calling ${call.name}`,
        toolCall: call,
      })),
      { role: 'assistant', content: 'Reference answer replayed.' },
    ];

    return Promise.resolve({
      output: reference.output,
      outcome: reference.outcome ?? task.expected.outcome ?? {},
      transcript,
      toolCalls,
      // Reported as measured. A reference answer that breaks the task's own
      // budget is a fixture to fix, and the control should say so.
      metrics: {
        latencyMs: 0,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        turns: toolCalls.length + 1,
      },
    });
  }
}

function requiredToolCalls(task: EvalTask): ToolCall[] {
  return (task.expected.requiredTools ?? []).map((expected) => ({
    name: expected.name,
    arguments: expected.arguments ?? {},
  }));
}
