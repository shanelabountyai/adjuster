import type { IncomingHttpHeaders } from 'node:http';

// eval:signoff is a local page with no sign-in: a signature there is the hand labeling (D91 e). So it must answer only
// this machine's browser, on its own origin. Three checks, each cheap:
// - Host must name the loopback at our port, which refuses a DNS-rebinding page that resolves its own name to 127.0.0.1.
// - A POST must not be cross-site: a page elsewhere could otherwise submit a form here and sign a label with its values.
//   Browsers send Sec-Fetch-Site and Origin on a cross-site form post; either one naming another site refuses it.
// - The server listens on 127.0.0.1 only (in signoff.ts), so nothing else on the network reaches it.

const loopback = (port: number) => new Set([`localhost:${port}`, `127.0.0.1:${port}`]);

/** Why this request is refused, or null when it is this machine's browser on this page's own origin. */
export function refusal(method: string | undefined, headers: IncomingHttpHeaders, port: number): string | null {
  const hosts = loopback(port);
  if (!headers.host || !hosts.has(headers.host.toLowerCase())) return 'host is not this machine';
  if (method !== 'POST') return null;
  const site = headers['sec-fetch-site'];
  if (site !== undefined && site !== 'same-origin' && site !== 'none') return 'cross-site post';
  const origin = headers.origin;
  if (origin !== undefined) {
    let host: string | null = null;
    try {
      const u = new URL(origin);
      host = u.protocol === 'http:' ? u.host.toLowerCase() : null;
    } catch {
      host = null;
    }
    if (!host || !hosts.has(host)) return 'cross-site post';
  }
  return null;
}
