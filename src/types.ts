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
  error: string | null;
  deterministicPassed: boolean;
  judgePassed: boolean | null;
  passed: boolean;
}

export interface TaskReliability {
  taskId: string;
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
}

export interface ReleaseGate {
  passed: boolean;
  checks: Array<{
    name: string;
    actual: number;
    required: number;
    passed: boolean;
  }>;
}

export interface EvalSummary {
  runId: string;
  generatedAt: string;
  k: number;
  taskCount: number;
  trialCount: number;
  deterministicPassRate: number;
  judgeAverage: number | null;
  passAt1: number;
  passAtK: number;
  passPowerK: number;
  tasks: TaskReliability[];
  releaseGate: ReleaseGate;
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
