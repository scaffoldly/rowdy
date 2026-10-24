import { CdnHeaders, HeaderMap } from '../headers';

/**
 * Amazon CloudFront: the visitor's scheme is in `CloudFront-Forwarded-Proto`. CloudFront sets no
 * header with the visitor's host; only an edge function setting `X-Forwarded-Host` supplies it.
 */
export class CloudFrontHeaders extends CdnHeaders {
  /** The headers of a request that came through CloudFront; undefined for any other. */
  static from(headers: HeaderMap): CloudFrontHeaders | undefined {
    const cdn = new CloudFrontHeaders(headers);
    return cdn.has('x-amz-cf-id') || cdn.has('cloudfront-forwarded-proto') ? cdn : undefined;
  }

  get name(): string {
    return 'cloudfront';
  }

  // CloudFront removes a viewer's X-Forwarded-Proto; CloudFront-Forwarded-Proto is its own, when a policy adds it.
  override proto(): string | undefined {
    return this.first('cloudfront-forwarded-proto')?.toLowerCase() || super.proto();
  }

  protected override get readsForwarded(): boolean {
    return false;
  }
}
