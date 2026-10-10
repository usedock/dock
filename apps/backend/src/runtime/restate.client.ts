import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export class RestateException extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Minimal Restate ingress client: POST /{service}/{handler} with a JSON
 * body, the stable contract Restate serves for every registered service.
 * Workflow and Virtual Object definitions land with task 4.1; this client
 * only moves bytes so the provider seam is testable now.
 */
@Injectable()
export class RestateClient {
  private readonly baseUrl: string;

  constructor(config: ConfigService) {
    this.baseUrl = (config.get<string>('RESTATE_INGRESS_URL') ?? 'http://127.0.0.1:8080').replace(/\/$/, '');
  }

  /** Invokes one handler; key addresses a Virtual Object or Workflow id. */
  async call<T>(service: string, handler: string, body: unknown, key?: string): Promise<T> {
    const target = key ? `${this.baseUrl}/${service}/${key}/${handler}` : `${this.baseUrl}/${service}/${handler}`;
    const res = await fetch(target, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    });
    if (!res.ok) throw new RestateException(res.status, `Restate ${service}/${handler} failed with ${res.status}`);
    return (await res.json()) as T;
  }

  /** Restate serves its admin health at /health on the ingress port. */
  async health(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/health`);
      return res.ok;
    } catch {
      return false;
    }
  }
}
