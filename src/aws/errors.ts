import { isServerError, isThrottlingError, isTransientError } from '@smithy/core/retry';
import type { ToolFailure } from '../mcp/tool';
import { SandboxError } from '../sandbox/internal/compute';

// The ones that arrive without a 401 or 403.
const CREDENTIALS = [
  'CredentialsProviderError',
  'ExpiredToken',
  'ExpiredTokenException',
  'InvalidClientTokenId',
  'UnrecognizedClientException',
];

/** What a caller outside the account can read of an error from AWS, and what to do about it. */
export const describeError = (error: unknown): ToolFailure => {
  const failure = error instanceof Error ? error : new Error(`${error}`);
  // AWS's messages carry account IDs and role names.
  const message = failure.message.replace(/arn:aws[^\s"',]*/g, '[arn]').replace(/\b\d{12}\b/g, '[account]');
  const { $metadata } = failure as { $metadata?: { httpStatusCode?: number } };

  if (failure instanceof SandboxError) {
    return { message, remedy: 'none' };
  }
  if (CREDENTIALS.includes(failure.name) || [401, 403].includes($metadata?.httpStatusCode ?? 0)) {
    return { message, remedy: 'ask' };
  }
  if (isThrottlingError(failure) || isTransientError(failure) || isServerError(failure)) {
    return { message, remedy: 'retry' };
  }
  return { message };
};
