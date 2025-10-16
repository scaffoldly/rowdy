import { HttpHeaders } from '../proxy/http';
import { SignatureV4 } from '@aws-sdk/signature-v4';
import { Sha256 } from '@aws-crypto/sha256-js';
import { HttpRequest } from '@aws-sdk/protocol-http';
import { log } from '../log';

export const headers = async (realm: string, service: string, scope?: string): Promise<HttpHeaders> => {
  // eslint-disable-next-line no-restricted-globals
  const url = new URL(realm);
  const request = new HttpRequest({
    method: 'GET',
    protocol: url.protocol,
    hostname: url.hostname,
    path: url.pathname,
    query: {
      service,
      scope: scope || null,
    },
    headers: {
      host: url.host,
    },
  });

  const signer = new SignatureV4({
    service: service.split('.')[0]!,
    region: process.env.AWS_REGION || 'us-east-1',
    credentials: process.env.AWS_SESSION_TOKEN
      ? {
          accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
          secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
          sessionToken: process.env.AWS_SESSION_TOKEN!,
        }
      : {
          accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
          secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
        },
    sha256: Sha256,
  });

  const { headers } = await signer.sign(request);
  log.debug('Signed AWS request headers', JSON.stringify(headers, null, 2));

  return HttpHeaders.from(headers);
};
