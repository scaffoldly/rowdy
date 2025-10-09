import { AxiosHeaders, AxiosResponseHeaders } from 'axios';
import { ILoggable, Logger } from '../log';
import { APIGatewayProxyEventV2 } from 'aws-lambda';
import { Readable } from 'stream';

export class HttpHeaders implements ILoggable {
  private headers: Record<string, string | string[]> = {};
  private constructor() {}

  proxy(): HttpHeaders {
    const instance = new HttpHeaders();
    instance.headers = { ...this.headers };

    delete instance.headers['set-cookie']; // cookies are handled separately

    if (this.headers['host']) {
      this.headers['x-forwarded-host'] = this.headers['host'];
      delete instance.headers['host'];
    }

    if (this.headers['connection']) {
      for (let key of this.headers['connection']
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

    // TODO: add x-forwarded-for
    // TODO: add via

    return instance;
  }

  static from(obj: Record<string, string | string[]>): HttpHeaders {
    const instance = new HttpHeaders();
    for (let [key, value] of Object.entries(obj || {})) {
      if (!value) continue;
      instance.headers[key.toLowerCase()] = value;
    }
    return instance;
  }

  static fromAxios(axiosHeaders: Partial<AxiosHeaders | AxiosResponseHeaders>): HttpHeaders {
    const instance = new HttpHeaders();
    for (let [key, value] of Object.entries(axiosHeaders.toJSON?.() || {})) {
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
    for (let [key, value] of Object.entries(headers || {})) {
      if (!value) continue;
      instance.headers[key.toLowerCase()] = String(value);
    }
    return instance;
  }

  intoAxios(): AxiosHeaders {
    const axiosHeaders = new AxiosHeaders();
    for (let [key, value] of Object.entries(this.headers)) {
      if (Array.isArray(value)) {
        for (let v of value) {
          axiosHeaders.append(key, v);
        }
      } else {
        axiosHeaders.set(key, value);
      }
    }
    return axiosHeaders;
  }

  intoJSON(): Record<string, unknown> {
    return this.intoAxios().toJSON();
  }

  override(key: string, value?: string | string[]): this {
    if (!value) {
      delete this.headers[key.toLowerCase()];
      return this;
    }
    key = key.toLowerCase();
    this.headers[key] = value;
    return this;
  }

  repr(): string {
    return `Headers(keys=${Object.keys(this.headers)})`;
  }
}

export class HttpResponse implements ILoggable {
  private _status: number;
  private _headers: HttpHeaders;
  private _cookies: string[];
  private _data: Readable;

  constructor(status: number, headers: HttpHeaders, cookies: string[], data: Readable) {
    this._status = status;
    this._headers = headers;
    this._cookies = cookies;
    this._data = data;
  }

  get status(): number {
    return this._status;
  }

  get headers(): HttpHeaders {
    return this._headers;
  }

  get cookies(): string[] {
    return this._cookies;
  }

  get data(): Readable {
    return this._data;
  }

  prelude(): { statusCode?: number; headers?: Record<string, unknown>; cookies?: string[] } {
    return {
      statusCode: this.status,
      headers: this.headers.intoJSON(),
      cookies: this.cookies,
    };
  }

  withStatus(code: number): this {
    this._status = code;
    return this;
  }

  withHeader(key: string, value?: string): this {
    this._headers.override(key, value);
    return this;
  }

  withData(data: Readable): this {
    // check if data is already being consumed, if it is, throw an error
    if (this.data.readableFlowing) {
      throw new Error('Cannot replace data stream that is already being consumed');
    }

    if (this.data.readableEnded) {
      throw new Error('Cannot replace data stream that has already ended');
    }

    this._data = data;
    return this;
  }

  repr(): string {
    return `HttpProxyResponse(status=${Logger.asPrimitive(this.status)}, headers=${Logger.asPrimitive(this.headers)}, cookies=${Logger.asPrimitive(this.cookies)} data=[stream])`;
  }
}
