import { AxiosHeaders, AxiosResponseHeaders } from 'axios';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { ILoggable } from '../log';
import packageJson from '../../package.json';

export class HttpHeaders implements ILoggable {
  private headers: Record<string, string | string[]> = {};
  private constructor() {}

  get userAgent(): string {
    return (this.headers['user-agent'] as string) || `${packageJson.name}/${packageJson.version}`;
  }

  get(header: string): string | string[] | undefined {
    return this.headers[header.toLowerCase()];
  }

  proxy(): HttpHeaders {
    const instance = new HttpHeaders();
    instance.headers = { ...this.headers };

    delete instance.headers['set-cookie']; // cookies are handled separately

    if (this.headers['connection']) {
      for (const key of this.headers['connection']
        .toString()
        .toLowerCase()
        .split(',')
        .map((s) => s.trim())) {
        delete instance.headers[key];
      }
      delete instance.headers['connection'];
    }

    delete instance.headers['keep-alive'];
    delete instance.headers['proxy-authenticate'];
    delete instance.headers['proxy-authorization'];
    delete instance.headers['te'];
    delete instance.headers['trailer'];
    delete instance.headers['transfer-encoding'];
    delete instance.headers['upgrade'];

    // scrub keys that start with x-amz- or x-amzn-
    for (const key of Object.keys(instance.headers)) {
      if (key.startsWith('x-amz-') || key.startsWith('x-amzn-')) {
        delete instance.headers[key];
      }
    }

    // TODO: add x-forwarded-for
    // TODO: add via

    return instance;
  }

  static from(obj: Record<string, string | string[] | undefined | null>): HttpHeaders {
    const instance = new HttpHeaders();
    for (const [key, value] of Object.entries(obj || {})) {
      if (!value) continue;
      instance.headers[key.toLowerCase()] = value;
    }
    return instance;
  }

  static fromHeaders(headers: Headers): HttpHeaders {
    const instance = new HttpHeaders();
    for (const [key, value] of headers.entries()) {
      if (!value) continue;
      instance.headers[key.toLowerCase()] = value;
    }
    return instance;
  }

  static fromAxios(axiosHeaders: Partial<AxiosHeaders | AxiosResponseHeaders>): HttpHeaders {
    const instance = new HttpHeaders();
    for (const [key, value] of Object.entries(axiosHeaders.toJSON?.() || {})) {
      if (!value) continue;
      if (Array.isArray(value)) {
        instance.headers[key.toLowerCase()] = value;
      }
      instance.headers[key.toLowerCase()] = String(value);
    }
    return instance;
  }

  static fromLambda(headers: Partial<APIGatewayProxyEventV2['headers']>): HttpHeaders {
    const instance = new HttpHeaders();
    for (const [key, value] of Object.entries(headers || {})) {
      if (!value) continue;
      instance.headers[key.toLowerCase()] = String(value);
    }
    return instance;
  }

  intoAxios(): AxiosHeaders {
    const axiosHeaders = new AxiosHeaders();
    for (const [key, value] of Object.entries(this.headers)) {
      axiosHeaders.set(key, value);
    }
    return axiosHeaders;
  }

  intoJSON(): Record<string, unknown> {
    return this.intoAxios().toJSON();
  }

  intoHeaders(): Headers {
    const headers = new Headers();
    for (const [key, value] of Object.entries(this.headers)) {
      if (Array.isArray(value)) {
        for (const v of value) {
          headers.append(key, v);
        }
      } else {
        headers.set(key, value);
      }
    }
    return headers;
  }

  override(key: string, value?: string | string[] | number | boolean | undefined | null | AxiosHeaders): this {
    if (!value) {
      delete this.headers[key.toLowerCase()];
      return this;
    }
    key = key.toLowerCase();
    if (typeof value === 'number') {
      this.headers[key] = value.toString();
      return this;
    }
    if (typeof value === 'boolean') {
      this.headers[key] = value ? 'true' : 'false';
      return this;
    }
    if (value instanceof AxiosHeaders) {
      this.headers[key] = Array.isArray(value) ? value.map(String) : String(value);
      return this;
    }
    this.headers[key] = value;
    return this;
  }

  without(predicate: (key: string) => boolean): HttpHeaders {
    const instance = new HttpHeaders();
    instance.headers = Object.fromEntries(Object.entries(this.headers).filter(([key]) => !predicate(key)));
    return instance;
  }

  with(key: string, value: string | string[] | undefined | null): HttpHeaders {
    const instance = HttpHeaders.from(this.headers);
    instance.override(key, value);
    return instance;
  }

  repr(): string {
    return `Headers(keys=${Object.keys(this.headers)})`;
  }
}
