# Threat model

This template assumes eval inputs and model outputs are untrusted. The most important assets are credentials, customer data, production systems, and the integrity of release decisions.

## Main threats

- A fixture or transcript exposes private data through Git, CI logs, artifacts, or generated reports.
- An evaluated agent calls a destructive tool or reaches production resources.
- Prompt injection in a task or output manipulates a model judge.
- A malformed model response bypasses a grader.
- A system reports tool calls or business outcomes that did not occur.
- A stale or mismatched judge calibration is reused for a release.
- A compromised dependency or pull request gains access to repository secrets.
- Aggregate metrics conceal a rare but severe failure.

## Included controls

- The default path is offline and uses synthetic data.
- Generated reports and environment files are ignored by Git.
- JSON Schema validates task fixtures, and the model judge validates strict structured output.
- Trial workspaces, application servers, tool servers, and state files are isolated.
- Tool calls and business outcomes come from a separate persisted-state observer.
- Runtime validators reject malformed SUT, observer, tool, and judge responses.
- Missing judge scores, missing cost usage, critical failures, self-reported evidence, forbidden tools, and threshold misses fail closed.
- Live judge runs require a current passing calibration for the same model and golden-set hash.
- HTML output is escaped, common secrets are redacted, and the local report server sets a restrictive content security policy.
- GitHub workflows request read-only repository contents and do not use pull-request secrets.

## Controls you must add

Use disposable infrastructure, independently controlled evidence stores, least-privilege credentials, provider retention settings, application-specific redaction, network egress restrictions, and approval gates that match your system's impact. Verify observer authorization and bind evidence to the run and trial identifiers. Review failed and uncertain trials rather than relying on an aggregate score alone.
