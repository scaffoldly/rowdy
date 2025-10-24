import { AxiosInstance, AxiosError, AxiosResponse, InternalAxiosRequestConfig } from 'axios';
import { parse } from 'auth-header';
import { Logger } from '../log';
import { HttpHeaders } from '../proxy/http';
import { headers as awsHeaders } from '../aws/headers';

const AUTH_CACHE: Record<string, { headers: HttpHeaders; expires: Date }> = {};

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
type Authenticator = {
  request: [
    (config: InternalAxiosRequestConfig) => Promise<InternalAxiosRequestConfig>,
    (error: AxiosError) => Promise<InternalAxiosRequestConfig | never>,
  ];
  response: [
    (response: AxiosResponse) => Promise<AxiosResponse>,
    (error: AxiosError) => Promise<AxiosResponse | never>,
  ];
};

export function authenticator(axios: AxiosInstance, log: Logger): Authenticator {
  const key = (url?: string | undefined): string => {
    if (!url) return '';
    // eslint-disable-next-line no-restricted-globals
    return new URL(url).origin;
  };

  const preRequest = async (config: AxiosConfig): Promise<AxiosConfig> => {
    if (config.headers.Authorization) return config;
    if (config._retrying) return config;

    const existing = AUTH_CACHE[key(config.url)];
    if (!existing) return config;

    const expires = existing.expires;
    if (new Date() >= expires) {
      delete AUTH_CACHE[key(config.url)];
      return config;
    }

    config.headers = config.headers || {};
    Object.assign(config.headers, existing.headers.intoAxios());

    return config;
  };

  const preRequestError = async (error: AxiosError): Promise<InternalAxiosRequestConfig | never> => {
    throw error;
  };

  const responseSuccess = async (response: AxiosResponse): Promise<AxiosResponse> => {
    return response;
  };

  const responseError = async (error: AxiosError): Promise<AxiosResponse | never> => {
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
    let existing = AUTH_CACHE[key(request.url)];

    if (!existing || new Date() >= existing.expires) {
      delete AUTH_CACHE[key(request.url)];
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

      existing = AUTH_CACHE[key(request.url)] = {
        headers: await headers(axios, log, scheme, url, service),
        expires: new Date(Date.now() + 5 * 60 * 1000), // Cache for 5 minutes
      };
    }

    request.headers = request.headers || {};
    Object.assign(request.headers, existing.headers.intoAxios());
    return axios(request);
  };

  const auth: Authenticator = {
    request: [preRequest, preRequestError],
    response: [responseSuccess, responseError],
  };

  return auth;
}
