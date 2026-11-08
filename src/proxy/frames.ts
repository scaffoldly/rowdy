// Docker's exec multiplexing: an 8-byte header of stream type, 3 zero bytes and big-endian payload size. Docker
// reports an exit out of band, so EXIT is rowdy's own type, past Docker's stdin 0, stdout 1, stderr 2, systemerr 3, and
// so is LOG, where the command's lines land, for a host that can't work that out.
export const EXEC_STREAM = { STDOUT: 1, STDERR: 2, EXIT: 4, LOG: 5 } as const;
export const EXEC_CONTENT_TYPE = 'application/vnd.rowdy.multiplexed-stream';

/**
 * A command's output in rowdy's own log, one JSON line per chunk, for a reader that wasn't attached. `chunk` keeps a
 * line under CloudWatch's size for an event once in base64. `limit` is per command, because the log is billed by the GB.
 */
export const EXEC_LOG = { key: 'rowdy.exec', chunk: 48 * 1024, limit: 16 * 1024 * 1024 };

export const execFrame = (stream: number, payload: Buffer): Buffer => {
  const header = Buffer.alloc(8);
  header.writeUInt8(stream, 0);
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
};
