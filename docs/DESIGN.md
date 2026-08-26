# Design and limits

## Design choices

The starter uses one typed task contract across every layer. Deterministic graders run before optional model-judged rubrics, but both retain their evidence in the same trial record. Repeated trials are isolated by a fresh adapter and temporary workspace.

Reports are local artifacts in JSON, JSONL, Markdown, and self-contained HTML. This keeps the reference implementation inspectable and avoids coupling the harness to an eval vendor.

The optional OpenAI judge uses a strict structured response. It is an example adapter, not a recommendation that one provider or model is correct for every rubric.

## Why a trial can end without a score

A reliability number is a claim about the system under test. A trial that crashed in the adapter, tripped a grader bug, or lost the judge supports no such claim, so it is recorded with a status of its own and left out of every rate rather than counted as a failure. The alternative — treating harness breakage as model breakage — makes an outage look like a regression and quietly moves a release gate.

Excluding those trials creates the opposite risk: a run that measured almost nothing can still show a high pass rate. The gate therefore carries an explicit ceiling on the share of invalid trials, and the reports state the scored count next to the total.

Cleanup runs after the measurement is complete, so a failure there is recorded as a warning on the trial and changes no result.

Losing a trial is not always final. A trial that ended in an infrastructure outcome can be retried, because nothing about the system was learned the first time. A trial that produced a real result is never retried at any setting: rerunning failures until one passes is sampling to a conclusion, and it would quietly inflate every rate above it.

The loss is also not always total. When the judge fails, the deterministic layer has already run, so its result still counts toward the deterministic pass rate while the trial as a whole leaves `pass@k`. Each layer reports what it actually measured.

## Why the graders are tested before the model

Every task ships a `reference` answer, and two controls run against it: the oracle replays the reference and must pass every grader, while the nop control returns nothing and must be rejected by at least one. Between them they catch the two failure modes a passing score cannot distinguish from correctness — expectations that reject a correct answer, and expectations so loose that an empty answer satisfies them.

## What the harness measures itself

Trial duration is taken from the harness's own clock around the call into the system, and `maxLatencyMs` is graded against that. A system that under-reports its latency cannot pass a latency budget it missed.

Cost, tokens, and turns have no such independent source: the harness cannot see inside the adapter, so those remain self-reported and are labelled that way in the grade rationale. Reports quote total spend for the run and mean cost with median duration per task, since duration is skewed enough that a mean would mislead.

## Why reports carry provenance

Scores are compared across weeks. Each summary records digests of the task set and the run configuration alongside the Git revision, so a change in score can be attributed to the system rather than to an edited fixture or a loosened threshold. The summary also carries a schema version, because the reports are a format other tools read.

## Deliberate limits

- The default adapter is deterministic unless `failureEvery` injects a known failure. Replace it before using the results to characterize a real model.
- Trial time budgets are graded from reported latency. The harness does not forcibly terminate an adapter, so production adapters need their own request and tool timeouts.
- The finite `pass@k` and `pass^k` estimators describe samples without replacement. They do not establish causality, independence, or confidence bounds.
- Redaction is defense in depth, not a data-loss-prevention system. Use synthetic inputs and apply organization-specific controls before retaining reports.
- The fake judge demonstrates calibration mechanics with explicit text signals. It is not a semantic quality judge.
- Aggregate pass rates can hide high-severity failures. Add task-level and severity-specific gates for consequential applications.
- Latency is measured by the harness, but cost and turn budgets are graded from numbers the system reports about itself. Meter them outside the adapter before treating either as a control.
- The controls prove that a task's graders can separate a correct answer from an empty one. They cannot prove the reference answer is the behavior you want, and they cannot check a budget: both controls finish instantly and spend nothing, so a limit set far too high passes them.
- Retries hide transient infrastructure failures from the reliability numbers, which is the point, but a rising retry or invalid count is an operational signal worth watching rather than absorbing.

## Why there is no hidden trace grader

The harness records observable transcripts and tool calls, but it does not request private chain-of-thought. Graders should evaluate final outputs, state transitions, and auditable actions. This produces evidence users can retain, debug, and govern.
