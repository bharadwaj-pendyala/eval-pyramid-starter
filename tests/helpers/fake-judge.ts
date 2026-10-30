import type {
  JudgeProvider,
  JudgeRequest,
  JudgeScore,
  JsonValue,
} from '../../src/types.js';

export class SignalMatcherTestDouble implements JudgeProvider {
  readonly name = 'test-only-signal-matcher';

  score(request: JudgeRequest): Promise<JudgeScore> {
    const signals = request.criterion.requiredSignals ?? [];
    if (signals.length === 0) {
      return Promise.resolve({
        score: 0,
        confidence: 0,
        rationale: 'The test double needs requiredSignals for this criterion.',
        unknown: true,
      });
    }

    const text = flattenText(request.run.output).toLocaleLowerCase();
    const matches = signals.filter((signal) =>
      text.includes(signal.toLocaleLowerCase())
    );
    const score = matches.length / signals.length;

    return Promise.resolve({
      score,
      confidence: 1,
      rationale: `Matched ${matches.length} of ${signals.length} configured signals.`,
      unknown: false,
    });
  }
}

function flattenText(value: JsonValue): string {
  if (typeof value === 'string') return value;
  if (value === null || typeof value === 'boolean' || typeof value === 'number')
    return String(value);
  if (Array.isArray(value)) return value.map(flattenText).join(' ');
  return Object.values(value).map(flattenText).join(' ');
}
