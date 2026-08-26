export type JsonPrimitive = boolean | number | string | null;
export type JsonValue =
  JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface ToolExpectation {
  name: string;
  arguments?: { [key: string]: JsonValue };
}

export interface RubricCriterion {
  id: string;
  description: string;
  minimumScore: number;
  requiredSignals?: string[];
}

/**
 * A known-good answer authored alongside the task. Control runs replay it to
 * prove the task's own graders accept a correct result.
 */
export interface TaskReference {
  output: JsonValue;
  outcome?: JsonValue;
  toolCalls?: ToolCall[];
}

export interface EvalTask {
  id: string;
  description: string;
  input: {
    customerId: string;
    message: string;
  };
  expected: {
    outputSchema?: { [key: string]: JsonValue };
    outcome?: { [key: string]: JsonValue };
    requiredTools?: ToolExpectation[];
    forbiddenTools?: string[];
    maxTurns?: number;
    maxCostUsd?: number;
    maxLatencyMs?: number;
  };
  rubric?: RubricCriterion[];
  reference?: TaskReference;
}

export interface ToolCall {
  name: string;
  arguments: { [key: string]: JsonValue };
}

export interface TranscriptEvent {
  role: 'assistant' | 'system' | 'tool' | 'user';
  content: string;
  toolCall?: ToolCall;
}

export interface TrialMetrics {
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  turns: number;
}

export interface AgentRun {
  output: JsonValue;
  outcome: JsonValue;
  transcript: TranscriptEvent[];
  toolCalls: ToolCall[];
  metrics: TrialMetrics;
}

export interface TrialContext {
  runId: string;
  trialIndex: number;
  workspace: string;
}

export interface SystemUnderTest {
  run(task: EvalTask, context: TrialContext): Promise<AgentRun>;
  dispose?(): Promise<void>;
}

export interface SystemUnderTestFactory {
  create(): Promise<SystemUnderTest>;
}

/**
 * How a trial ended. Only `completed` says something about the system under
 * test; every other status reports a failure of the harness, the graders, or
 * the judge, and is excluded from reliability.
 */
export type TrialStatus =
  | 'completed'
  | 'grader_error'
  | 'harness_error'
  | 'judge_error'
  | 'system_error';

export interface TrialOutcome {
  status: TrialStatus;
  scored: boolean;
  detail: string | null;
}

export interface Grade {
  grader: string;
  score: number;
  passed: boolean;
  rationale: string;
}

export interface JudgeRequest {
  task: EvalTask;
  run: AgentRun;
  criterion: RubricCriterion;
}

export interface JudgeScore {
  score: number;
  confidence: number;
  rationale: string;
  unknown: boolean;
}

export interface JudgeProvider {
  readonly name: string;
  score(request: JudgeRequest): Promise<JudgeScore>;
}

export interface TrialRecord {
  taskId: string;
  trialIndex: number;
  run: AgentRun;
  grades: Grade[];
  outcome: TrialOutcome;
  /** Problems that happened outside the measurement, such as failed cleanup. */
  warnings: string[];
  error: string | null;
  deterministicPassed: boolean;
  judgePassed: boolean | null;
  passed: boolean;
}

export interface TaskReliability {
  taskId: string;
  successes: number;
  trials: number;
  scoredTrials: number;
  invalidTrials: number;
  passAt1: number | null;
  passAtK: number | null;
  passPowerK: number | null;
}

export interface ReleaseThresholds {
  deterministicPassRate: number;
  passAt1: number;
  passPowerK: number;
  judgeAverage: number;
  /** Share of trials allowed to end without a usable measurement. */
  maxInvalidRate: number;
}

export interface ReleaseCheck {
  name: string;
  actual: number | null;
  required: number;
  mode: 'maximum' | 'minimum';
  passed: boolean;
}

export interface ReleaseGate {
  passed: boolean;
  checks: ReleaseCheck[];
}

export interface GitProvenance {
  commit: string | null;
  dirty: boolean | null;
}

/**
 * What a report measured, so two runs can be compared without guessing whether
 * the fixtures, thresholds, or code moved underneath them.
 */
export interface Provenance {
  starterVersion: string;
  nodeVersion: string;
  git: GitProvenance;
  taskFile: string | null;
  taskSetDigest: string;
  taskDigests: Array<{ taskId: string; digest: string }>;
  configDigest: string;
  systemUnderTest: string;
  judge: string | null;
}

export interface EvalSummary {
  schemaVersion: number;
  runId: string;
  generatedAt: string;
  k: number;
  taskCount: number;
  trialCount: number;
  scoredTrialCount: number;
  invalidTrialCount: number;
  invalidRate: number;
  deterministicPassRate: number | null;
  judgeAverage: number | null;
  passAt1: number | null;
  passAtK: number | null;
  passPowerK: number | null;
  tasks: TaskReliability[];
  releaseGate: ReleaseGate;
  provenance: Provenance | null;
}

export interface EvalConfig {
  taskFile: string;
  reportDirectory: string;
  concurrency: number;
  thresholds: ReleaseThresholds;
}

export interface GoldenJudgeExample {
  id: string;
  criterion: RubricCriterion;
  output: string;
  humanScore: number;
}

export interface CalibrationSummary {
  provider: string;
  examples: number;
  meanAbsoluteError: number;
  agreementWithinTolerance: number;
  tolerance: number;
  passed: boolean;
}

export interface ControlCheck {
  taskId: string;
  control: 'nop' | 'oracle';
  expectation: string;
  passed: boolean;
  detail: string;
}

export interface ControlSummary {
  checks: ControlCheck[];
  passed: boolean;
}
