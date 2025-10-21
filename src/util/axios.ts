import { AxiosInstance, AxiosError, AxiosResponse, InternalAxiosRequestConfig } from 'axios';
import { parse } from 'auth-header';
import { Logger } from '../log';
import { HttpHeaders } from '../proxy/http';
import { headers as awsHeaders } from '../aws/headers';

const headers = async (
  axios: AxiosInstance,
  log: Logger,
  scheme: string,
  // eslint-disable-next-line @typescript-eslint/no-restricted-types
  realm: URL,
  service: string
): Promise<HttpHeaders> => {
  // Dealing with AWS www-authenticate not being standard, apparently...
  if (service.endsWith('.amazonaws.com')) {
    return awsHeaders(log, scheme, realm, service);
  }

  log.debug(`Requesting ${scheme} token from ${realm.toString()}...`);
  const auth = await axios.get(realm.toString(), {
    _retrying: true,
  } as AxiosConfig);

  log.debug(`Received ${scheme} token response`, { status: auth.status, statusText: auth.statusText });

  if (auth.status !== 200 || !auth.data?.token) {
    throw new AxiosError(`Failed to obtain token: ${auth.status} ${auth.statusText}`);
  }

  const authorization = `${scheme} ${auth.data.token}`;
  // const expires = new Date(Date.now() + (auth.data.expires_in || 60) * 1000);

  return HttpHeaders.from({ Authorization: authorization });
};

type AxiosConfig = InternalAxiosRequestConfig & { _retrying?: boolean };

export function authenticate(
  axios: AxiosInstance,
  log: Logger
): [(response: AxiosResponse) => Promise<AxiosResponse>, (error: AxiosError) => Promise<AxiosResponse | never>] {
  let _cache: Record<string, { headers: HttpHeaders; expires: Date }> = {};

  const onFulfilled = async (response: AxiosResponse): Promise<AxiosResponse> => {
    return response;
  };

  const onRejected = async (error: AxiosError): Promise<AxiosResponse | never> => {
    const response = error.response;
    if (!response) throw error;

    const request = response.config as AxiosConfig;

    // Bail if we've already retried
    if (request._retrying) throw error;

    const wwwAuth = response.headers['www-authenticate'];
    if (!wwwAuth) {
      throw error;
    }

    // // Bail if we sent an authorization header and we're still getting a www-authenticate challenge
    // if (request.headers['authorization'] && wwwAuth) throw error;

    request._retrying = true;
    const { scheme, params } = parse(wwwAuth);
    const key = Buffer.from(JSON.stringify(params)).toString('base64');
    let existing = _cache[key];

    if (!existing || new Date() >= existing.expires) {
      delete _cache[key];
      const { realm, service, scope } = params;
      log.debug(`Handling ${scheme} authentication challenge...`, { realm, service, scope });

      if (!realm || Array.isArray(realm) || !service || Array.isArray(service) || (!!scope && Array.isArray(scope))) {
        throw new AxiosError('Invalid WWW-Authenticate header');
      }

      // eslint-disable-next-line no-restricted-globals
      const url = new URL(realm);

      url.searchParams.append('service', service);
      if (scope) {
        url.searchParams.append('scope', scope);
      }

      existing = _cache[key] = {
        headers: await headers(axios, log, scheme, url, service),
        expires: new Date(Date.now() + 5 * 60 * 1000), // Cache for 5 minutes
      };
    }

    request.headers = request.headers || {};
    Object.assign(request.headers, existing.headers.intoAxios());
    return axios(request);
  };

  return [onFulfilled, onRejected];
}
