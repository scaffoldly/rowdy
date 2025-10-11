import * as net from 'net';
import * as tls from 'tls';
import { log } from '../log';

export const DEFAULT_TIMEOUT = 5000;
export type CheckResult = `${number}ms` | 'timeout' | 'error' | 'unknown';

export const httpCheck = (origin: string, timeout = DEFAULT_TIMEOUT): Promise<CheckResult> => {
  // eslint-disable-next-line no-restricted-globals
  const url = new URL(origin);
  const now = performance.now();
  return new Promise((resolve) => {
    log.debug(`httpCheck`, { origin, url: url.toString() });
    const socket = net.connect({ host: url.host, port: Number(url.port || 80), timeout }, () => {
      socket.end();
      const duration = performance.now() - now;
      resolve(`${duration.toFixed(2)}ms` as CheckResult);
    });
    socket.on('error', (e) => {
      log.debug(`httpCheck error`, { error: e });
      resolve('error');
    });
    socket.on('timeout', () => {
      socket.destroy();
      resolve('timeout');
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
        host: url.host,
        servername: url.host,
        port: Number(url.port || 443),
        rejectUnauthorized: false,
        checkServerIdentity: () => undefined,
        timeout,
      },
      () => {
        socket.end();
        const duration = performance.now() - now;
        resolve(`${duration.toFixed(2)}ms` as CheckResult);
      }
    );
    socket.on('error', (e) => {
      log.debug(`httpsCheck error`, { error: e });
      resolve('error');
    });
    socket.on('timeout', () => {
      socket.destroy();
      resolve('timeout');
    });
  });
};
