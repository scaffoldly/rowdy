export const execa = jest.fn().mockResolvedValue({
  stdout: '',
  stderr: '',
  exitCode: 0,
  command: '',
  escapedCommand: '',
  failed: false,
  timedOut: false,
  isCanceled: false,
  killed: false,
});

export default execa;
