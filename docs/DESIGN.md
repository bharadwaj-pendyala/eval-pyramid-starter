# Design and limits

## Design choices

The starter separates system output from observed evidence. `SystemUnderTest` returns output, a safe transcript, and provider usage. `EvidenceObserver` returns tool calls and business state from another boundary. The harness measures latency itself and combines both records only after execution.

The offline reference uses real ephemeral HTTP servers at integration and system scope. The tool provider enforces ownership, mutates state, and persists a call log inside a unique trial workspace. Runtime validators reject malformed application, evidence, order, and policy responses.

Execution scope and verdict method remain independent. Vitest component and integration tests plus a Playwright system test define how much code executes. Deterministic graders, a calibrated OpenAI judge, and durable human decisions define how evidence is assessed.

Every report records configuration, task-set SHA-256, SUT identity, observer identity, judge identity, and source revision when Git is available. Run directories are immutable. `reports/latest` is a replaceable convenience copy.

The public CLI exposes a provider-neutral HTTP SUT mode. OpenAI is an optional judge adapter, not a required SUT provider and not a recommendation for every rubric.

## Fail-closed behavior

- A required judge with no score fails its gate.
- A configured cost budget with no provider-reported cost fails its grader.
- Missing or malformed external evidence fails the trial.
- A critical task failure blocks the release regardless of aggregate rates.
- A self-reported evidence source fails the independent-evidence gate.
- A judged live run cannot start without a current passing calibration for the same model and golden set.

## Deliberate limits

- The checked-in application is rule-based. It proves execution mechanics but does not claim model reliability. Use the remote HTTP mode for a real model application.
- The harness timeout is enforced by HTTP adapters. An in-process custom SUT must implement its own cancellation if it can hang.
- The finite `pass@k` and `pass^k` estimators describe observed samples without replacement. They do not establish causality, independence, or confidence bounds.
- Trial environments are fresh and independent. The starter does not model retries inside one shared conversation.
- Redaction is defense in depth, not a data-loss-prevention system. Use synthetic inputs and organization-specific controls.
- The OpenAI judge uses bounded retries and strict output validation, but model judges can still be biased or vulnerable to adversarial evidence.
- The review export produces candidates. It does not automatically alter the trusted golden set.
- Cross-repository provider ownership still benefits from OpenAPI publication or Pact consumer and provider verification.

## Why there is no hidden trace grader

The harness records observable transcripts and tool calls, but it does not request private chain-of-thought. Graders evaluate final output, durable state transitions, provider usage, and auditable actions. This is evidence teams can retain, debug, and govern.
