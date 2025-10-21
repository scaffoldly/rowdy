import { HttpHeaders } from '../proxy/http';
import { Logger } from '../log';
import { ECRClient, GetAuthorizationTokenCommand } from '@aws-sdk/client-ecr';

// eslint-disable-next-line @typescript-eslint/no-restricted-types
export const headers = async (log: Logger, scheme: string, realm: URL, service: string): Promise<HttpHeaders> => {
  if (service === 'ecr.amazonaws.com') {
    const region = realm.hostname.split('.')[3]!;
    const token = (await new ECRClient({ region }).send(new GetAuthorizationTokenCommand())).authorizationData?.[0]
      ?.authorizationToken;
    return HttpHeaders.from({
      Authorization: `${scheme} ${token}`,
    });
  }

  log.warn(`AWS service ${service} not implemented for authentication headers`);
  return HttpHeaders.from({});
};
