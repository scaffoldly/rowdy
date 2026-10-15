import { CdnHeaders, HeaderMap } from '../headers';

/** Cloudflare: the visitor's scheme is in `CF-Visitor: {"scheme":"https"}`. */
export class CloudflareHeaders extends CdnHeaders {
  /** The headers of a request that came through Cloudflare; undefined for any other. */
  static from(headers: HeaderMap): CloudflareHeaders | undefined {
    const cdn = new CloudflareHeaders(headers);
    return cdn.has('cf-ray') || cdn.has('cf-visitor') ? cdn : undefined;
  }

  get name(): string {
    return 'cloudflare';
  }

  // X-Forwarded-Proto can describe Cloudflare's own connection to the origin.
  override proto(): string | undefined {
    return this.visitorScheme()?.toLowerCase() || super.proto();
  }

  private visitorScheme(): string | undefined {
    const value = this.get('cf-visitor');
    if (!value) {
      return undefined;
    }
    try {
      const { scheme } = JSON.parse(value) as { scheme?: unknown };
      return typeof scheme === 'string' ? scheme : undefined;
    } catch {
      return undefined;
    }
  }
}
