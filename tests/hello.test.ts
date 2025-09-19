import { hello } from '@src';

describe('hello', () => {
  it('should return "Hello, World!"', () => {
    expect(hello()).toBe('Hello, World!');
  });
});
