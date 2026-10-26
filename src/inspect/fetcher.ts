import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { registrableDomain } from '../util/domain.js';

export interface FetchResult {
  requestedUrl: string;
  finalUrl: string;
  status: number;
  contentType: string;
  body: string;
  truncated: boolean;
}

export interface FetchOptions {
  method?: 'GET' | 'HEAD';
  /** Skip reading the body (link checks). */
  discardBody?: boolean;
  /** Accept header for API endpoints (Discourse answers a JSON URL requested as HTML with 403). */
  accept?: string;
}

export interface Fetcher {
  fetch(url: string, opts?: FetchOptions): Promise<FetchResult>;
}

export class FetchError extends Error {
  constructor(
    message: string,
    readonly code: 'blocked_address' | 'bad_scheme' | 'too_many_redirects' | 'timeout' | 'tls' | 'network',
  ) {
    super(message);
  }
}

// Private, loopback, link-local, CGNAT and other non-public ranges (spec 19: SSRF via redirects).
const blocked = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 3],
] as const) {
  blocked.addSubnet(net, prefix, 'ipv4');
}
for (const [net, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['fc00::', 7],
  ['fe80::', 10],
] as const) {
  blocked.addSubnet(net, prefix, 'ipv6');
}

export function isPublicAddress(address: string): boolean {
  // IPv4-mapped IPv6 (::ffff:a.b.c.d) is judged by its IPv4 part. Adding ::ffff:0:0/96 to the
  // BlockList instead would match every IPv4 address, since BlockList maps IPv4 into that range.
  const mapped = address.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mapped) return isPublicAddress(mapped[1]!);
  const family = isIP(address);
  if (family === 0) return false;
  return !blocked.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

async function assertPublicHost(hostname: string): Promise<void> {
  const host = hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
  if (addresses.length === 0 || !addresses.every((a) => isPublicAddress(a.address))) {
    throw new FetchError(`refusing non-public address for ${hostname}`, 'blocked_address');
  }
}

/** Serializes requests per registrable domain with a minimum gap (spec 6.2 per_domain_delay_ms). */
export class DomainThrottle {
  private readonly next = new Map<string, Promise<void>>();

  constructor(private readonly delayMs: number) {}

  async wait(url: string): Promise<void> {
    const key = registrableDomain(url) ?? new URL(url).hostname;
    const previous = this.next.get(key) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((resolve) => (release = resolve));
    this.next.set(
      key,
      previous.then(() => mine),
    );
    await previous;
    setTimeout(release, this.delayMs);
  }
}

function classifyError(err: unknown): FetchError {
  if (err instanceof FetchError) return err;
  const e = err as { name?: string; message?: string; cause?: { code?: string; message?: string } };
  if (e.name === 'TimeoutError' || e.name === 'AbortError') return new FetchError('request timed out', 'timeout');
  const code = e.cause?.code ?? '';
  if (/CERT|SSL|TLS|SELF_SIGNED|UNABLE_TO_VERIFY/i.test(code + (e.cause?.message ?? ''))) {
    return new FetchError(`TLS error: ${code || e.cause?.message}`, 'tls');
  }
  return new FetchError(`${e.message ?? 'fetch failed'}${code ? ` (${code})` : ''}`, 'network');
}

export interface HttpFetcherOptions {
  userAgent: string;
  timeoutMs: number;
  maxBytes: number;
  maxRedirects: number;
  throttle: DomainThrottle;
}

export class HttpFetcher implements Fetcher {
  constructor(private readonly opts: HttpFetcherOptions) {}

  async fetch(url: string, fetchOpts: FetchOptions = {}): Promise<FetchResult> {
    let current = url;
    for (let hop = 0; hop <= this.opts.maxRedirects; hop++) {
      const parsed = new URL(current);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new FetchError(`unsupported scheme ${parsed.protocol}`, 'bad_scheme');
      }
      await assertPublicHost(parsed.hostname);
      await this.opts.throttle.wait(current);

      let res: Response;
      try {
        res = await fetch(current, {
          method: fetchOpts.method ?? 'GET',
          redirect: 'manual',
          headers: {
            'user-agent': this.opts.userAgent,
            accept: fetchOpts.accept ?? 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.5',
            'accept-language': 'en-GB,en;q=0.8',
          },
          signal: AbortSignal.timeout(this.opts.timeoutMs),
        });
      } catch (err) {
        throw classifyError(err);
      }

      const location = res.headers.get('location');
      if (res.status >= 300 && res.status < 400 && location) {
        await res.body?.cancel();
        current = new URL(location, current).toString();
        continue;
      }

      const contentType = res.headers.get('content-type') ?? '';
      if (fetchOpts.discardBody || fetchOpts.method === 'HEAD' || !res.body) {
        await res.body?.cancel();
        return { requestedUrl: url, finalUrl: current, status: res.status, contentType, body: '', truncated: false };
      }
      const { text, truncated } = await readLimited(res, this.opts.maxBytes);
      return { requestedUrl: url, finalUrl: current, status: res.status, contentType, body: text, truncated };
    }
    throw new FetchError(`more than ${this.opts.maxRedirects} redirects`, 'too_many_redirects');
  }
}

async function readLimited(res: Response, maxBytes: number): Promise<{ text: string; truncated: boolean }> {
  const reader = res.body!.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        truncated = true;
        await reader.cancel();
        break;
      }
      chunks.push(value);
    }
  } catch (err) {
    throw classifyError(err);
  }
  return { text: Buffer.concat(chunks).toString('utf8'), truncated };
}
