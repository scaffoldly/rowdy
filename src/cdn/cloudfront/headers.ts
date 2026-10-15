import { CdnHeaders, HeaderMap } from '../headers';

/** Amazon CloudFront: the visitor's scheme is in `CloudFront-Forwarded-Proto`. */
export class CloudFrontHeaders extends CdnHeaders {
  /** The headers of a request that came through CloudFront; undefined for any other. */
  static from(headers: HeaderMap): CloudFrontHeaders | undefined {
    const cdn = new CloudFrontHeaders(headers);
    return cdn.has('x-amz-cf-id') || cdn.has('cloudfront-forwarded-proto') ? cdn : undefined;
  }

  get name(): string {
    return 'cloudfront';
  }

  // X-Forwarded-Proto can describe CloudFront's own connection to the origin.
  override proto(): string | undefined {
    return this.first('cloudfront-forwarded-proto')?.toLowerCase() || super.proto();
  }
}
