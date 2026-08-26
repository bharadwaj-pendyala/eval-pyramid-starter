# Eval Pyramid Starter

A provider-neutral TypeScript starter for testing LLM applications and agents with deterministic graders, repeated trials, calibrated model judges, and a human review queue.

The default refund workflow is synthetic and runs offline. You can inspect every layer without an API key, then replace the adapter with your system under test.

## Quick start

Requirements: Node.js 22.13 or a current release from Node.js 24 onward, plus npm.

```bash
git clone https://github.com/bharadwaj-pendyala/eval-pyramid-starter.git
cd eval-pyramid-starter
npm ci
npm run eval:selftest
npm run eval:deterministic
npm run eval:repeat -- --trials 10 --k 3
npm run eval:judge
npm run eval:review
```

Open `reports/latest/index.html` directly, or serve it locally:

```bash
npm run report:serve
```

The generated report includes aggregate reliability, per-trial results, failures, and a JSONL queue for human review. Generated reports are ignored by Git because they can contain application data.

## What is included

```text
evals/                  Versioned task fixtures and judge golden set
src/adapters/           Offline system and judge adapters, the oracle and nop controls,
                        plus an OpenAI judge adapter
src/graders/            Deterministic and rubric graders
src/harness/            Isolated trial runner, reliability metrics, controls, and reports
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
npm run eval:selftest                      # Prove the graders with both controls
npm run eval:deterministic                 # One offline trial per task
npm run eval:repeat -- --trials 20 --k 3  # Repeated offline trials
npm run eval:judge                         # Calibrate the offline judge
npm run eval:ci                            # Release-gated eval used in automation
npm run eval:review                        # Count queued human reviews
npm run test                               # Unit and integration tests
npm run test:e2e                           # Generate and test the HTML report
npm run verify                             # Format, types, lint, coverage, and build
```

`eval:ci` exits unsuccessfully when a configured threshold is missed. Thresholds, concurrency, task paths, and report paths live in [`eval.config.ts`](eval.config.ts).

## Prove the graders before you trust a score

A grader that accepts anything reports a perfect model. Two controls bracket every task, and `npm run eval:selftest` runs both:

- The **oracle** replays the known-good `reference` answer the task ships with. Every grader must accept it. A task the oracle cannot pass is broken, not hard.
- The **nop** control returns nothing at all. At least one grader must reject it. A task it passes cannot tell work apart from no work.

Both controls are also available to the runner as `--system oracle` and `--system nop`, so you can produce a full report for either.

## Scored and invalid trials

Only a trial that reached a verdict says anything about the system under test. When the adapter throws, a grader crashes, or the judge is unreachable, the trial is recorded as **invalid** with a status naming the failure, and it is excluded from `pass@1`, `pass@k`, `pass^k`, the deterministic pass rate, and the judge average. Cleanup problems that happen after the measurement are recorded as warnings and change no result.

Dropping those trials silently would be its own way to mislead, so the release gate also fails when the share of invalid trials exceeds `maxInvalidRate`, and every report states how many trials were scored against how many ran.

## Comparing two runs

Each `summary.json` carries a `provenance` block: digests of the task set and of the run configuration, the Git commit and whether the tree was dirty, the system under test, the judge, and the versions that produced the numbers. Two reports with the same digests measured the same thing; two with different digests did not, however similar their scores look.

## Adapt it to your application

1. Replace the examples in [`evals/tasks.jsonl`](evals/tasks.jsonl) while keeping them synthetic or properly de-identified. Give each task a `reference` answer so the oracle control can prove its graders.
2. Implement `SystemUnderTest` and `SystemUnderTestFactory` from [`src/types.ts`](src/types.ts). The trial context gives each run a separate temporary workspace.
3. Point the CLI at your factory, then add deterministic graders before adding model-judged criteria.
4. Run `npm run eval:selftest` and fix every control failure before reading a real score.
5. Build a human-scored golden set for every model judge and run calibration before trusting its scores.
6. Set release thresholds from a reviewed baseline. Do not copy the example values into production without evidence.

The included OpenAI judge is optional. Set `OPENAI_API_KEY`, optionally set `OPENAI_JUDGE_MODEL`, and run `tsx src/cli.ts calibrate --judge openai`. The system-under-test interface itself has no provider dependency.

See [Adapting the starter](docs/ADAPTING.md) for the contract and [Design and limits](docs/DESIGN.md) for the decisions this template makes deliberately.

## Safety boundaries

- Keep production conversations, credentials, and personal data out of fixtures.
- Treat model output as untrusted. The HTML report escapes dynamic values and the report writer redacts common secret fields, email addresses, bearer tokens, and OpenAI-style API keys.
- Replace the example redactor with controls appropriate to your data classification. Pattern matching cannot guarantee that arbitrary private data is removed.
- Keep side-effecting tools sandboxed in eval environments. The fake adapter never touches an external system.
- Model judges can be biased, inconsistent, or prompt-injected. Calibrate them against human labels and retain a human queue.

Read [`SECURITY.md`](SECURITY.md) and [`docs/THREAT-MODEL.md`](docs/THREAT-MODEL.md) before connecting real tools or model providers.

## Companion series

This repository is the runnable companion to the three-part Eval Pyramid series:

- [The Eval Pyramid](https://bharad.dev/blog/eval-pyramid) explains what belongs at each layer.
- [Measuring Agent Reliability](https://bharad.dev/blog/measuring-agent-reliability) separates single-attempt quality from repeated-use reliability.
- [Build the Eval Pyramid](https://bharad.dev/blog/build-the-eval-pyramid) walks through this implementation and its tradeoffs.

Each article links back here so the explanation and executable reference stay connected.

## Contributing and license

Run `npm run verify` and `npm run test:e2e` before opening a pull request. See [`CONTRIBUTING.md`](CONTRIBUTING.md) for fixture and review requirements.

Licensed under the [MIT License](LICENSE).
