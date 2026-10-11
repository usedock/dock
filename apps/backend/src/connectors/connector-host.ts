import { BadRequestException } from '@nestjs/common';
import { isIP } from 'node:net';
import { defaultResolveHost, isDeniedAddress, type HostResolver } from '../webhooks/ssrf-guard';

/** Sentry SaaS regions; any other host is treated as self-hosted. */
const SENTRY_SAAS = new Set(['sentry.io', 'de.sentry.io', 'us.sentry.io']);

function invalidHost(message: string): BadRequestException {
  return new BadRequestException({ code: 'connector_host_invalid', message });
}

/** Origin for a `host` value (`de.sentry.io`, `https://sentry.example.com`); null means the sentry.io default. */
export function normalizeSentryHost(input: string): string | null {
  const raw = input.trim();
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    throw invalidHost('host must be a hostname or an https URL');
  }
  if (url.protocol !== 'https:') throw invalidHost('host must use https');
  if (url.username || url.password) throw invalidHost('host must not carry credentials');
  if (url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) throw invalidHost('host must be an origin without a path');
  const hostname = url.hostname.toLowerCase();
  if (hostname === 'sentry.io') return url.port ? throwPort() : null;
  if (!hostname.includes('.') || hostname === 'localhost' || /\.(local|internal|localdomain)$/.test(hostname)) throw invalidHost('host must be a public hostname');
  return url.origin.toLowerCase();
}

function throwPort(): never {
  throw invalidHost('sentry.io does not take a port');
}

/** Self-hosted origins must resolve to public addresses; checked again at every connect, since DNS can change. */
export async function assertPublicSentryHost(origin: string | null, resolve: HostResolver = defaultResolveHost): Promise<void> {
  if (!origin) return;
  const hostname = new URL(origin).hostname;
  if (SENTRY_SAAS.has(hostname)) return;
  let addresses: string[];
  if (isIP(hostname.replace(/^\[|\]$/g, ''))) addresses = [hostname];
  else {
    try {
      addresses = await resolve(hostname);
    } catch {
      throw invalidHost('host does not resolve');
    }
  }
  if (!addresses.length || addresses.some(isDeniedAddress)) throw invalidHost('host must not point at a private or local network address');
}
