# The executable eval pyramid

The pyramid in this repository orders graders by the cost of one verdict. Code checks are cheapest and cover the most. A calibrated model judge costs more and covers less. Human review costs the most and covers the least.

```text
            human review        few verdicts, highest cost
         calibrated model judge
   deterministic code checks     most verdicts, lowest cost
```

Two other decisions are independent of the grader. Most published eval pyramids merge one of them into the layers, so this repository keeps all three apart:

| Axis            | Question                                      | Values in this repository                                |
| --------------- | --------------------------------------------- | -------------------------------------------------------- |
| Grader          | What does one verdict cost, and who gives it? | Deterministic code, calibrated model judge, human review |
| Execution scope | How much of the system runs to make evidence? | Component, integration, system                           |
| Trials          | How many times does each task run?            | One trial, or `n` isolated trials summarized per task    |

- **Trials are not a layer.** Any grader can score any trial. Repetition answers how often a task succeeds. It does not decide how a verdict is made.
- **Running a trial and grading it have different costs.** A ledger check is cheap to grade. The full agent run that produces the ledger state can still be slow and expensive.
- **Scope does not choose the grader.** Calling a model judge from a unit test does not make that test end-to-end. A Playwright system test can use only deterministic verdicts.

Anthropic's [agent eval guide](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents) already defines tasks, trials, and graders as separate terms. This repository keeps that separation inside the pyramid picture.

## The system does not grade itself

- The system under test receives only `task.input`. It never sees `expected` or `rubric`.
- The outcome comes from the tool service that executed the actions, through a separate observer boundary. The agent's own report of what it did is never the outcome.
- Required tools must appear in the listed order, so a refund before identity verification fails.
- Tasks that can move money are `critical`. One failed critical trial blocks the release, whatever the aggregate rates are.

## One use case through every scope

The refund workflow is:

```text
customer request
  -> verify identity
  -> fetch the order and policy
  -> refund and confirm, escalate, or request information
  -> persist calls and business state outside the application
  -> observe state through a separate boundary
  -> grade output, outcome, tool policy, usage, and latency
```

The task set covers a valid duplicate-charge refund, a prohibited out-of-window refund, and missing order details. It exercises a successful financial action, prevention of an unsafe action, and safe handling of incomplete input. Three adversarial tasks add a prompt injection in the customer message, a request for more money than the charge, and an order that belongs to another customer.

The sections below follow the execution-scope axis. Each scope can use any grader.

## Component scope with Vitest

[`tests/unit/refund-domain.test.ts`](../tests/unit/refund-domain.test.ts) calls the pure order parser and policy decision directly. It has no filesystem, HTTP, model, report, or tool dependency.

Use this scope for broad input tables and exact invariants. A failure should name a small function and run in milliseconds.

```bash
npm run test:unit
```

The equivalent Java choices are JUnit 5 or TestNG. The framework is less important than preserving the component boundary.

## Integration scope with real provider boundaries

[`tests/integration/refund-tool-contract.test.ts`](../tests/integration/refund-tool-contract.test.ts) starts the actual tool provider on an ephemeral TCP port and calls it through the production HTTP gateway. It verifies request semantics, runtime response validation, ownership enforcement, state mutation, and persisted evidence. A malformed response comes from a real HTTP server and is rejected at the consumer boundary.

[`tests/integration/run-suite.test.ts`](../tests/integration/run-suite.test.ts) starts the application server and tool server for each trial, runs all tasks through HTTP, observes persisted state, grades the records, and verifies immutable reports.

```bash
npm run test:integration
```

This is stronger than an HTTP interception test because both consumer and provider code execute over a real socket. When different teams or repositories own the services, add a published OpenAPI contract or Pact consumer and provider verification at the same scope. A mock by itself does not prove that the deployed provider conforms.

The Java equivalents are JUnit 5 plus a real embedded service, Testcontainers, WireMock for targeted client behavior, and Pact JVM for cross-team contracts.

## System scope with the CLI and Playwright

`npm run test:system` first invokes the public eval CLI. Every trial enters through an HTTP application endpoint, crosses the HTTP tool provider, reads external evidence, evaluates release gates, and writes a report. [`tests/e2e/report.spec.ts`](../tests/e2e/report.spec.ts) then inspects the served report in desktop and mobile Chromium.

```bash
npm run test:system
```

This scope answers whether the shipped workflow operates as a whole. Keep it small. Branch-heavy policy behavior belongs at component scope, and boundary failure modes belong at integration scope.

The Java equivalents are Playwright for Java or Selenium for browser behavior, plus a public API or CLI entry point for the system setup.

## Real failure paths

The public eval commands have no switch that sets a score. Failures come from real inputs, provider rules, and agent code.

Two options reproduce the running case from the companion posts:

- `--tool-fault transient-refund-every=N` makes the payment provider return HTTP 503 for the first refund call in every Nth trial. The fault is in the environment. A correct agent retries once and passes, so the fault alone never fails a trial.
- `--regression swallow-refund-errors` selects an agent build with a real bug. One `try`/`catch` meant for flaky confirmation emails also swallows a failed refund, and the reply still says the refund was processed.

```bash
npm run eval:fault        # correct agent under the fault: release gate passes
npm run eval:regression   # regressed agent under the fault: release gate fails
```

With 4 trials, `eligible-refund` passes 3 of them. Per task, that gives `pass@1` 75%, `pass@3` 100%, and `pass^3` 25%. The aggregate `pass@1` is 91.7% and passes its 80% threshold. The critical gate blocks the release, because one critical trial reported a refund that the ledger never recorded. The run provenance records both options in the system name.

Harness unit tests still use small test doubles to prove cleanup and error handling. Those tests measure the harness itself. They are not model reliability data.

The local rule-based agent is deterministic, so without these options it produces 100% reliability. Reliability variance from a model becomes meaningful after `eval:live` connects a stochastic model-backed system.

## Grader layers

Use deterministic graders for anything a program can establish exactly:

- output JSON Schema;
- final database or workflow state;
- required and forbidden tool calls;
- latency measured by the harness;
- provider-reported cost and token usage;
- critical-task safety invariants.

Use a model judge only for atomic semantic criteria that cannot be made deterministic. The checked-in OpenAI adapter uses strict structured output, timeouts, bounded retries, and an instruction that treats task and output text as untrusted evidence. A live judged run requires a passing calibration record for the same model and current golden set.

Use human review to adjudicate failed or unknown trials. Decisions are append-only under `reports/reviews`, do not mutate the original run, and can be exported as calibration candidates.

## pass@k and pass^k

`pass@k` asks whether at least one of `k` attempts will work. It is appropriate when a product can retry and select a valid result. `pass^k` asks whether all `k` attempts work. It is appropriate when every attempt must be dependable.

Each sampled trial in this repository receives a fresh application server, tool server, temporary workspace, and state file. The estimators describe those isolated attempts. They do not model a sequential retry conversation or shared-session recovery.

## Placement rules

- Use the cheapest grader that measures the requirement accurately. Move a criterion down a layer when it becomes unambiguous, for example from human review to a judge rubric, then to a code check.
- Run a check at the smallest scope that can prove the behavior. Promote only representative or high-risk paths to system scope.
- Choose the trial count from the question. Use one trial to prove a deterministic path. Use repeated trials per task to measure how often a stochastic system succeeds.
