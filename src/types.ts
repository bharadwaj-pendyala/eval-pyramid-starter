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

export type TaskSeverity = 'critical' | 'high' | 'medium' | 'low';

export interface EvalTask {
  id: string;
  description: string;
  severity: TaskSeverity;
  input: { [key: string]: JsonValue };
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

export interface SystemRunMetrics {
  turns: number;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  usageSource?: string;
}

export interface SystemRun {
  output: JsonValue;
  transcript: TranscriptEvent[];
  metrics: SystemRunMetrics;
}

export interface ObservedEvidence {
  outcome: JsonValue;
  toolCalls: ToolCall[];
  source: string;
}

export interface TrialMetrics {
  latencyMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  turns: number;
  latencySource: 'harness-wall-clock';
  usageSource: string | null;
}

export interface AgentRun {
  output: JsonValue;
  outcome: JsonValue;
  transcript: TranscriptEvent[];
  toolCalls: ToolCall[];
  evidenceSource: string;
  metrics: TrialMetrics;
}

export interface TrialContext {
  runId: string;
  trialIndex: number;
  workspace: string;
}

export interface SystemUnderTest {
  run(task: EvalTask, context: TrialContext): Promise<SystemRun>;
}

export interface EvidenceObserver {
  observe(task: EvalTask, context: TrialContext): Promise<ObservedEvidence>;
}

export interface TrialEnvironment {
  system: SystemUnderTest;
  observer: EvidenceObserver;
  dispose?(): Promise<void>;
}

export interface SystemUnderTestFactory {
  readonly name: string;
  readonly evidenceSource: string;
  create(context: TrialContext): Promise<TrialEnvironment>;
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
  severity: TaskSeverity;
  trialIndex: number;
  run: AgentRun;
  grades: Grade[];
  error: string | null;
  deterministicPassed: boolean;
  judgePassed: boolean | null;
  passed: boolean;
}

export interface TaskReliability {
  taskId: string;
  severity: TaskSeverity;
  successes: number;
  trials: number;
  passAt1: number;
  passAtK: number;
  passPowerK: number;
}

export interface ReleaseThresholds {
  deterministicPassRate: number;
  passAt1: number;
  passPowerK: number;
  judgeAverage: number;
  criticalPassRate: number;
  requireJudge: boolean;
  requireIndependentEvidence: boolean;
}

export interface ReleaseGate {
  passed: boolean;
  checks: Array<{
    name: string;
    actual: number | null;
    required: number;
    passed: boolean;
  }>;
}

export interface RunProvenance {
  systemUnderTest: string;
  evidenceObserver: string;
  judge: string | null;
  taskFile: string;
  taskSetSha256: string;
  sourceRevision: string | null;
  configuration: { [key: string]: JsonValue };
}

export interface EvalSummary {
  runId: string;
  generatedAt: string;
  k: number;
  taskCount: number;
  trialCount: number;
  deterministicPassRate: number;
  judgeAverage: number | null;
  independentEvidenceRate: number;
  criticalPassRate: number;
  passAt1: number;
  passAtK: number;
  passPowerK: number;
  tasks: TaskReliability[];
  releaseGate: ReleaseGate;
  provenance: RunProvenance;
}

export interface EvalConfig {
  taskFile: string;
  reportRoot: string;
  concurrency: number;
  thresholds: ReleaseThresholds;
  liveThresholds: ReleaseThresholds;
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
  goldenSetFile: string;
  goldenSetSha256: string;
  calibratedAt: string;
  passed: boolean;
}
