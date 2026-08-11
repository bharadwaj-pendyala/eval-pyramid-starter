# Eval Pyramid Starter

An executable reference for testing LLM applications and agents with the same progression used in mature software testing: many fast component checks, fewer boundary scenarios, and a small number of black-box system tests.

The repository follows one realistic refund workflow through every layer. It runs offline with synthetic data, real orchestration, observable tool calls, release metrics, an optional calibrated model judge, and a human review queue.

## Quick start

Requirements: Node.js 22.13 or a current release from Node.js 24 onward, plus npm.

```bash
git clone https://github.com/bharadwaj-pendyala/eval-pyramid-starter.git
cd eval-pyramid-starter
npm ci
npx playwright install chromium
npm run test:pyramid
```

That command runs the complete evidence ladder. To inspect the generated system report:

```bash
npm run report:serve
```

The generated report includes aggregate reliability, per-trial results, failures, and a JSONL queue for human review. Generated reports are ignored by Git because they can contain application data.

## The executable pyramid

| Scope             | Framework             | What is real                                                                      | What is replaced                 | Example                                                                                            |
| ----------------- | --------------------- | --------------------------------------------------------------------------------- | -------------------------------- | -------------------------------------------------------------------------------------------------- |
| Component         | Vitest                | Refund policy and deterministic grader code                                       | Network, model, and tools        | [`tests/unit/refund-domain.test.ts`](tests/unit/refund-domain.test.ts)                             |
| Scenario boundary | Vitest + MSW          | Agent orchestration, HTTP client, task contract, graders, and reports             | Remote tool services             | [`tests/integration/refund-tool-contract.test.ts`](tests/integration/refund-tool-contract.test.ts) |
| Black-box system  | Eval CLI + Playwright | Fixtures through agent, tools, grades, release gate, report files, and browser UI | Production data and side effects | [`tests/e2e/report.spec.ts`](tests/e2e/report.spec.ts)                                             |

Test scope and verdict method are separate axes. Vitest, MSW, and Playwright determine how much of the system executes. Deterministic assertions, model judges, and human review determine how evidence receives a verdict. A model judge is not automatically an end-to-end test.

The refund slice covers three consequential paths: a duplicate charge that must be refunded and confirmed, an old order that must not trigger a financial action, and a request missing its order identifier. See [The executable eval pyramid](docs/EVAL-PYRAMID.md) for the layer boundaries, Java equivalents, and guidance for adapting the pattern.

## What is included

```text
evals/                  Versioned task fixtures and judge golden set
src/adapters/           Offline and OpenAI judge adapters
src/examples/           Runnable refund agent, domain policy, and tool gateways
src/graders/            Deterministic and rubric graders
src/harness/            Isolated trial runner, reliability metrics, and reports
src/reporting/          Redaction and human review utilities
tests/                  Unit, integration, and browser checks
.github/workflows/      Pull request and scheduled eval jobs
```

The harness measures two different repeated-use questions with finite-sample estimators:

```text
pass@k = 1 - C(n - c, k) / C(n, k)   at least one of k attempts succeeds
pass^k = C(c, k) / C(n, k)           all k attempts succeed
```

Here, `n` is the number of trials and `c` is the number that passed. The finite estimators sample without replacement from the observed trials. They are not confidence intervals and do not replace uncertainty analysis.

## Commands

```bash
npm run eval:deterministic                 # One offline trial per task
npm run eval:repeat -- --trials 20 --k 3  # Repeated offline trials
npm run eval:judge                         # Calibrate the offline judge
npm run eval:ci                            # Release-gated eval used in automation
npm run eval:review                        # Count queued human reviews
npm run test:unit                          # Fast Vitest component checks
npm run test:integration                   # Vitest + MSW boundary scenarios
npm run test:system                        # Generate and inspect the report with Playwright
npm run test:pyramid                       # Run all three layers in order
npm run test                               # All Vitest component and integration checks
npm run test:e2e                           # Alias for test:system
npm run verify                             # Format, types, lint, coverage, and build
```

`eval:ci` exits unsuccessfully when a configured threshold is missed. Thresholds, concurrency, task paths, and report paths live in [`eval.config.ts`](eval.config.ts).

## Adapt it to your application

1. Replace the examples in [`evals/tasks.jsonl`](evals/tasks.jsonl) while keeping them synthetic or properly de-identified.
2. Implement `SystemUnderTest` and `SystemUnderTestFactory` from [`src/types.ts`](src/types.ts). The trial context gives each run a separate temporary workspace.
3. Point the CLI at your factory, then add deterministic graders before adding model-judged criteria.
4. Build a human-scored golden set for every model judge and run calibration before trusting its scores.
5. Set release thresholds from a reviewed baseline. Do not copy the example values into production without evidence.

The included OpenAI judge is optional. Set `OPENAI_API_KEY`, optionally set `OPENAI_JUDGE_MODEL`, and run `tsx src/cli.ts calibrate --judge openai`. The system-under-test interface itself has no provider dependency.

See [Adapting the starter](docs/ADAPTING.md) for the contract, [The executable eval pyramid](docs/EVAL-PYRAMID.md) for test placement, [Demo walkthrough](docs/DEMO.md) for a recording script, and [Design and limits](docs/DESIGN.md) for deliberate tradeoffs.

## Safety boundaries

- Keep production conversations, credentials, and personal data out of fixtures.
- Treat model output as untrusted. The HTML report escapes dynamic values and the report writer redacts common secret fields, email addresses, bearer tokens, and OpenAI-style API keys.
- Replace the example redactor with controls appropriate to your data classification. Pattern matching cannot guarantee that arbitrary private data is removed.
- Keep side-effecting tools sandboxed in eval environments. The default in-memory gateway never touches an external system, and the integration test intercepts all tool HTTP traffic with MSW.
- Model judges can be biased, inconsistent, or prompt-injected. Calibrate them against human labels and retain a human queue.

Read [`SECURITY.md`](SECURITY.md) and [`docs/THREAT-MODEL.md`](docs/THREAT-MODEL.md) before connecting real tools or model providers.

## Companion series

This repository is the runnable companion to the three-part Eval Pyramid series:

- [The Eval Pyramid](https://bharad.dev/blog/eval-pyramid) explains what belongs at each layer.
- [Measuring Agent Reliability](https://bharad.dev/blog/measuring-agent-reliability) separates single-attempt quality from repeated-use reliability.
- [Build the Eval Pyramid](https://bharad.dev/blog/build-the-eval-pyramid) walks through this implementation and its tradeoffs.

Each article links back here so the explanation and executable reference stay connected.

## Contributing and license

Run `npm run verify` and `npm run test:system` before opening a pull request. See [`CONTRIBUTING.md`](CONTRIBUTING.md) for fixture and review requirements.

Licensed under the [MIT License](LICENSE).
