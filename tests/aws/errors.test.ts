import {
  AccessDeniedException,
  GetMicrovmCommand,
  InternalServerException,
  LambdaMicrovmsClient,
  ThrottlingException,
} from '@aws-sdk/client-lambda-microvms';
import { describe, expect, it } from '@jest/globals';
import { Readable } from 'stream';
import { describeError, humanize } from '../../src/aws/errors';
import { SandboxError } from '../../src/sandbox/internal/compute';

/** The error a real client throws for a response, through its own deserializer. */
const responding = async (statusCode: number, errorType: string, message = 'nope'): Promise<unknown> => {
  const client = new LambdaMicrovmsClient({
    region: 'us-east-1',
    credentials: { accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'example' },
    maxAttempts: 1,
    requestHandler: {
      handle: async () => ({
        response: {
          statusCode,
          headers: { 'x-amzn-errortype': errorType, 'content-type': 'application/json' },
          body: Readable.from([Buffer.from(JSON.stringify({ message }))]),
        },
      }),
    },
  });
  return client.send(new GetMicrovmCommand({ microvmIdentifier: 'mvm-1' })).catch((error) => error);
};

const metadata = (httpStatusCode: number): { $metadata: { httpStatusCode: number } } => ({
  $metadata: { httpStatusCode },
});

describe('describeError', () => {
  describe('real responses', () => {
    it.each([
      [403, 'AccessDeniedException', 'ask'],
      [429, 'ThrottlingException', 'retry'],
      [500, 'InternalServerException', 'retry'],
      [503, 'ServiceUnavailableException', 'retry'],
      [404, 'ResourceNotFoundException', undefined],
      [400, 'ValidationException', undefined],
      [409, 'ConflictException', 'retry'],
    ])('a %i %s', async (status, type, remedy) => {
      expect(describeError(await responding(status, type)).remedy).toBe(remedy);
    });

    it('takes account IDs and ARNs out of a real message', async () => {
      const text = 'User: arn:aws:sts::123456789012:assumed-role/admin/me is not authorized in 123456789012';

      const { message } = describeError(await responding(403, 'AccessDeniedException', text));

      expect(message).toBe('User: [arn] is not authorized in [account]');
    });
  });

  it.each([
    ['AccessDeniedException', new AccessDeniedException({ message: 'no', ...metadata(403) }), 'ask'],
    ['ThrottlingException', new ThrottlingException({ message: 'no', ...metadata(429) }), 'retry'],
    ['InternalServerException', new InternalServerException({ message: 'no', ...metadata(500) }), 'retry'],
  ])('classifies the SDK class %s', (_name, error, remedy) => {
    expect(describeError(error).remedy).toBe(remedy);
  });

  it.each(['CredentialsProviderError', 'ExpiredTokenException', 'UnrecognizedClientException'])(
    'asks the person about %s',
    (name) => {
      expect(describeError(Object.assign(new Error('no'), { name })).remedy).toBe('ask');
    }
  );

  it.each(['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND'])('retries the network failure %s', (code) => {
    expect(describeError(Object.assign(new Error('no'), { code })).remedy).toBe('retry');
  });

  it('never retries what a sandbox can not do', () => {
    expect(describeError(new SandboxError('Not a sandbox: x')).remedy).toBe('none');
  });

  it('keeps a validation message, with no remedy', () => {
    expect(describeError(new RangeError('memory must be whole MB'))).toEqual({ message: 'memory must be whole MB' });
  });

  it('does not retry an abort', () => {
    const { remedy } = describeError(Object.assign(new Error('stopped'), { name: 'AbortError' }));

    expect(remedy).toBeUndefined();
  });

  it('copes with something that is not an Error', () => {
    expect(describeError('oops')).toEqual({ message: 'oops' });
  });
});

describe('humanize', () => {
  it('says a throttled call may work again', async () => {
    const error = humanize((await responding(429, 'ThrottlingException', 'Rate exceeded')) as Error);

    expect(error.message).toBe('Rate exceeded Retrying may help.');
    expect(error).toBeInstanceOf(ThrottlingException);
  });

  it('points at credentials for a denial', async () => {
    const error = humanize((await responding(403, 'AccessDeniedException', 'User is not authorized')) as Error);

    expect(error.message).toBe('User is not authorized Check the AWS credentials and permissions this runs with.');
  });

  it("leaves a message alone when there's nothing to do", () => {
    const error = humanize(new RangeError('memory must be whole MB'));

    expect(error).toBeInstanceOf(RangeError);
    expect(error.message).toBe('memory must be whole MB');
    expect(humanize(new SandboxError('Not a sandbox: x')).message).toBe('Not a sandbox: x');
  });

  it('says it once, however often it passes through', async () => {
    const error = (await responding(429, 'ThrottlingException', 'Rate exceeded')) as Error;

    expect(humanize(humanize(error)).message).toBe('Rate exceeded Retrying may help.');
  });

  it("keeps what a person was told out of a model's message", async () => {
    const error = humanize((await responding(429, 'ThrottlingException', 'Rate exceeded')) as Error);

    expect(describeError(error)).toEqual({ message: 'Rate exceeded', remedy: 'retry' });
  });

  it('passes on something that is not an Error', () => {
    expect(humanize('stop')).toBe('stop');
  });
});
