# Eval Pyramid Starter

A provider-neutral TypeScript starter for testing LLM applications and agents with deterministic graders, repeated trials, calibrated model judges, and a human review queue.

The default refund workflow is synthetic and runs offline. You can inspect every layer without an API key, then replace the adapter with your system under test.

## Quick start

Requirements: Node.js 22.13 or a current release from Node.js 24 onward, plus npm.

```bash
git clone https://github.com/bharadwaj-pendyala/eval-pyramid-starter.git
cd eval-pyramid-starter
npm ci
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
src/adapters/           Offline system and judge adapters, plus OpenAI and Anthropic (Claude) judge adapters
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
npm run test                               # Unit and integration tests
npm run test:e2e                           # Generate and test the HTML report
npm run verify                             # Format, types, lint, coverage, and build
```

`eval:ci` exits unsuccessfully when a configured threshold is missed. Thresholds, concurrency, task paths, and report paths live in [`eval.config.ts`](eval.config.ts).

## Adapt it to your application

1. Replace the examples in [`evals/tasks.jsonl`](evals/tasks.jsonl) while keeping them synthetic or properly de-identified.
2. Implement `SystemUnderTest` and `SystemUnderTestFactory` from [`src/types.ts`](src/types.ts). The trial context gives each run a separate temporary workspace.
3. Point the CLI at your factory, then add deterministic graders before adding model-judged criteria.
4. Build a human-scored golden set for every model judge and run calibration before trusting its scores.
5. Set release thresholds from a reviewed baseline. Do not copy the example values into production without evidence.

The included model judges are optional and provider-neutral in shape:

- OpenAI: set `OPENAI_API_KEY`, optionally set `OPENAI_JUDGE_MODEL`, and run `tsx src/cli.ts calibrate --judge openai`.
- Anthropic (Claude): set `ANTHROPIC_API_KEY`, optionally set `ANTHROPIC_JUDGE_MODEL` (default `claude-opus-5-5`), and run `tsx src/cli.ts calibrate --judge anthropic` (`--judge claude` is accepted as an alias).

Both adapters emit the same `JudgeScore` shape, so deterministic graders, calibration, and reporting are unchanged. The system-under-test interface itself has no provider dependency.

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
