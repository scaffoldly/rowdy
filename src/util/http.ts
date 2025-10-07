import * as net from 'net';
import * as tls from 'tls';

export const DEFAULT_TIMEOUT = 5000;
export type CheckResult = `${number}ms` | 'timeout' | 'error' | 'unknown';

export const httpCheck = (origin: string, timeout = DEFAULT_TIMEOUT): Promise<CheckResult> => {
  // eslint-disable-next-line no-restricted-globals
  const url = new URL(origin);
  const now = performance.now();
  return new Promise((resolve) => {
    const socket = net.connect({ host: url.host, port: Number(url.port || 80) }, () => {
      socket.end();
      const duration = performance.now() - now;
      resolve(`${duration.toFixed(2)}ms` as CheckResult);
    });
    socket.setTimeout(timeout);
    socket.on('error', () => resolve('error'));
    socket.on('timeout', () => {
      socket.destroy();
      resolve('error');
    });
  });
};

export const httpsCheck = (origin: string, timeout = DEFAULT_TIMEOUT): Promise<CheckResult> => {
  // eslint-disable-next-line no-restricted-globals
  const url = new URL(origin);
  const now = performance.now();
  return new Promise((resolve) => {
    const socket = tls.connect({ host: url.host, port: Number(url.port || 443), rejectUnauthorized: false }, () => {
      socket.end();
      const duration = performance.now() - now;
      resolve(`${duration.toFixed(2)}ms` as CheckResult);
    });
    socket.setTimeout(timeout);
    socket.on('error', () => resolve('error'));
    socket.on('timeout', () => {
      socket.destroy();
      resolve('error');
    });
  });
};
