import { AxiosInstance, AxiosError, AxiosResponse, InternalAxiosRequestConfig } from 'axios';
import { parse } from 'auth-header';
import { Logger } from '../log';
import { HttpHeaders } from '../proxy/http';
import { headers as awsHeaders } from '../aws/headers';

const headers = async (scheme: string, service: string, scope?: string): Promise<HttpHeaders> => {
  if (service.endsWith('.amazonaws.com')) {
    return awsHeaders(scheme, service, scope);
  }
  return HttpHeaders.from({});
};

export function authenticate(
  axios: AxiosInstance,
  log: Logger
): [(response: AxiosResponse) => Promise<AxiosResponse>, (error: AxiosError) => Promise<AxiosResponse | never>] {
  let _cache: Record<string, { authorization: string; expires: Date }> = {};

  const onFulfilled = async (response: AxiosResponse): Promise<AxiosResponse> => {
    return response;
  };

  const onRejected = async (error: AxiosError): Promise<AxiosResponse | never> => {
    const response = error.response;
    if (!response) throw error;

    const originalRequest = response.config as InternalAxiosRequestConfig & { _retry?: boolean };
    if (originalRequest._retry) throw error;
    originalRequest._retry = true;

    const wwwAuth = response.headers['www-authenticate'];
    if (wwwAuth) {
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
        // TODO: Make sure this is necessary for AWS, as it doen's return realm with /token
        if (!url.pathname.endsWith('/token')) {
          url.pathname = `${url.pathname}/token`;
        }

        url.searchParams.append('service', service);
        if (scope) {
          url.searchParams.append('scope', scope);
        }

        const auth = await axios.get(url.toString(), {
          headers: (await headers(scheme, service, scope)).intoAxios(),
        });

        if (auth.status !== 200 || !auth.data?.token) {
          throw new AxiosError(`Failed to obtain token: ${auth.status} ${auth.statusText}`);
        }

        const authorization = `${scheme} ${auth.data.token}`;
        const expires = new Date(Date.now() + (auth.data.expires_in || 60) * 1000);

        log.debug(`Obtained ${scheme} token`, { realm, expires: expires.toISOString() });

        existing = _cache[key] = {
          authorization,
          expires,
        };
      }

      originalRequest.headers = originalRequest.headers ?? {};
      originalRequest.headers['Authorization'] = existing.authorization;
      return axios(originalRequest);
    }

    throw error;
  };

  return [onFulfilled, onRejected];
}
