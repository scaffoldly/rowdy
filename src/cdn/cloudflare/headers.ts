import { CdnHeaders, HeaderMap } from '../headers';

/**
 * Cloudflare: the visitor's scheme is in `X-Forwarded-Proto` and `CF-Visitor`. Cloudflare sets no
 * header with the visitor's host; only a Transform Rule or Worker setting `X-Forwarded-Host` does.
 */
export class CloudflareHeaders extends CdnHeaders {
  /** The headers of a request that came through Cloudflare; undefined for any other. */
  static from(headers: HeaderMap): CloudflareHeaders | undefined {
    const cdn = new CloudflareHeaders(headers);
    return cdn.has('cf-ray') || cdn.has('cf-visitor') ? cdn : undefined;
  }

  get name(): string {
    return 'cloudflare';
  }

  // Cloudflare overwrites X-Forwarded-Proto with the visitor's scheme.
  override proto(): string | undefined {
    return super.proto() || this.visitorScheme()?.toLowerCase();
  }

  // CF-Connecting-IP is the address that connected to Cloudflare; X-Forwarded-For is only appended to.
  override viewer(): string | undefined {
    return this.get('cf-connecting-ip')?.trim() || super.viewer();
  }

  protected override get readsForwarded(): boolean {
    return false;
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
