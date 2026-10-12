# Adapting the starter

The narrowest useful integration replaces the synthetic refund adapter while keeping the task, grader, and reporting contracts stable.

## Implement the system boundary

Implement `SystemUnderTestFactory` and return a fresh `SystemUnderTest` for each trial:

```ts
import type {
  AgentRun,
  EvalTask,
  SystemUnderTest,
  SystemUnderTestFactory,
  TrialContext,
} from '../src/types.js';

class ProductFactory implements SystemUnderTestFactory {
  create(): Promise<SystemUnderTest> {
    return Promise.resolve(new ProductAdapter());
  }
}

class ProductAdapter implements SystemUnderTest {
  async run(task: EvalTask, context: TrialContext): Promise<AgentRun> {
    // Invoke your application in context.workspace and return observable evidence.
    throw new Error(
      `Implement task ${task.id} for trial ${context.trialIndex}.`
    );
  }

  async dispose(): Promise<void> {
    // Close clients and release trial-scoped resources.
  }
}
```

Return the final output, observable outcome, transcript, tool calls, latency, token counts, cost, and conversational turn count. Do not award credit for hidden chain-of-thought. Grade only evidence that your application can safely retain and review.

## Write tasks before rubrics

Start with cases that have machine-checkable answers:

- required output shape;
- expected database or workflow outcome;
- required and forbidden tools;
- turn, cost, and latency budgets.

Add a rubric only when the behavior cannot be expressed reliably as a deterministic assertion. Keep each rubric criterion atomic and give it a human-scored golden set.

## Choose a model judge

Rubric criteria are scored by a `JudgeProvider` (see [`src/types.ts`](../src/types.ts)). The starter ships three:

- `fake` — the offline signal judge, the default. It needs no credentials and matches `requiredSignals`, so every layer runs without an API key.
- `openai` — calls the OpenAI Responses API. Set `OPENAI_API_KEY` and optionally `OPENAI_JUDGE_MODEL`.
- `anthropic` (alias `claude`) — calls the Anthropic Claude Messages API ([`src/adapters/anthropic-judge.ts`](../src/adapters/anthropic-judge.ts)). Set `ANTHROPIC_API_KEY` and optionally `ANTHROPIC_JUDGE_MODEL` (default `claude-opus-5-5`).

Select one with `--judge <mode>` on `run` or `calibrate`. Each hosted adapter requests structured JSON and returns the same `JudgeScore` (`score`, `confidence`, `rationale`, `unknown`), so you can swap providers without touching graders, calibration, or reports. To add another provider, implement `JudgeProvider`, mirror one of the existing adapters, and wire a new mode in [`src/cli.ts`](../src/cli.ts). Calibrate every judge against a human-scored golden set before trusting its scores.

## Preserve trial isolation

The harness creates a separate temporary workspace and a fresh adapter for every trial. Your adapter is still responsible for isolating external resources. Use a disposable tenant, namespace, database transaction, or mocked tool layer. Never point destructive eval tools at production.

## Establish thresholds

Run a reviewed baseline with enough trials to expose observed variance. Choose `k` from the product behavior you need to reason about, then set thresholds in `eval.config.ts`. Record why each threshold exists and who can approve a change.

The included finite estimators summarize the sampled trials. For release decisions with sparse failures or costly incidents, add confidence intervals and severity-weighted gates appropriate to your risk.
