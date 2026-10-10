import { request } from 'node:https';
import { isIP } from 'node:net';
import { DeniedAddressError, defaultResolveHost, isDeniedAddress, pinnedLookup, type HostResolver } from './ssrf-guard';

export interface WebhookDelivery {
  url: string;
  body: string;
  headers: Record<string, string>;
  timeoutMs: number;
}

export interface WebhookDeliveryResult {
  status: number;
}

/** Injectable HTTPS seam; fakes replace it in specs so no real outbound calls happen. */
export abstract class WebhookTransport {
  abstract post(delivery: WebhookDelivery): Promise<WebhookDeliveryResult>;
}

/** Production transport: node:https with a pinned lookup, so the vetted IP is the one dialed; redirects are never followed. */
export class PinnedHttpsWebhookTransport extends WebhookTransport {
  constructor(private readonly resolveHost: HostResolver = defaultResolveHost) {
    super();
  }

  post(delivery: WebhookDelivery): Promise<WebhookDeliveryResult> {
    return new Promise((resolve, reject) => {
      let url: URL;
      try {
        url = new URL(delivery.url);
      } catch (err) {
        reject(err);
        return;
      }
      if (url.protocol !== 'https:') {
        reject(new Error('Url must be an https URL'));
        return;
      }
      const host = url.hostname.replace(/^\[|\]$/g, '');
      // Literal IPs skip lookup entirely, so vet them before any socket is opened.
      if (isIP(host) && isDeniedAddress(host)) {
        reject(new DeniedAddressError());
        return;
      }
      const req = request(
        url,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(delivery.body),
            ...delivery.headers,
          },
          lookup: pinnedLookup(this.resolveHost) as never, // vets at dial time; SNI and Host stay the hostname
          agent: false, // fresh socket per delivery, never reused across hosts
          timeout: delivery.timeoutMs,
        },
        (res) => {
          res.resume();
          resolve({ status: res.statusCode ?? 0 });
        },
      );
      const timer = setTimeout(() => req.destroy(new Error('Webhook delivery timed out')), delivery.timeoutMs);
      req.on('timeout', () => req.destroy(new Error('Webhook delivery timed out')));
      req.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      req.on('close', () => clearTimeout(timer));
      req.end(delivery.body);
    });
  }
}
