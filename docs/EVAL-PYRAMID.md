# The executable eval pyramid

The pyramid classifies tests by execution scope, not by assertion type. Each higher layer keeps more real boundaries, costs more to run and diagnose, and therefore contains fewer cases.

## Two axes

An AI system needs two independent decisions:

1. How much of the application should execute?
2. How should the resulting evidence receive a verdict?

| Execution scope | Deterministic verdict                                               | Model-judged verdict           | Human verdict                                  |
| --------------- | ------------------------------------------------------------------- | ------------------------------ | ---------------------------------------------- |
| Component       | Default for schemas, policies, parsing, tool rules, and metric math | Usually unnecessary            | Used to define expected behavior               |
| Integration     | Default for state transitions, contracts, safety rules, and budgets | Add only for semantic criteria | Review new and failed scenarios                |
| System          | Release gates and repeated-use reliability                          | Calibrated rubric scores       | Sample releases and adjudicate uncertain cases |

Calling a model judge from a unit test does not make that test end-to-end. A Playwright system test can use deterministic verdicts. Scope says what executed. A grader says how evidence was assessed.

## One use case through every layer

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

The task set covers a valid duplicate-charge refund, a prohibited out-of-window refund, and missing order details. It exercises a successful financial action, prevention of an unsafe action, and safe handling of incomplete input.

## Layer 1: component checks with Vitest

[`tests/unit/refund-domain.test.ts`](../tests/unit/refund-domain.test.ts) calls the pure order parser and policy decision directly. It has no filesystem, HTTP, model, report, or tool dependency.

Use this layer for broad input tables and exact invariants. A failure should name a small function and run in milliseconds.

```bash
npm run test:unit
```

The equivalent Java choices are JUnit 5 or TestNG. The framework is less important than preserving the component boundary.

## Layer 2: integration checks with real provider boundaries

[`tests/integration/refund-tool-contract.test.ts`](../tests/integration/refund-tool-contract.test.ts) starts the actual tool provider on an ephemeral TCP port and calls it through the production HTTP gateway. It verifies request semantics, runtime response validation, ownership enforcement, state mutation, and persisted evidence. A malformed response comes from a real HTTP server and is rejected at the consumer boundary.

[`tests/integration/run-suite.test.ts`](../tests/integration/run-suite.test.ts) starts the application server and tool server for each trial, runs all tasks through HTTP, observes persisted state, grades the records, and verifies immutable reports.

```bash
npm run test:integration
```

This is stronger than an HTTP interception test because both consumer and provider code execute over a real socket. When different teams or repositories own the services, add a published OpenAPI contract or Pact consumer and provider verification to the same layer. A mock by itself does not prove that the deployed provider conforms.

The Java equivalents are JUnit 5 plus a real embedded service, Testcontainers, WireMock for targeted client behavior, and Pact JVM for cross-team contracts.

## Layer 3: black-box checks with the CLI and Playwright

`npm run test:system` first invokes the public eval CLI. Every trial enters through an HTTP application endpoint, crosses the HTTP tool provider, reads external evidence, evaluates release gates, and writes a report. [`tests/e2e/report.spec.ts`](../tests/e2e/report.spec.ts) then inspects the served report in desktop and mobile Chromium.

```bash
npm run test:system
```

This layer answers whether the shipped workflow operates as a whole. Keep it small. Branch-heavy policy behavior belongs at the component layer, while boundary failure modes belong in integration.

The Java equivalents are Playwright for Java or Selenium for browser behavior, plus a public API or CLI entry point for the system setup.

## Real failure paths

The public eval commands do not accept `--failure-every` or any other score-shaping switch. The example's business failures come from real inputs and provider rules. Integration resilience cases use actual malformed HTTP responses, ownership conflicts, unavailable observers, and failed transports.

Harness unit tests still use small test doubles to prove cleanup and error handling. Those tests measure the harness itself. They are not presented as model reliability data.

The local rule-based application should produce 100 percent reliability. Repeated runs are still useful for proving fresh trial environments and report math. Reliability variance becomes meaningful after `eval:live` connects to a stochastic model-backed SUT.

## Verdict methods

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

## Placement rule

Put a test at the lowest layer that can prove the behavior, then promote only representative or high-risk paths upward. This keeps failures diagnostic while preserving a small set of black-box proofs.
