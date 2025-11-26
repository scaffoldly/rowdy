import axios, { AxiosInstance, AxiosError, AxiosResponse, InternalAxiosRequestConfig, AxiosHeaders } from 'axios';
import { parse } from 'auth-header';
import { Logger } from '../log';
import { HttpHeaders } from '../proxy/http';
import { headers as awsHeaders } from '../aws/headers';

const headers = async (
  log: Logger,
  scheme: string,
  // eslint-disable-next-line @typescript-eslint/no-restricted-types
  realm: URL,
  service: string,
  authorization?: string
): Promise<HttpHeaders> => {
  // Dealing with AWS www-authenticate not being standard, apparently...
  if (service.endsWith('.amazonaws.com')) {
    return awsHeaders(log, scheme, realm, service);
  }

  log.debug(`Requesting ${scheme} token from ${realm.toString()}`, { service, authorization: !!authorization });

  const auth = await axios.get(realm.toString(), {
    headers: authorization ? { Authorization: authorization } : undefined,
  });

  log.debug(`Received ${scheme} token response`, { status: auth.status, statusText: auth.statusText });

  if (auth.status !== 200 || !auth.data?.token) {
    throw new AxiosError(`Failed to obtain token: ${auth.status} ${auth.statusText}`);
  }

  return HttpHeaders.from({ Authorization: `${scheme} ${auth.data.token}` });
};

type AxiosConfig = InternalAxiosRequestConfig & { _isRetry?: boolean };
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
  const preRequest = async (config: AxiosConfig): Promise<AxiosConfig> => {
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
    const request = error.response?.config as AxiosConfig;

    log.debug(`Intercepting HTTP ${error.status}: ${error.message}`, {
      url: request?.url,
      method: request?.method,
      isRetry: request?._isRetry,
      requestHeaders: JSON.stringify(request?.headers),
      responseHeaders: JSON.stringify(response?.headers),
    });

    if (!response) throw error;

    const authorization = request.headers?.get('authorization') as string | undefined;

    // Bail if we've already retried
    if (request._isRetry) throw error;
    request._isRetry = true;

    const wwwAuth = response.headers['www-authenticate'];
    if (!wwwAuth) {
      throw error;
    }

    const { scheme, params } = parse(wwwAuth);

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

    const updated = await headers(log, scheme, url, service, authorization);

    request.headers = new AxiosHeaders(request.headers).concat(updated.intoAxios());
    return axios(request);
  };

  const auth: Authenticator = {
    request: [preRequest, preRequestError],
    response: [responseSuccess, responseError],
  };

  return auth;
}
