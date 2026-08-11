# Contributing

Contributions should preserve the starter's main contract: a new user can run the complete default eval without credentials or external services.

## Before opening a pull request

```bash
npm ci
npm run verify
npm run eval:ci
npm run test:system
```

Use a conventional commit message such as `fix: reject invalid trial counts`. Keep changes focused and explain any change to metrics, release gates, fixtures, or privacy behavior in the pull request.

Place a test at the lowest layer that can prove its behavior. Component tests must avoid I/O, integration tests should cross one controlled boundary, and system tests should enter through a public interface. Promote only representative or high-risk cases upward.

## Fixture requirements

- Use synthetic or properly de-identified data.
- Give every task a stable, unique identifier.
- Prefer deterministic expected outcomes and tool policies before subjective rubrics.
- Add boundary cases and prohibited actions, not only happy paths.
- Do not weaken a threshold only to make a failing change pass.

## Judge changes

A judge adapter must return the typed `JudgeScore` contract and fail closed on invalid output. Add or update human-scored examples in `evals/judge-golden-set.jsonl`, document the tolerance, and demonstrate calibration in the pull request.

## Security reports

Follow [`SECURITY.md`](SECURITY.md). Do not include credentials, production transcripts, or personal data in issues, pull requests, fixtures, screenshots, or generated reports.
