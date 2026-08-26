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

The harness times the call into `run` itself and grades `maxLatencyMs` against that measurement, so your `latencyMs` is recorded but not trusted. Cost, tokens, and turns come only from you: report them from the provider's usage response rather than estimating, since budgets and the spend column are computed from them.

Throw from `run` when the trial could not happen at all — an authentication failure, an exhausted quota, a provider outage. The harness records that as `system_error`, keeps it out of every rate, and retries it if `retries` allows. Returning a degraded answer instead turns an infrastructure problem into a recorded model failure.

## Write tasks before rubrics

Start with cases that have machine-checkable answers:

- required output shape;
- expected database or workflow outcome;
- required and forbidden tools;
- turn, cost, and latency budgets.

Add a rubric only when the behavior cannot be expressed reliably as a deterministic assertion. Keep each rubric criterion atomic and give it a human-scored golden set.

## Ship a reference answer with every task

Give each task a `reference` block holding the output a correct system would produce, and the outcome and tool calls that go with it when they differ from `expected`:

```json
{
  "id": "example-task",
  "expected": { "...": "..." },
  "reference": {
    "output": { "status": "resolved" },
    "outcome": { "ticket": { "status": "resolved" } },
    "toolCalls": [{ "name": "verify_identity", "arguments": {} }]
  }
}
```

`npm run eval:selftest` replays it through every grader the task declares and separately checks that an empty result is rejected. Run it whenever you add or change a task: a control failure means the task is wrong, and no score from it is worth reading.

## Expect trials that measure nothing

When your adapter throws, a grader crashes, or the judge is unreachable, the harness records the trial as invalid and keeps it out of every rate.

Against a live provider, set `retries` to 1 or 2 in `eval.config.ts`. That absorbs the ordinary 429 and 503 without touching a real result — only infrastructure outcomes are retried. Give the adapter its own request timeout as well, since the harness does not terminate a run that hangs.

Then watch the invalid rate. A run with many invalid trials is not a run with a low score, it is a run that did not measure, and `maxInvalidRate` is what stops it from shipping as if it had.

## Preserve trial isolation

The harness creates a separate temporary workspace and a fresh adapter for every trial. Your adapter is still responsible for isolating external resources. Use a disposable tenant, namespace, database transaction, or mocked tool layer. Never point destructive eval tools at production.

## Establish thresholds

Run a reviewed baseline with enough trials to expose observed variance. Choose `k` from the product behavior you need to reason about, then set thresholds in `eval.config.ts`. Record why each threshold exists and who can approve a change.

The included finite estimators summarize the sampled trials. For release decisions with sparse failures or costly incidents, add confidence intervals and severity-weighted gates appropriate to your risk.
