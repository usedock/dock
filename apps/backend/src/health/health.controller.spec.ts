import { HealthController } from './health.controller';

describe('HealthController', () => {
  it('serves the public instance summary from config', () => {
    const env: Record<string, string> = {
      BETTER_AUTH_GITHUB_CLIENT_ID: 'id',
      BETTER_AUTH_GITHUB_CLIENT_SECRET: 'secret',
      SMTP_HOST: 'smtp.example.com',
    };
    const controller = new HealthController({} as never, { get: (key: string) => env[key] } as never);
    expect(controller.instance()).toMatchObject({
      billingEnabled: false,
      authProviders: ['github'],
      mailDelivery: 'smtp',
      githubAppConfigured: false,
    });
    expect(JSON.stringify(controller.instance())).not.toContain('secret');
  });
});
