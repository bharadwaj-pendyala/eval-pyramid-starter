import {
  HttpEvidenceObserver,
  HttpSystemUnderTest,
} from '../../adapters/http-system.js';
import type {
  SystemUnderTestFactory,
  TrialContext,
  TrialEnvironment,
} from '../../types.js';
import { RefundApplicationServer } from './application-server.js';
import { RefundAgent, type RefundRegression } from './refund-agent.js';
import { HttpRefundToolGateway } from './tool-gateway.js';
import { RefundToolService } from './tool-service.js';

export interface RefundAgentFactoryOptions {
  transientRefundFaultEvery?: number;
  regression?: RefundRegression;
}

export class RefundAgentFactory implements SystemUnderTestFactory {
  readonly name: string;
  readonly evidenceSource = 'refund-tool-service:persisted-state';
  readonly #faultEvery: number;
  readonly #regression: RefundRegression | undefined;

  constructor(options: RefundAgentFactoryOptions = {}) {
    this.#faultEvery = options.transientRefundFaultEvery ?? 0;
    this.#regression = options.regression;
    this.name = [
      'example-refund-application:http',
      ...(this.#faultEvery
        ? [`transient-refund-every-${this.#faultEvery}`]
        : []),
      ...(this.#regression ? [this.#regression] : []),
    ].join(':');
  }

  async create(context: TrialContext): Promise<TrialEnvironment> {
    const faulted =
      this.#faultEvery > 0 && (context.trialIndex + 1) % this.#faultEvery === 0;
    const tools = await RefundToolService.start({
      workspace: context.workspace,
      transientRefundFailures: faulted ? 1 : 0,
    });
    try {
      const agent = new RefundAgent(
        new HttpRefundToolGateway(tools.baseUrl),
        this.#regression ? { regression: this.#regression } : {}
      );
      const application = await RefundApplicationServer.start(
        agent,
        context.workspace
      );
      return {
        system: new HttpSystemUnderTest(`${application.baseUrl}/run`),
        observer: new HttpEvidenceObserver(`${tools.baseUrl}/evidence`),
        dispose: async () => {
          const results = await Promise.allSettled([
            application.close(),
            tools.close(),
          ]);
          const failures = results.filter(
            (result): result is PromiseRejectedResult =>
              result.status === 'rejected'
          );
          if (failures.length) {
            throw new Error(
              failures.map((failure) => String(failure.reason)).join('; ')
            );
          }
        },
      };
    } catch (error) {
      await tools.close();
      throw error;
    }
  }
}

export interface RemoteEnvironmentFactoryOptions {
  systemRunUrl: string;
  evidenceUrl: string;
  timeoutMs?: number;
}

export class RemoteEnvironmentFactory implements SystemUnderTestFactory {
  readonly name: string;
  readonly evidenceSource: string;
  readonly #systemRunUrl: string;
  readonly #evidenceUrl: string;
  readonly #timeoutMs: number | undefined;

  constructor(options: RemoteEnvironmentFactoryOptions) {
    this.#systemRunUrl = options.systemRunUrl;
    this.#evidenceUrl = options.evidenceUrl;
    this.#timeoutMs = options.timeoutMs;
    this.name = `remote-http:${new URL(options.systemRunUrl).host}`;
    this.evidenceSource = `remote-observer:${new URL(options.evidenceUrl).host}`;
  }

  create(): Promise<TrialEnvironment> {
    const options =
      this.#timeoutMs === undefined ? {} : { timeoutMs: this.#timeoutMs };
    return Promise.resolve({
      system: new HttpSystemUnderTest(this.#systemRunUrl, options),
      observer: new HttpEvidenceObserver(this.#evidenceUrl, options),
    });
  }
}
