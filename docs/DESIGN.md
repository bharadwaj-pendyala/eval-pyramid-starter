# Design and limits

## Design choices

The starter uses one typed task contract across every layer. Deterministic graders run before optional model-judged rubrics, but both retain their evidence in the same trial record. Repeated trials are isolated by a fresh adapter and temporary workspace.

Reports are local artifacts in JSON, JSONL, Markdown, and self-contained HTML. This keeps the reference implementation inspectable and avoids coupling the harness to an eval vendor.

The optional OpenAI judge uses a strict structured response. It is an example adapter, not a recommendation that one provider or model is correct for every rubric.

## Deliberate limits

- The default adapter is deterministic unless `failureEvery` injects a known failure. Replace it before using the results to characterize a real model.
- Trial time budgets are graded from reported latency. The harness does not forcibly terminate an adapter, so production adapters need their own request and tool timeouts.
- The finite `pass@k` and `pass^k` estimators describe samples without replacement. They do not establish causality, independence, or confidence bounds.
- Redaction is defense in depth, not a data-loss-prevention system. Use synthetic inputs and apply organization-specific controls before retaining reports.
- The fake judge demonstrates calibration mechanics with explicit text signals. It is not a semantic quality judge.
- Aggregate pass rates can hide high-severity failures. Add task-level and severity-specific gates for consequential applications.

## Why there is no hidden trace grader

The harness records observable transcripts and tool calls, but it does not request private chain-of-thought. Graders should evaluate final outputs, state transitions, and auditable actions. This produces evidence users can retain, debug, and govern.
