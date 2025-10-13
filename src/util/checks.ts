import * as net from 'net';
import * as tls from 'tls';
import { log } from '../log';

export const DEFAULT_TIMEOUT = 5000;

export type Status = 'ok' | 'error' | 'timeout' | 'unknown';
export type Latency = `${number}ms`;
export type CheckResult = { status: Status; latency?: Latency; reason?: string | undefined };

export const rowdyCheck = (origin: string, error?: string): Promise<CheckResult> => {
  log.debug(`cloudCheck`, { origin });
  return Promise.resolve({ status: error ? 'error' : 'ok', reason: error });
};

export const cloudCheck = (origin: string, timeout = DEFAULT_TIMEOUT): Promise<CheckResult> => {
  // TODO: Implement a cloud checks
  log.debug(`cloudCheck`, { origin, timeout });
  return Promise.resolve({ status: 'unknown', latency: '0.00ms', reason: 'cloudCheck() not implemented' });
};

export const httpCheck = (origin: string, timeout = DEFAULT_TIMEOUT): Promise<CheckResult> => {
  // eslint-disable-next-line no-restricted-globals
  const url = new URL(origin);
  const now = performance.now();
  return new Promise((resolve) => {
    log.debug(`httpCheck`, { origin, url: url.toString() });
    const socket = net.connect({ host: url.hostname, port: Number(url.port || 80), timeout }, () => {
      socket.end();
      const duration = performance.now() - now;
      resolve({ latency: `${duration.toFixed(2)}ms` as Latency, status: 'ok' });
    });
    socket.on('error', (e) => {
      log.debug(`httpCheck error`, { error: e });
      const duration = performance.now() - now;
      resolve({ latency: `${duration.toFixed(2)}ms` as Latency, status: 'error', reason: e.message });
    });
    socket.on('timeout', () => {
      socket.destroy();
      const duration = performance.now() - now;
      resolve({ status: 'timeout', reason: `timed out after ${duration.toFixed(2)}ms` });
    });
  });
};

export const httpsCheck = (origin: string, timeout = DEFAULT_TIMEOUT): Promise<CheckResult> => {
  // eslint-disable-next-line no-restricted-globals
  const url = new URL(origin);
  const now = performance.now();
  return new Promise((resolve) => {
    log.debug(`httpsCheck`, { origin, url: url.toString() });
    const socket = tls.connect(
      {
        host: url.hostname,
        servername: url.host,
        port: Number(url.port || 443),
        rejectUnauthorized: false,
        checkServerIdentity: () => undefined,
        timeout,
      },
      () => {
        socket.end();
        const duration = performance.now() - now;
        resolve({ latency: `${duration.toFixed(2)}ms` as Latency, status: 'ok' });
      }
    );
    socket.on('error', (e) => {
      log.debug(`httpsCheck error`, { error: e });
      const duration = performance.now() - now;
      resolve({ latency: `${duration.toFixed(2)}ms` as Latency, status: 'error', reason: e.message });
    });
    socket.on('timeout', () => {
      socket.destroy();
      const duration = performance.now() - now;
      resolve({ status: 'timeout', reason: `timed out after ${duration.toFixed(2)}ms` });
    });
  });
};
