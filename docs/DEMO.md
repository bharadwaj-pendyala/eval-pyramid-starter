# Demo walkthrough

This script produces a compact walkthrough of the same refund behavior accumulating evidence across the pyramid. It takes about six minutes without the optional model-judge section.

## Before recording

```bash
npm ci
npx playwright install chromium
npm run verify
npm run test:system
```

Use synthetic fixtures only. Clear `reports/latest` if an older run contains output you do not want to show.

## 1. Establish the model

Open the matrix in [`README.md`](../README.md). Explain that execution scope and verdict method are separate: the pyramid controls how much system runs, while deterministic checks, model judges, and humans decide whether the evidence passes.

## 2. Run the component layer

```bash
npm run test:unit
```

Show [`tests/unit/refund-domain.test.ts`](../tests/unit/refund-domain.test.ts). Point out that the duplicate-charge exception and refund-window decision run without a network, model, or eval harness.

## 3. Cross one real boundary

```bash
npm run test:integration
```

Show [`tests/integration/refund-tool-contract.test.ts`](../tests/integration/refund-tool-contract.test.ts). The production-style HTTP client is real. MSW controls the remote tools and the test checks the ordered identity, order, policy, refund, and confirmation requests.

## 4. Run the black-box eval

```bash
npm run eval:deterministic
npm run report:serve
```

Open `http://127.0.0.1:4173`. Show the release gate and the eligible, ineligible, and missing-information rows. Explain that this report began with versioned JSONL tasks and passed through the public CLI, full agent, graders, metrics, persistence, and browser.

Stop the report server before continuing.

## 5. Make reliability visible

```bash
npm run eval:repeat -- --trials 4 --k 2 --failure-every 2
npm run eval:review
```

The injected failure is deliberate and deterministic. Use it to explain why `pass@k` and `pass^k` answer different product questions, and then show `reports/latest/failures.md` plus `reports/latest/review-queue.jsonl`.

## 6. Optional judge calibration

```bash
npm run eval:judge
npm run eval:ci
```

The included fake judge demonstrates the calibration and gating mechanics without claiming semantic intelligence. For a live demo, use the optional OpenAI judge only with a reviewed golden set and an environment intended for external model calls.

## Closing frame

End on [`docs/EVAL-PYRAMID.md`](EVAL-PYRAMID.md): use Vitest for many exact checks, MSW for fewer controlled boundary scenarios, Playwright for a small black-box suite, and treat model judging plus human review as verdict mechanisms that can operate across those scopes.
