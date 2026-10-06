import { LINUX_ERRNO, VfsError, errnoOf } from '../src/server';

describe('errno', () => {
  it('VfsError.code carries the Linux errno for the name', () => {
    expect(VfsError.code('ESTALE').errno).toBe(116);
    expect(VfsError.code('EAGAIN', 'held').message).toBe('held');
  });

  it('errnoOf prefers the portable code name over the host number', () => {
    expect(errnoOf(VfsError.code('EXDEV'))).toBe(LINUX_ERRNO.EXDEV);
    expect(errnoOf(Object.assign(new Error('x'), { code: 'ENOENT', errno: -2 }))).toBe(2);
    expect(errnoOf(Object.assign(new Error('x'), { code: 'ENOTEMPTY' }))).toBe(39);
    expect(errnoOf(new Error('plain'))).toBe(LINUX_ERRNO.EIO);
  });
});
