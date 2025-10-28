import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['cjs'],
  target: 'esnext',
  sourcemap: 'inline',
  dts: true,
  cjsInterop: true,
  shims: true,
  esbuildOptions(options) {
    options.loader = {
      ...options.loader,
      '.html': 'text',
    };
  },
});
