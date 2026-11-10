import { HttpHeaders } from '../proxy/headers';
import { Logger } from '../log';
import { ECRClient, GetAuthorizationTokenCommand } from '@aws-sdk/client-ecr';
import type { AwsSandboxOptions } from '../sandbox';

export const headers = async (
  log: Logger,
  scheme: string,
  // eslint-disable-next-line @typescript-eslint/no-restricted-types
  realm: URL,
  service: string,
  credentials?: AwsSandboxOptions['credentials']
): Promise<HttpHeaders> => {
  if (service === 'ecr.amazonaws.com') {
    const region = realm.hostname.split('.')[3]!;
    const token = (await new ECRClient({ region, credentials }).send(new GetAuthorizationTokenCommand()))
      .authorizationData?.[0]?.authorizationToken;
    return HttpHeaders.from({
      Authorization: `${scheme} ${token}`,
    });
  }

  log.warn('Unsupported AWS Service', { service, for: 'authentication headers' });
  return HttpHeaders.from({});
};
