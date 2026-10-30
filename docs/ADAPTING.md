# Adapting the starter

The production-shaped integration has two independent HTTP boundaries: one invokes the application, and one observes durable side effects. This prevents an application from declaring its own tool use or business outcome successful.

## 1. Define generic tasks

`EvalTask.input` accepts any JSON object. Replace the refund fixtures with synthetic or de-identified cases for your product. Assign a severity to every case and express machine-checkable expectations before adding rubrics.

```json
{
  "id": "cancel-subscription",
  "description": "Cancel an active subscription after identity verification.",
  "severity": "critical",
  "input": { "accountId": "acct-100", "message": "Cancel my plan." },
  "expected": {
    "outcome": { "subscription": { "status": "cancelled" } },
    "requiredTools": [{ "name": "cancel_subscription" }],
    "forbiddenTools": ["delete_account"],
    "maxTurns": 6,
    "maxLatencyMs": 10000
  }
}
```

Update `evals/eval-task.schema.json` only when your task envelope needs stronger input validation. Keep product-specific input validation inside the SUT adapter as well.

## 2. Implement the application endpoint

Set `EVAL_SUT_RUN_URL` to an endpoint that accepts:

```json
{
  "input": { "customerId": "customer-100", "message": "..." },
  "context": { "runId": "...", "trialId": "...", "trialIndex": 0 }
}
```

The request carries only the task input. The application never sees `expected` or `rubric`, so it cannot copy the answer key. Key any per-trial state on `trialId`, because `trialIndex` repeats across tasks.

Return only application-owned evidence:

```json
{
  "output": { "message": "The subscription is cancelled." },
  "transcript": [
    { "role": "user", "content": "Cancel my plan." },
    { "role": "assistant", "content": "The subscription is cancelled." }
  ],
  "metrics": {
    "turns": 2,
    "inputTokens": 420,
    "outputTokens": 38,
    "costUsd": 0.0014,
    "usageSource": "provider-response:model-name"
  }
}
```

Token and cost fields are optional. When a task configures `maxCostUsd`, a missing cost fails closed. Do not return hidden chain-of-thought. Retain only safe, reviewable transcript events.

The harness measures wall-clock latency around this request. An application-provided latency field is ignored.

## 3. Implement the evidence endpoint

Set `EVAL_EVIDENCE_URL` to a separately controlled endpoint. The harness calls it with `taskId`, `runId`, `trialId`, and `trialIndex` query parameters after the application returns. Return refused tool calls in an optional `rejectedToolCalls` array. Give each one the arguments as submitted and a `position`: the number of completed calls before it. A forbidden tool then fails the trial even when the service blocked it, and a refused call made before its prerequisites fails the order check.

Return durable, externally observed evidence:

```json
{
  "outcome": { "subscription": { "status": "cancelled" } },
  "toolCalls": [
    { "name": "verify_identity", "arguments": { "accountId": "acct-100" } },
    { "name": "cancel_subscription", "arguments": { "accountId": "acct-100" } }
  ],
  "source": "audit-database:eval-events"
}
```

Good evidence sources include an audit database, workflow event store, sandbox ledger, test tenant, or tool proxy owned outside the SUT process. An endpoint that echoes the SUT response is still self-reporting and should use a `self-reported:` source label. Release gates can reject it.

Use a unique tenant, namespace, transaction, or database per trial. Clean up only that resolved trial scope. Never point destructive eval tools at production.

## 4. Run the live lane

Copy `.env.example` to `.env`, set the two endpoint URLs and judge credentials, then run:

```bash
npm run eval:judge
npm run eval:live
```

The first command scores the human-labeled golden set and writes a local calibration record. The second verifies that record before it makes judged eval calls. A model change, golden-set edit, failed calibration, or record older than seven days requires recalibration.

The paid live workflow is manual by default. Pull requests run the offline real-HTTP stack and never require secrets or call a model provider.

## 5. Review failures

```bash
npm run eval:review -- list
npm run eval:review -- adjudicate --task cancel-subscription --trial 0 --score 0 --notes "Cancellation was not persisted."
npm run eval:review -- export
```

Trial indices are zero-based in the machine-readable files and review command. Decisions are append-only under `reports/reviews/<run-id>.jsonl`. The original run under `reports/runs/<run-id>` remains unchanged.

Review exports are calibration candidates, not an automatic golden-set update. A person should select an atomic rubric criterion, remove sensitive data, and approve the label before committing it.

## 6. Set evidence-based gates

Run a reviewed baseline with enough trials to expose observed variance. Choose `k` from the product behavior you need to reason about. Record why each threshold exists and who can approve a change.

The starter gates aggregate deterministic quality, `pass@1`, `pass^k`, critical-task pass rate, independent evidence coverage, and an optional judge average. Add confidence intervals, slice-specific thresholds, and risk-weighted gates when sparse but costly failures matter.
