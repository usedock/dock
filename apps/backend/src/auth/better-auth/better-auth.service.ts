import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { betterAuth, type Auth, type BetterAuthOptions } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { toNodeHandler } from 'better-auth/node';
import { emailOTP } from 'better-auth/plugins';
import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { authCookieDomain, authTrustedOrigins, oauthProviders, publicApiUrl } from '../../config/instance';
import { DB, type Db } from '../../database/database.module';
import { MailService } from '../../mail/mail.service';
import { UsersService } from '../../users/users.service';
import type { RequestUser } from '../jwt-auth.guard';

/**
 * Better Auth hosted by the API itself (outside the /v1 prefix), over the
 * shared Postgres with the user model mapped onto the backend users table.
 * A create hook provisions profile + personal org so Better Auth signups
 * match native backend signups; ensureUserHasOrg backfills on repair.
 */
@Injectable()
export class BetterAuthService {
  readonly auth: Auth;
  /** Dashboard origins allowed to use backend-hosted auth with credentials. */
  readonly trustedOrigins: string[];
  private readonly logger = new Logger(BetterAuthService.name);
  private readonly nodeHandler: (req: Request, res: Response) => Promise<void>;

  constructor(
    @Inject(DB) db: Db,
    config: ConfigService,
    private readonly users: UsersService,
    private readonly mail: MailService,
  ) {
    const secret = config.getOrThrow<string>('BETTER_AUTH_SECRET');
    if (secret.length < 32) {
      throw new Error('BETTER_AUTH_SECRET must be at least 32 characters.');
    }
    this.trustedOrigins = authTrustedOrigins(config);
    const cookieDomain = authCookieDomain(config);
    const options: BetterAuthOptions = {
      baseURL: config.get<string>('BETTER_AUTH_URL') || publicApiUrl(config),
      secret,
      trustedOrigins: this.trustedOrigins,
      database: drizzleAdapter(db, { provider: 'pg' }),
      user: { modelName: 'users' },
      // Explicit links come from a signed-in user, so a GitHub account with another email may join (run attribution).
      account: { accountLinking: { allowDifferentEmails: true } },
      emailAndPassword: {
        enabled: true,
        minPasswordLength: 12,
        sendResetPassword: async ({ user, url }) => {
          void this.mail.send({
            to: user.email,
            subject: 'Reset your Dock password',
            template: 'reset-password',
            context: { email: user.email, resetUrl: url },
          });
        },
      },
      emailVerification: {
        // Without SMTP the mail service logs the link, so self-hosted admins can still verify.
        sendOnSignUp: true,
        sendVerificationEmail: async ({ user, url }) => {
          void this.mail.send({
            to: user.email,
            subject: 'Verify your Dock email',
            template: 'verify-email',
            context: { email: user.email, verifyUrl: url },
          });
        },
      },
      plugins: [
        emailOTP({
          otpLength: 6,
          expiresIn: 600,
          sendVerificationOTP: async ({ email, otp, type }) => {
            const subject =
              type === 'forget-password'
                ? 'Reset your Dock password'
                : type === 'email-verification'
                  ? 'Verify your Dock email'
                  : 'Your Dock sign-in code';
            void this.mail.send({
              to: email,
              subject,
              template: 'verify-code',
              context: { email, code: otp },
            });
          },
        }),
      ],
      socialProviders: Object.fromEntries(
        oauthProviders(config).map((provider) => {
          const key = `BETTER_AUTH_${provider.toUpperCase()}_CLIENT`;
          return [provider, { clientId: config.get<string>(`${key}_ID`), clientSecret: config.get<string>(`${key}_SECRET`) }];
        }),
      ),
      advanced: {
        database: { generateId: () => randomUUID() },
        // Caddy is the only client of this API; trust loopback + private
        // ranges so X-Forwarded-For resolves past the proxy hops.
        // Cloudflare-fronted traffic keys per edge IP, not per user.
        ipAddress: {
          trustedProxies: ['127.0.0.0/8', '::1/128', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'],
        },
        ...(config.get<string>('NODE_ENV') === 'production' && cookieDomain
          ? { crossSubDomainCookies: { enabled: true, domain: cookieDomain } }
          : {}),
      },
      databaseHooks: {
        user: {
          create: {
            after: async (user) => {
              try {
                await this.users.provisionBetterAuthUser({
                  id: user.id,
                  email: user.email,
                  emailVerified: user.emailVerified ?? false,
                });
              } catch (err) {
                this.logger.error(
                  `Provisioning failed for ${user.id}: ${(err as Error).message}`,
                );
                throw err;
              }
            },
          },
        },
      },
    };
    this.auth = betterAuth(options);
    this.nodeHandler = toNodeHandler(this.auth) as (
      req: Request,
      res: Response,
    ) => Promise<void>;
  }

  /** Better Auth cookie session hydrated to a RequestUser. Never throws. */
  async getSessionUser(cookieHeader: string | undefined): Promise<RequestUser | null> {
    if (!cookieHeader) return null;
    try {
      const session = await this.auth.api.getSession({
        headers: new Headers({ cookie: cookieHeader }),
      });
      if (!session?.user) return null;
      return {
        id: session.user.id,
        email: session.user.email,
        emailVerified: session.user.emailVerified ?? false,
        isInteractive: true,
      };
    } catch {
      return null;
    }
  }

  /** Raw Express handler; bypasses Nest guards, pipes, and the envelope. */
  handle(req: Request, res: Response, next: NextFunction): void {
    this.nodeHandler(req, res).catch(next);
  }
}
