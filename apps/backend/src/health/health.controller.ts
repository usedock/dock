import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { instanceSummary } from '../config/instance';
import { Public } from '../common/public.decorator';
import { HealthService } from './health.service';

@Public()
@Controller()
export class HealthController {
  constructor(
    private readonly health: HealthService,
    private readonly config: ConfigService,
  ) {}

  /** Liveness: never touches dependencies. */
  @Get('health')
  liveness(): { status: string } {
    return { status: 'ok' };
  }

  /** Public instance facts (billing, sign-in providers, URLs) for the dashboard; no secrets. */
  @Get('config')
  instance() {
    return instanceSummary(this.config);
  }

  /** Readiness: 503 `not_ready` while Postgres or Redis is unreachable. */
  @Get('ready')
  async readiness(): Promise<{ status: string; checks: Record<string, string> }> {
    const checks = await this.health.checks();
    if (checks.postgres !== 'up' || checks.redis !== 'up') {
      const detail = `postgres: ${checks.postgres}, redis: ${checks.redis}`;
      throw new ServiceUnavailableException({
        code: 'not_ready',
        message: `Dependencies not ready (${detail})`,
      });
    }
    return { status: 'ready', checks };
  }
}
