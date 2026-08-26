import type { TrialOutcome, TrialStatus } from '../types.js';

/**
 * Statuses that carry a verdict about the system under test. Everything else
 * measured nothing, so it must not move a reliability number.
 */
const SCORED_STATUSES = new Set<TrialStatus>(['completed']);

export function isScoredStatus(status: TrialStatus): boolean {
  return SCORED_STATUSES.has(status);
}

export function completed(): TrialOutcome {
  return { status: 'completed', scored: true, detail: null };
}

export function invalid(status: TrialStatus, detail: string): TrialOutcome {
  if (isScoredStatus(status)) {
    throw new Error(`${status} is a scored status, not an invalid one.`);
  }
  return { status, scored: false, detail };
}
