# Eval Pyramid Starter

An executable TypeScript reference for testing LLM applications and agents with the same progression used in mature software testing: many component checks, fewer real boundary tests, and a small black-box system layer.

The repository follows one refund workflow through every layer. The offline example starts a real application server and a separate tool service on ephemeral localhost ports. Tool actions mutate trial-scoped state on disk. The harness reads that state through an observer endpoint, measures wall-clock latency itself, applies release gates, and writes reviewable evidence. Nothing depends on an injected trial-number failure.

## Quick start

Requirements: Node.js 22.13 or a current Node.js 24 release, plus npm.

```bash
git clone https://github.com/bharadwaj-pendyala/eval-pyramid-starter.git
cd eval-pyramid-starter
npm ci
npx playwright install chromium
npm run test:pyramid
```

Inspect the latest system report with:

```bash
npm run report:serve
```

Every run is retained under `reports/runs/<run-id>`. `reports/latest` is a convenient copy of the newest run. Reports, local calibration records, review decisions, coverage, and installed dependencies are ignored by Git because they may contain application data.

## The executable pyramid

| Scope       | Framework                          | Boundary proved                                                                                                       | Example                                                                                            |
| ----------- | ---------------------------------- | --------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Component   | Vitest                             | Pure policy, parsing, grader, metric, and redaction behavior                                                          | [`tests/unit/refund-domain.test.ts`](tests/unit/refund-domain.test.ts)                             |
| Integration | Vitest plus real Node HTTP servers | Consumer and provider contracts, runtime validation, persisted tool state, and a complete scenario over TCP           | [`tests/integration/refund-tool-contract.test.ts`](tests/integration/refund-tool-contract.test.ts) |
| System      | Public eval CLI plus Playwright    | Tasks through application server, tool service, observer, graders, gates, report files, report server, and browser UI | [`tests/e2e/report.spec.ts`](tests/e2e/report.spec.ts)                                             |

Test scope and verdict method are separate axes. Vitest and Playwright determine how much of the system executes. Deterministic assertions, calibrated model judges, and human decisions determine how evidence receives a verdict. Calling an LLM judge does not make a component test end-to-end.

The refund slice covers three consequential paths: a duplicate charge that must be refunded and confirmed, an old order that must not trigger a financial action, and a request missing its order identifier. The financial paths are marked `critical`, so one failure blocks the release even when aggregate rates remain high.

## Real evidence flow

```text
task fixture
  -> application HTTP endpoint
  -> refund agent
  -> tool-service HTTP endpoints
  -> persisted tool state and call log
  -> independent evidence endpoint
  -> deterministic graders and optional calibrated judge
  -> severity-aware release gate
  -> immutable report and human review queue
```

The application response contains its output, safe transcript, and provider usage. It cannot award itself credit for side effects. Outcome and tool-call evidence come from the separate observer. The harness replaces any application latency claim with its own wall-clock measurement. A configured cost budget fails closed when the provider does not report cost.

## Commands

```bash
npm run eval:deterministic                 # One real HTTP trial per checked-in task
npm run eval:repeat -- --trials 20 --k 3  # Fresh application and tool state per trial
npm run eval:ci                            # Offline, release-gated lane used in CI
npm run eval:judge                         # Calibrate the OpenAI judge against human labels
npm run eval:live                          # Evaluate your HTTP SUT with the calibrated judge
npm run eval:review -- list                # List pending decisions from the latest run
npm run eval:review -- adjudicate --task TASK --trial 0 --score 0.5 --notes "Reason"
npm run eval:review -- export              # Export decisions as calibration candidates
npm run test:unit
npm run test:integration
npm run test:system
npm run test:pyramid
npm run verify
```

The local rule-based example is intentionally stable, so repeated local runs should pass. It proves trial isolation, evidence collection, reliability calculation, and reporting. Use `eval:live` against a stochastic model-backed application to measure actual model reliability. Do not manufacture alternating failures to make the chart interesting.

The harness reports two different repeated-use questions:

```text
pass@k = 1 - C(n - c, k) / C(n, k)   at least one of k attempts succeeds
pass^k = C(c, k) / C(n, k)           all k attempts succeed
```

Here, `n` is the number of fresh trials and `c` is the number that passed. The estimators sample without replacement from observed trials. They are not confidence intervals and do not prove independence.

## Connect a real model application

The live lane is provider-neutral. Your application implements a run endpoint, and a separately controlled service implements an evidence endpoint. Set both URLs in `.env`:

```dotenv
EVAL_SUT_RUN_URL=https://staging.example.com/eval/run
EVAL_EVIDENCE_URL=https://eval-observer.example.com/eval/evidence
OPENAI_API_KEY=your-local-or-ci-secret
OPENAI_JUDGE_MODEL=gpt-5-mini
```

Then run:

```bash
npm run eval:judge
npm run eval:live
```

`eval:judge` stores a local calibration record with the provider, model, golden-set SHA-256, result, and timestamp. `eval:live` refuses to start when that record failed, is older than seven days, targets another model, or no longer matches the golden set. The OpenAI key is read only from the environment and never written to a report.

The checked-in fake signal matcher exists only as a unit-test double. It fails the semantic golden set and is not available from the public CLI or package exports.

See [Adapting the starter](docs/ADAPTING.md) for the HTTP contracts, [The executable eval pyramid](docs/EVAL-PYRAMID.md) for test placement, and [Design and limits](docs/DESIGN.md) for remaining tradeoffs.

## Safety boundaries

- Keep production conversations, credentials, and personal data out of fixtures.
- Point side-effecting evals at a disposable tenant, namespace, database, or sandbox. Never use production financial tools.
- Treat model output as untrusted. The HTML report escapes dynamic values and report persistence redacts common secret fields, email addresses, bearer tokens, and OpenAI-style keys.
- Treat redaction as defense in depth, not a data-loss-prevention guarantee.
- Keep the SUT and observer independently controlled. An observer that simply echoes the SUT response defeats the evidence boundary.
- Model judges can be biased, inconsistent, and prompt-injected. Calibrate them, fail closed on missing scores, and retain human decisions.

Read [`SECURITY.md`](SECURITY.md) and [`docs/THREAT-MODEL.md`](docs/THREAT-MODEL.md) before connecting real tools or providers.

## Companion series

- [The Eval Pyramid](https://bharad.dev/blog/eval-pyramid)
- [Measuring Agent Reliability](https://bharad.dev/blog/measuring-agent-reliability)
- [Build the Eval Pyramid](https://bharad.dev/blog/build-the-eval-pyramid)

## Contributing and license

Run `npm run verify` and `npm run test:system` before opening a pull request. See [`CONTRIBUTING.md`](CONTRIBUTING.md) for fixture and review requirements.

Licensed under the [MIT License](LICENSE).
