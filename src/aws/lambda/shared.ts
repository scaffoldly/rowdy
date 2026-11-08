import { createHash } from 'crypto';
import { defer, Observable, retry, tap, timer } from 'rxjs';
import type { Image } from '../../api/internal/transfer';

// DEVNOTE: Where the Dockerfile puts the binary in the layers appended to every deployed image.
// Absolute, so the entrypoint does not depend on the image's PATH.
export const ROWDY_BIN = '/usr/local/bin/rowdy';

// DEVNOTE: IAM role names and Lambda function names are limited to 64 characters. A longer value
// keeps its head and suffix, with a hash of the full value so distinct names stay distinct.
export const fit = (value: string, suffix = '', max = 64): string => {
  if (value.length + suffix.length <= max) return `${value}${suffix}`;
  const hash = createHash('sha256').update(value).digest('hex').slice(0, 8);
  return `${value.slice(0, max - suffix.length - hash.length - 1)}-${hash}${suffix}`;
};

type AwsError = { name?: string; message?: string; $fault?: string; $retryable?: unknown };

export const isNotFound = (error: unknown): boolean =>
  ['ResourceNotFoundException', 'NoSuchEntityException'].includes(`${(error as AwsError)?.name}`);

export const isTransient = (error: unknown): boolean => {
  const { name, $fault, $retryable } = (error as AwsError) ?? {};
  return !!$retryable || $fault === 'server' || ['ThrottlingException', 'TooManyRequestsException'].includes(`${name}`);
};

// DEVNOTE: IAM is eventually consistent. A role or policy created moments ago can be denied, or not
// yet assumable by Lambda, for a few seconds before it takes effect.
export const isPropagating = (error: unknown): boolean => {
  const { name, message } = (error as AwsError) ?? {};
  return (
    ['AccessDenied', 'AccessDeniedException'].includes(`${name}`) ||
    (name === 'InvalidParameterValueException' && /cannot be assumed/i.test(`${message}`))
  );
};

// DEVNOTE: Bounds retries of propagating errors: about a minute, then the error fails the deploy.
export const PROPAGATION = { retries: 8, minTimeout: 1_000, maxTimeout: 10_000 };

// DEVNOTE: Bounds retries of a function busy with another change. A new image stays Pending for minutes.
export const CONFLICT = { ...PROPAGATION, retries: 30 };

const backoff = (attempt: number): number =>
  Math.min(PROPAGATION.minTimeout * 2 ** (attempt - 1), PROPAGATION.maxTimeout);

// DEVNOTE: A missing resource is created, a propagating error re-reads after a backoff, and anything
// else (ValidationError, or a propagating error past PROPAGATION.retries) fails the deploy.
export const _create = <T>(
  read: () => Promise<T>,
  write: () => Promise<unknown>,
  cb?: (res: T) => void
): Observable<T> => {
  let attempt = 0;
  return defer(() => read())
    .pipe(
      retry({
        delay: (error) => {
          if (isNotFound(error)) return write();
          if (isPropagating(error) && ++attempt <= PROPAGATION.retries) return timer(backoff(attempt));
          throw error;
        },
      })
    )
    .pipe(tap((res) => cb?.(res)));
};

/** The execution role's name for an image, and for a name a sandbox or deploy gives it. */
export const roleName = (image: Image, name?: string): string =>
  name
    ? fit(`${image.namespace}+${image.name}@${name.replace(/[^a-zA-Z0-9._-]/g, '.')}`, '.rowdy.run')
    : fit(`${image.namespace}+${image.name}`, '@rowdy.run');
