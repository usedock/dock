import { TriangleAlert } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';

/** True when GitHub cannot reach the URL: loopback, private ranges, or single-label hosts. */
export function isPrivateUrl(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, '');
  } catch {
    return true;
  }
  if (host === 'localhost' || /\.(localhost|local|internal)$/.test(host) || (!host.includes('.') && !host.includes(':'))) {
    return true;
  }
  if (/^(127|10|0)\./.test(host) || /^192\.168\./.test(host) || /^169\.254\./.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
  return host === '::1' || /^f[cd][0-9a-f]{2}:/.test(host);
}

/** Warns that GitHub webhooks cannot reach this instance's API URL. */
export function PrivateUrlNotice({ apiUrl }: { apiUrl: string }) {
  return (
    <Alert>
      <TriangleAlert />
      <AlertTitle>GitHub cannot reach this instance</AlertTitle>
      <AlertDescription>
        <p>
          The API is at <span className="font-mono">{apiUrl}</span>, which is not on the public internet. GitHub rejects
          the App registration and can never deliver <span className="font-mono">@dock</span> mentions here.
        </p>
        <p>
          Put the instance behind a public HTTPS URL (a domain, or a tunnel such as{' '}
          <span className="font-mono">cloudflared tunnel --url {apiUrl}</span>), set{' '}
          <span className="font-mono">DOCK_PUBLIC_URL</span> to it (or <span className="font-mono">PUBLIC_API_URL</span>{' '}
          and <span className="font-mono">PUBLIC_APP_URL</span>), and redeploy.
        </p>
      </AlertDescription>
    </Alert>
  );
}
