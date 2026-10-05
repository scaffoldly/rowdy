import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['cjs'],
  // node22, not esnext: the binary loader would otherwise emit Uint8Array.fromBase64 (ES2025),
  // which Node 22 lacks.
  target: 'node22',
  sourcemap: 'inline',
  dts: true,
  cjsInterop: true,
  shims: true,
  esbuildOptions(options) {
    options.loader = {
      ...options.loader,
      // lib/linux-<arch>/vfspreload.so are inlined into dist/index.js as Uint8Array
      '.so': 'binary',
    };
  },
});
