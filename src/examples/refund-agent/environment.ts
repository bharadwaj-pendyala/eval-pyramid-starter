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
import { RefundAgent } from './refund-agent.js';
import { HttpRefundToolGateway } from './tool-gateway.js';
import { RefundToolService } from './tool-service.js';

export class RefundAgentFactory implements SystemUnderTestFactory {
  readonly name = 'example-refund-application:http';
  readonly evidenceSource = 'refund-tool-service:persisted-state';

  async create(context: TrialContext): Promise<TrialEnvironment> {
    const tools = await RefundToolService.start({
      workspace: context.workspace,
    });
    try {
      const agent = new RefundAgent(new HttpRefundToolGateway(tools.baseUrl));
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
