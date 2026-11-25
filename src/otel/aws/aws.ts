import { isWrapped } from '@opentelemetry/instrumentation';
import {
  AwsInstrumentation as AwsSdkInstrumentation,
  type AwsSdkInstrumentationConfig,
} from '@opentelemetry/instrumentation-aws-sdk';

type SmithyClient = { Client: { prototype: { send: unknown } } };

// The AWS SDK's client as this package imports it: in rowdy's bundle, the one its clients run.
const smithy = require('@smithy/core/client') as SmithyClient;
const smithyVersion = (require('@smithy/core/package.json') as { version: string }).version;

/**
 * AwsInstrumentation that also patches the AWS SDK client this package imports: one inlined into a
 * bundle starts through the bundler's own loader, which no require hook sees. Relies on
 * AwsInstrumentation's protected patchV3SmithyClient, so its version is pinned.
 */
export class AwsInstrumentation extends AwsSdkInstrumentation {
  constructor(config: AwsSdkInstrumentationConfig = {}) {
    super(config);
  }

  override enable(): void {
    super.enable();
    // Not twice: _wrap wraps whatever is there, a wrapper included.
    if (!isWrapped(smithy.Client.prototype.send)) this.patchV3SmithyClient(smithy, smithyVersion);
  }

  override disable(): void {
    super.disable();
    if (isWrapped(smithy.Client.prototype.send)) this.unpatchV3SmithyClient(smithy);
  }
}
