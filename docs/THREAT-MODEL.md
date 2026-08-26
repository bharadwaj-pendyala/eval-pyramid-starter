# Threat model

This template assumes eval inputs and model outputs are untrusted. The most important assets are credentials, customer data, production systems, and the integrity of release decisions.

## Main threats

- A fixture or transcript exposes private data through Git, CI logs, artifacts, or generated reports.
- An evaluated agent calls a destructive tool or reaches production resources.
- Prompt injection in a task or output manipulates a model judge.
- A malformed model response bypasses a grader.
- A compromised dependency or pull request gains access to repository secrets.
- Aggregate metrics conceal a rare but severe failure.
- A grader accepts any output, so a broken system reports a passing score.
- Harness or provider failures are counted as model results, moving a release decision.
- A report is compared against an earlier one that measured different fixtures or thresholds.

## Included controls

- The default path is offline and uses synthetic data.
- Generated reports and environment files are ignored by Git.
- JSON Schema validates task fixtures, and the model judge validates strict structured output.
- Trial workspaces and system instances are isolated.
- Forbidden-tool, outcome, budget, and release-gate checks fail closed.
- Oracle and nop controls check that each task's graders accept a correct answer and reject an empty one.
- Trials that did not reach a verdict are excluded from every rate, and the release gate caps how many of them a run may contain.
- Reports carry digests of the task set and run configuration, the Git revision, and a schema version.
- HTML output is escaped, common secrets are redacted, and the local report server sets a restrictive content security policy.
- GitHub workflows request read-only repository contents and do not use pull-request secrets.

## Controls you must add

Use disposable infrastructure, least-privilege credentials, provider retention settings, application-specific redaction, network egress restrictions, per-operation timeouts, and approval gates that match your system's impact. Review failed and uncertain trials rather than relying on an aggregate score alone.

Two boundaries deserve attention before this template measures anything consequential. The system under test runs in the harness process, so an adapter you did not write is inside the trust boundary: run a real agent out of process, in a sandbox, with its own network and filesystem limits.

The harness measures trial duration on its own clock and grades the latency budget against it, but cost and turn budgets are graded from numbers the adapter reports about itself. An adapter that under-reports either can exceed its budget without the grade noticing, so meter spend at the provider or gateway before relying on a budget grade to stop a runaway run.

Retries apply only to trials that ended in an infrastructure outcome, never to one that produced a result, so they cannot be used to retry a failing trial into a passing one. A rising retry or invalid count is still worth alerting on: it means the measurement is degrading even when the score looks steady.
