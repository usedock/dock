import * as Sentry from '@sentry/nestjs';
import {
  resolveSentryEnvironment,
  resolveTracesSampleRate,
  scrubSentryEvent,
  shouldEnableSentry,
} from './config/sentry-options';

// Plain require (not import) keeps package.json out of the tsc program, so the
// inferred output layout stays dist/main and the Docker CMD keeps working.
function readRelease(): string | undefined {
  try {
    const pkg = require('../package.json') as { version?: unknown };
    return typeof pkg.version === 'string' ? pkg.version : undefined;
  } catch {
    return undefined;
  }
}

// Pre-Nest init: ConfigService is unavailable here, so raw process.env only.
// Tolerant by design: reporting must never break boot or tests.
try {
  const release = readRelease();
  if (shouldEnableSentry(process.env)) {
    Sentry.init({
      dsn: process.env.SENTRY_DSN,
      environment: resolveSentryEnvironment(process.env),
      release,
      tracesSampleRate: resolveTracesSampleRate(process.env.SENTRY_TRACES_SAMPLE_RATE),
      debug: false,
      dataCollection: {
        userInfo: false,
        httpBodies: [],
        cookies: false,
        httpHeaders: { request: { deny: ['authorization', 'cookie', 'set-cookie'] }, response: false },
        urlQueryParams: false,
      },
      beforeSend: (event) => scrubSentryEvent(event),
    });
  }
} catch {
  // Fail-open: Sentry misconfig or outage never breaks the app.
}
